#!/usr/bin/env node
// Recover an already-signed unlisted XPI from AMO without uploading a duplicate
// version. This file is copied to RUNNER_TEMP before a manual run checks out its tag.
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://addons.mozilla.org/api/v5/addons/addon/';
const PUBLIC_FILE_WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 5000;

export function makeJwt(issuer, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: issuer, iat: nowSeconds, exp: nowSeconds + 300 })}`;
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8')).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

const ZIP_VERIFY = String.raw`
import json, pathlib, sys, zipfile
source = pathlib.Path(sys.argv[1])
xpi = pathlib.Path(sys.argv[2])
expected_version = sys.argv[3]
expected_id = sys.argv[4]
ignored = {'META-INF/cose.manifest', 'META-INF/cose.sig', 'META-INF/manifest.mf', 'META-INF/mozilla.rsa', 'META-INF/mozilla.sf'}
def fail(message):
    raise SystemExit(message)
source_files = {p.relative_to(source).as_posix(): p.read_bytes() for p in source.rglob('*') if p.is_file()}
def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail(f'manifest has duplicate JSON key: {key}')
        result[key] = value
    return result
def parse_manifest(raw, label):
    try:
        return json.loads(raw, object_pairs_hook=unique_pairs, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f'non-standard constant {value}')))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e:
        fail(f'{label} manifest is invalid JSON: {e}')
def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
def changed_details(a, b, prefix=''):
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in sorted(set(a) | set(b)):
            path = f'{prefix}.{key}' if prefix else key
            if key not in a: out.append((path, '<missing>', b[key]))
            elif key not in b: out.append((path, a[key], '<missing>'))
            elif type(a[key]) is not type(b[key]) or a[key] != b[key]: out.extend(changed_details(a[key], b[key], path))
        return out
    return [(prefix, a, b)]
try:
    with zipfile.ZipFile(xpi) as z:
        if 'META-INF/mozilla.rsa' not in z.namelist():
            fail('XPI is missing the Mozilla RSA signature')
        names = [n for n in z.namelist() if not n.endswith('/') and n not in ignored]
        if len(names) != len(set(names)):
            fail('XPI contains duplicate payload paths')
        if any(n.startswith('/') or '..' in pathlib.PurePosixPath(n).parts for n in names):
            fail('XPI contains an unsafe payload path')
        archive = {n: z.read(n) for n in names}
except (OSError, zipfile.BadZipFile) as e:
    fail(f'Cannot read recovered XPI: {e}')
if set(archive) != set(source_files):
    missing = sorted(set(source_files) - set(archive))
    extra = sorted(set(archive) - set(source_files))
    fail(f'XPI payload paths differ (missing={missing[:5]}, extra={extra[:5]})')
source_manifest = parse_manifest(source_files['manifest.json'], 'build')
manifest = parse_manifest(archive['manifest.json'], 'XPI')
changed = [name for name in source_files if name != 'manifest.json' and archive[name] != source_files[name]]
if changed:
    fail(f'XPI payload bytes differ: {changed[:5]}')
if canonical(manifest) != canonical(source_manifest):
    details = changed_details(source_manifest, manifest)
    shown = [f'{path}: {canonical(old)[:120]} -> {canonical(new)[:120]}' for path, old, new in details[:8]]
    fail(f'manifest values differ at: {"; ".join(shown)}')
gecko = (manifest.get('browser_specific_settings') or {}).get('gecko') or (manifest.get('applications') or {}).get('gecko') or {}
source_gecko = (source_manifest.get('browser_specific_settings') or {}).get('gecko') or (source_manifest.get('applications') or {}).get('gecko') or {}
if str(manifest.get('version')) != expected_version:
    fail(f'XPI manifest version {manifest.get("version")!r} does not match {expected_version}')
if str(source_manifest.get('version')) != expected_version:
    fail(f'Build manifest version {source_manifest.get("version")!r} does not match {expected_version}')
if gecko.get('id') != expected_id:
    fail(f'XPI Gecko id {gecko.get("id")!r} does not match expected add-on id')
if source_gecko.get('id') != expected_id:
    fail(f'Build Gecko id {source_gecko.get("id")!r} does not match expected add-on id')
