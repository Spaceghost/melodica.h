import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeJwt, recoverSignedXpi, verifyXpi } from '../scripts/amo-recover.mjs';

const VERSION = '0.9.18';
const ADDON_ID = 'melodica-extension@spacegho.st';
const zip = (source, output, signed = true) => execFileSync('python3', ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1]); out=sys.argv[2]
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
  for p in root.rglob('*'):
    if p.is_file(): z.write(p,p.relative_to(root).as_posix())
  if sys.argv[3] == '1':
    z.writestr('META-INF/mozilla.rsa',b'signature')
    z.writestr('META-INF/mozilla.sf',b'signature')
    z.writestr('META-INF/manifest.mf',b'signature')
    z.writestr('META-INF/cose.manifest',b'signature')
    z.writestr('META-INF/cose.sig',b'signature')`, source, output, signed ? '1' : '0']);

test('AMO JWT is HS256 with issuer and short expiry, without exposing the secret', () => {
  const secret = 'unit-test-secret';
  const token = makeJwt('api-key', secret, 1_700_000_000);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: 'api-key', iat: 1_700_000_000, exp: 1_700_000_300 });
  assert.equal(signature, createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'));
  assert.equal(token.includes(secret), false);
});

test('recovery validates signed ZIP payload bytes and downloads only the public AMO file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'amo-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'firefox'), xpi = join(root, 'signed.xpi'), output = join(root, 'recovered.xpi');
  await mkdir(source);
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: VERSION, browser_specific_settings: { gecko: { id: ADDON_ID } } }));
  await writeFile(join(source, 'background.js'), 'browser.runtime.sendMessage({type:"test"});');
  zip(source, xpi);
  const packageBytes = await readFile(xpi);
  let apiCalls = 0, downloadCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('/api/v5/')) {
      apiCalls++;
      assert.match(init.headers.Authorization, /^JWT [A-Za-z0-9_.-]+$/);
      return new Response(JSON.stringify({ version: VERSION, file: { status: 'public', url: 'https://addons.mozilla.org/files/signature.xpi' } }), { headers: { 'content-type': 'application/json' } });
    }
    downloadCalls++;
    assert.equal(init.redirect, 'manual');
    if (downloadCalls === 1) {
      assert.match(init.headers.Authorization, /^JWT [A-Za-z0-9_.-]+$/, 'AMO requires JWT authorization on the signed-file endpoint');
      return new Response(null, { status: 302, headers: { location: 'https://addons.cdn.mozilla.net/files/signature.xpi' } });
    }
    assert.equal(new URL(String(url)).hostname, 'addons.cdn.mozilla.net');
    assert.equal(init.headers.Authorization, undefined, 'JWT is not forwarded across origins to the file CDN');
    return new Response(packageBytes);
  };
  assert.equal(await recoverSignedXpi({ version: VERSION, addonId: ADDON_ID, sourceDir: source, outputPath: output, issuer: 'api-key', secret: 'secret', fetchImpl }), true);
  assert.equal(apiCalls, 1);
  assert.equal(downloadCalls, 2);
  assert.deepEqual(await readFile(output), packageBytes);
  assert.doesNotThrow(() => verifyXpi({ sourceDir: source, xpiPath: output, version: VERSION, addonId: ADDON_ID }));
});

test('manifest formatting and key order normalize; semantic changes and duplicate keys fail', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'amo-recover-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'firefox'), signed = join(root, 'signed-build'), xpi = join(root, 'signed.xpi');
  await mkdir(source); await mkdir(signed);
  const manifest = {
    manifest_version: 3,
    version: VERSION,
    version_name: '0.9.18 rooms',
    name: 'Melodica',
    permissions: ['storage'],
    background: { scripts: ['background.js'] },
    browser_specific_settings: { gecko: { id: ADDON_ID } },
  };
  const manifestText = JSON.stringify(manifest);
  await writeFile(join(source, 'manifest.json'), manifestText);
  await writeFile(join(source, 'background.js'), 'trusted bytes');
  // Serialization may change whitespace and object key order without changing values.
  const reordered = {
    browser_specific_settings: manifest.browser_specific_settings,
    background: manifest.background,
    permissions: manifest.permissions,
    name: manifest.name,
    version_name: manifest.version_name,
    version: manifest.version,
    manifest_version: manifest.manifest_version,
  };
  await writeFile(join(signed, 'manifest.json'), JSON.stringify(reordered, null, 2));
  await writeFile(join(signed, 'background.js'), 'trusted bytes');
  zip(signed, xpi);
  assert.doesNotThrow(() => verifyXpi({ sourceDir: source, xpiPath: xpi, version: VERSION, addonId: ADDON_ID }));

  for (const [key, alter, diagnostic] of [
    ['permissions', (m) => { m.permissions.push('tabs'); }, 'permissions'],
    ['version', (m) => { m.version = '0.9.19'; }, 'version'],
    ['gecko id', (m) => { m.browser_specific_settings.gecko.id = 'other@example.org'; }, 'browser_specific_settings.gecko.id'],
    ['manifest key', (m) => { m.version_name = 'changed label'; }, 'version_name'],
  ]) {
    const changedDir = join(root, `changed-${key.replaceAll(' ', '-')}`); await mkdir(changedDir);
    const changed = structuredClone(manifest); alter(changed);
    await writeFile(join(changedDir, 'manifest.json'), JSON.stringify(changed));
    await writeFile(join(changedDir, 'background.js'), 'trusted bytes');
    const changedXpi = join(root, `changed-${key.replaceAll(' ', '-')}.xpi`); zip(changedDir, changedXpi);
    assert.throws(() => verifyXpi({ sourceDir: source, xpiPath: changedXpi, version: VERSION, addonId: ADDON_ID }), new RegExp(diagnostic));
  }

  const duplicateDir = join(root, 'duplicate'); await mkdir(duplicateDir);
  await writeFile(join(duplicateDir, 'manifest.json'), manifestText.replace('"version":"0.9.18"', '"version":"0.9.18","version":"0.9.18"'));
  await writeFile(join(duplicateDir, 'background.js'), 'trusted bytes');
  const duplicateXpi = join(root, 'duplicate.xpi'); zip(duplicateDir, duplicateXpi);
  assert.throws(() => verifyXpi({ sourceDir: source, xpiPath: duplicateXpi, version: VERSION, addonId: ADDON_ID }), /duplicate JSON key: version/);
});

test('signed-file downloads reject external redirects without forwarding the AMO JWT', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'amo-recover-redirect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'firefox'), output = join(root, 'signed.xpi');
  await mkdir(source);
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: VERSION, browser_specific_settings: { gecko: { id: ADDON_ID } } }));
  const requested = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('/api/v5/')) return new Response(JSON.stringify({ version: VERSION, file: { status: 'public', url: 'https://addons.mozilla.org/files/signature.xpi' } }));
    requested.push({ host: new URL(String(url)).hostname, authorization: init.headers.Authorization });
    if (requested.length === 1) return new Response(null, { status: 302, headers: { location: 'https://attacker.example/signed.xpi' } });
    throw new Error('external host must never be requested');
  };
  await assert.rejects(recoverSignedXpi({ version: VERSION, addonId: ADDON_ID, sourceDir: source, outputPath: output, issuer: 'api-key', secret: 'secret', fetchImpl }), /unexpected host/);
  assert.deepEqual(requested.map(({ host }) => host), ['addons.mozilla.org']);
  assert.match(requested[0].authorization, /^JWT /);
});

test('singular AMO file lookup waits for public status and refreshes JWTs while polling', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'amo-recover-poll-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'firefox'), xpi = join(root, 'signed.xpi'), output = join(root, 'recovered.xpi');
  await mkdir(source);
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: VERSION, browser_specific_settings: { gecko: { id: ADDON_ID } } }));
  await writeFile(join(source, 'background.js'), 'trusted bytes');
  zip(source, xpi);
  const packageBytes = await readFile(xpi), authTokens = [];
  const originalNow = Date.now;
  let fakeNow = 1_700_000_000_000, lookups = 0;
  Date.now = () => fakeNow;
  try {
    const fetchImpl = async (url, init = {}) => {
      if (String(url).includes('/api/v5/')) {
        lookups++;
        authTokens.push(init.headers.Authorization);
        if (lookups === 1) {
          fakeNow += 301_000; // More than the JWT's five-minute lifetime.
          return new Response(JSON.stringify({ version: VERSION, file: { status: 'pending', url: null } }));
        }
        return new Response(JSON.stringify({ version: VERSION, file: { status: 'public', url: 'https://addons.mozilla.org/files/signature.xpi' } }));
      }
      return new Response(packageBytes);
    };
    assert.equal(await recoverSignedXpi({ version: VERSION, addonId: ADDON_ID, sourceDir: source, outputPath: output, issuer: 'api-key', secret: 'secret', fetchImpl, waitMs: 600_000, pollMs: 0 }), true);
  } finally { Date.now = originalNow; }
  assert.equal(lookups, 2);
  assert.notEqual(authTokens[0], authTokens[1], 'each status poll receives a newly signed JWT');
});

test('missing AMO version returns a fallback result; changed payload is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'amo-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'firefox'), output = join(root, 'signed.xpi');
  await mkdir(source);
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: VERSION, browser_specific_settings: { gecko: { id: ADDON_ID } } }));
  await writeFile(join(source, 'background.js'), 'trusted bytes');
  assert.equal(await recoverSignedXpi({ version: VERSION, addonId: ADDON_ID, sourceDir: source, outputPath: output, issuer: 'key', secret: 'secret', fetchImpl: async () => new Response('', { status: 404 }) }), false);
  const changed = join(root, 'changed.xpi');
  const altered = join(root, 'altered'); await mkdir(altered);
  await writeFile(join(altered, 'manifest.json'), await readFile(join(source, 'manifest.json')));
  await writeFile(join(altered, 'background.js'), 'tampered bytes');
  zip(altered, changed);
  assert.throws(() => verifyXpi({ sourceDir: source, xpiPath: changed, version: VERSION, addonId: ADDON_ID }));
  const unsigned = join(root, 'unsigned.xpi');
  zip(source, unsigned, false);
  assert.throws(() => verifyXpi({ sourceDir: source, xpiPath: unsigned, version: VERSION, addonId: ADDON_ID }));
});
