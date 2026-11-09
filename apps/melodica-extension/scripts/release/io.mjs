import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, parseSums, safeName } from './model.mjs';

export const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['GH_TOKEN', 'GITHUB_TOKEN'].includes(k)));

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    cwd: options.cwd, env: options.env || hostEnv });
  if (options.allowFailure) return result;
  if (result.status !== 0) {
    const detail = String(result.stderr || '').split('\n').filter(x => !/authorization|oauth_token|refresh_token|api_token|cfoat_|gh[pousr]_/i.test(x)).slice(-5).join('\n');
    throw new Error(`${command} failed (${result.status}): ${detail}`);
  }
  return result.stdout;
}

export async function wranglerBinary() {
  const root = join(homedir(), '.npm', '_npx');
  const find = async () => {
    for (const dir of await readdir(root).catch(() => [])) {
      const pkg = join(root, dir, 'node_modules/wrangler');
      try {
        if (JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version === '4.135.0') return join(pkg, 'bin/wrangler.js');
      } catch { /* another cached package */ }
    }
  };
  let file = await find();
  if (!file) { run('npx', ['-y', 'wrangler@4.135.0', '--version']); file = await find(); }
  if (!file) throw new Error('Pinned Wrangler could not be prepared');
  return file;
}

export async function loadRegistry(cache, kind) {
  const repo = kind === 'extensions' ? 'extensions-site' : 'melodica-web';
  const dir = join(cache, 'sources', repo);
  if (!(await stat(join(dir, '.git')).catch(() => null))) {
    await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
    run('gh', ['repo', 'clone', `Spaceghost/${repo}`, dir, '--', '--depth=1', '--filter=blob:none', '--no-checkout']);
  }
  run('git', ['fetch', '--depth=1', 'origin', 'master'], { cwd: dir });
  const sha = run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: dir }).trim();
  const prefix = kind === 'extensions' ? '' : 'site/';
  const show = path => run('git', ['show', `${sha}:${prefix}${path}`], { cwd: dir });
  const config = JSON.parse(show(kind === 'extensions' ? 'data/extensions.json' : 'data/projects.json'));
  const platformSource = show('src/platform.js');
  const module = join(cache, 'sources', `${repo}-${sha}.mjs`);
  await writeFile(module, platformSource);
  const platform = await import(pathToFileURL(module).href);
  const wrangler = show('wrangler.toml');
  const account = wrangler.match(/^account_id\s*=\s*"([a-f0-9]+)"/m)?.[1];
  const bucket = wrangler.match(/^bucket_name\s*=\s*"([\w-]+)"/m)?.[1];
  if (!bucket || (kind === 'extensions' && !account)) throw new Error(`${repo}: release bucket/account is not configured`);
  return { kind, repo, sha, platform, account, bucket,
    config: config[kind].find(p => p.id === 'melodica-extension'),
    fingerprint: digest(platformSource + JSON.stringify(config[kind].find(p => p.id === 'melodica-extension'))) };
}

export async function downloadRelease(cache, tag) {
  const result = run('gh', ['api', `repos/Spaceghost/melodica-extension/releases/tags/${tag}`], { allowFailure: true });
  if (result.status !== 0) {
    if (/404|Not Found/.test(result.stderr || '')) return null;
    throw new Error('GitHub release metadata could not be loaded');
  }
  const release = JSON.parse(result.stdout);
  const dir = join(cache, 'releases', tag);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const a of release.assets) safeName(a.name);
  run('gh', ['release', 'download', tag, '--repo', 'Spaceghost/melodica-extension', '--pattern', 'SHA256SUMS', '--dir', dir, '--clobber']);
  const sums = parseSums(await readFile(join(dir, 'SHA256SUMS'), 'utf8'));
  const missing = [];
  for (const asset of release.assets) {
    const file = await readFile(join(dir, asset.name)).catch(() => null);
    if (!file || file.length !== asset.size || (sums.has(asset.name) && digest(file) !== sums.get(asset.name))) missing.push(asset.name);
  }
  if (missing.length) run('gh', ['release', 'download', tag, '--repo', 'Spaceghost/melodica-extension', '--dir', dir, '--clobber', ...missing.flatMap(name => ['--pattern', name])]);
  const files = new Map();
  for (const asset of release.assets) {
    const path = join(dir, asset.name);
    const file = { path, body: await readFile(path) };
    if (/\.(zip|xpi)$/i.test(asset.name)) {
      const manifest = run('unzip', ['-p', path, 'manifest.json'], { allowFailure: true });
      if (manifest.status === 0) file.manifest = JSON.parse(manifest.stdout);
      if (/\.xpi$/i.test(asset.name)) file.signed = run('unzip', ['-Z1', path]).split('\n').includes('META-INF/mozilla.rsa');
    }
    files.set(asset.name, file);
  }
  return { release, files, dir };
}

export class R2 {
  constructor(binary, account, output) { this.binary = binary; this.account = account; this.output = output; this.index = 0; }
  command(args) {
    return run(process.execPath, [this.binary, ...args], { env: { ...hostEnv,
      CLOUDFLARE_ACCOUNT_ID: this.account, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
  }
  async get(bucket, key) {
    const file = join(this.output, `read-${bucket}-${this.index++}.json`);
    this.command(['r2', 'object', 'get', `${bucket}/${key}`, '--file', file, '--remote']);
    return JSON.parse(await readFile(file, 'utf8'));
  }
  put(bucket, key, file, type) {
    this.command(['r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--content-type', type, '--remote']);
  }
  async bulk(bucket, entries, type) {
    if (!entries.length) return;
    const file = join(this.output, `upload-${bucket}-${this.index++}.json`);
    await writeFile(file, JSON.stringify(entries));
    this.command(['r2', 'bulk', 'put', bucket, '--filename', file, '--content-type', type,
      '--concurrency', '6', '--remote', '--force']);
  }
}