`;

export function verifyXpi({ sourceDir, xpiPath, version, addonId }) {
  try {
    execFileSync('python3', ['-c', ZIP_VERIFY, sourceDir, xpiPath, version, addonId], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const diagnostic = error.stderr?.toString().trim();
    throw new Error(diagnostic || `XPI payload verification failed (python exit ${error.status ?? 'unknown'}).`);
  }
}

async function apiVersion({ version, addonId, issuer, secret, fetchImpl = fetch, waitMs = PUBLIC_FILE_WAIT_MS, pollMs = POLL_MS }) {
  const url = `${API}${encodeURIComponent(addonId)}/versions/${encodeURIComponent(version)}/`;
  const started = Date.now();
  let detail;
  while (true) {
    const token = makeJwt(issuer, secret);
    let response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: `JWT ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      if (Date.now() - started >= waitMs) throw new Error('AMO version lookup failed repeatedly before a signed file became public.');
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (response.status === 404) return null;
    if (response.status === 429 || response.status >= 500) {
      if (Date.now() - started >= waitMs) throw new Error(`AMO version lookup kept failing (HTTP ${response.status}).`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, waitMs) : pollMs));
      continue;
    }
    if (!response.ok) throw new Error(`AMO version lookup failed (HTTP ${response.status}).`);
    detail = await response.json();
    if (String(detail.version) !== version) throw new Error('AMO returned a different version than requested.');
    const file = [detail.file, ...(detail.files || [])].find((candidate) => candidate && candidate.status === 'public' && typeof candidate.url === 'string');
    if (file) return file.url;
    if (Date.now() - started >= waitMs) throw new Error('The AMO version exists but its signed file did not become public before the wait timed out.');
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function recoverSignedXpi({ version, addonId, sourceDir, outputPath, issuer, secret, fetchImpl = fetch, waitMs, pollMs }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Version must be stable semver (for example 0.9.18).');
  if (!issuer || !secret) throw new Error('AMO API credentials are required.');
  const downloadUrl = await apiVersion({ version, addonId, issuer, secret, fetchImpl, waitMs, pollMs });
  if (!downloadUrl) return false;
  const parsedUrl = new URL(downloadUrl);
  const allowedDownloadHosts = new Set(['addons.mozilla.org', 'addons.cdn.mozilla.net']);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'addons.mozilla.org') {
    throw new Error('AMO returned an unexpected signed-file URL host.');
  }
  const authenticatedOrigin = parsedUrl.origin;
  let currentUrl = parsedUrl;
  let response;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const headers = { Accept: 'application/x-xpinstall, application/zip' };
    // AMO requires a JWT for signed-file downloads. Never send it to a redirect
    // on another origin; the allowed CDN serves the redirected file anonymously.
    if (currentUrl.origin === authenticatedOrigin) headers.Authorization = `JWT ${makeJwt(issuer, secret)}`;
    response = await fetchImpl(currentUrl, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('AMO signed-file redirect had no Location header.');
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== 'https:' || !allowedDownloadHosts.has(nextUrl.hostname)) {
        throw new Error('AMO signed-file redirect used an unexpected host.');
      }
      currentUrl = nextUrl;
      continue;
    }
    break;
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('AMO signed-file redirect limit exceeded.');
  if (!response.ok) throw new Error(`AMO signed-file download failed (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('AMO returned an empty signed XPI.');
  await writeFile(outputPath, bytes, { mode: 0o600 });
  verifyXpi({ sourceDir, xpiPath: outputPath, version, addonId });
  return true;
}

async function main(argv) {
  const args = Object.fromEntries(argv.slice(2).map((item, index, all) => item.startsWith('--') ? [item.slice(2), all[index + 1]] : null).filter(Boolean));
  if (args.help) {
    console.log('amo-recover.mjs --version VERSION --addon-id ID --source-dir DIR --output FILE');
    return;
  }
  const recovered = await recoverSignedXpi({
    version: args.version,
    addonId: args['addon-id'],
    sourceDir: args['source-dir'],
    outputPath: args.output,
    issuer: process.env.AMO_JWT_ISSUER,
    secret: process.env.AMO_JWT_SECRET,
  });
  if (!recovered) {
    console.log('AMO has no version with that number; normal web-ext signing can proceed.');
    process.exitCode = 2;
    return;
  }
  console.log('Recovered and verified the existing public AMO signature against this build.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((error) => {
    console.error(error.message || 'AMO recovery failed.');
    process.exitCode = 1;
  });
}
