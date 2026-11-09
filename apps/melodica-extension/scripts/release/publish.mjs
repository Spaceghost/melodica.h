import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, versionOf, verifyRelease, compareTags } from './model.mjs';
import { run, wranglerBinary, loadRegistry, downloadRelease, R2 } from './io.mjs';
import { publishObjects } from './pipeline.mjs';
import { checkReleaseSites } from '../check-release-sites.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function eventually(label, operation, timeout = 360000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { return await operation(); } catch (error) {
      if (Date.now() >= end) throw error;
      console.log(`${label}: waiting for the public update`);
      await sleep(15000);
    }
  }
}

export async function checkFeeds(version, sums, fetchImpl = fetch) {
  const base = 'https://spacegho.st/extensions/dl/melodica-extension';
  const get = async (url, type) => {
    const response = await fetchImpl(`${url}?verify=${Date.now()}`, { headers: { 'user-agent': 'melodica-ci', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `${url}: HTTP status`);
    return type === 'json' ? response.json() : type === 'text' ? response.text() : Buffer.from(await response.arrayBuffer());
  };
  const firefox = await get(`${base}/updates.json`, 'json');
  const update = firefox.addons?.['melodica-extension@spacegho.st']?.updates?.at(-1);
  assert.equal(update?.version, version, 'Firefox feed version');
  assert.equal(update?.update_link, `${base}/v${version}/melodica-extension-${version}.xpi`);
  assert.equal(update?.update_hash, `sha256:${sums.get(`melodica-extension-${version}.xpi`)}`);
  assert.equal(digest(await get(update.update_link)), sums.get(`melodica-extension-${version}.xpi`));
  const xml = await get(`${base}/update.xml`, 'text');
  const crx = `${base}/v${version}/melodica-extension-${version}.crx`;
  assert.ok(xml.includes(`version="${version}"`) && xml.includes(`codebase="${crx}"`) && xml.includes('appid="obbahflgghfemmpmjppeibnemibgblbd"'), 'Chromium feed');
  assert.equal(digest(await get(crx)), sums.get(`melodica-extension-${version}.crx`));
}

export async function main(args = process.argv.slice(2)) {
  const dry = args.includes('--dry-run');
  const tag = args.find(x => /^v\d/.test(x)) || run('gh', ['release', 'view', '--repo', 'Spaceghost/melodica-extension', '--json', 'tagName', '--jq', '.tagName']).trim();
  const version = versionOf(tag);
  const cache = resolve(process.env.MELODICA_RELEASE_CACHE || join(homedir(), '.cache/melodica-release'));
  const output = resolve(process.env.MELODICA_RELEASE_OUTPUT || 'tests/artifacts/publication');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await mkdir(output, { recursive: true });
  const lock = join(cache, 'publisher.lock');
  const commandHash = async pid => digest(await readFile(`/proc/${pid}/cmdline`).catch(() => ''));
  try { await mkdir(lock); } catch {
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8').catch(() => '{}'));
    if ((!owner.pid && Date.now() - (await stat(lock)).mtimeMs < 30000) || (owner.pid && owner.commandHash === await commandHash(owner.pid))) throw new Error('A release publisher is already running');
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, commandHash: await commandHash(process.pid) }));
  const started = Date.now();
  const report = { tag, version, started: new Date().toISOString(), dry,
    run: process.env.GITHUB_RUN_ID ? `https://github.com/Spaceghost/melodica-extension/actions/runs/${process.env.GITHUB_RUN_ID}` : null };
  const save = async () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  try {
    await save();
    const latest = run('gh', ['release', 'view', '--repo', 'Spaceghost/melodica-extension', '--json', 'tagName', '--jq', '.tagName']).trim();
    if (compareTags(latest, tag) > 0) { report.status = 'superseded'; report.newerRelease = latest; await save(); return report; }
    console.log(`Preparing ${tag}; Mozilla signing and the existing browser CI remain the release gates`);
    const payload = await downloadRelease(cache, tag);
    if (!payload) { report.status = 'waiting-for-github-release'; await save(); return report; }
    const registries = [await loadRegistry(cache, 'extensions'), await loadRegistry(cache, 'projects')];
    registries[1].account ||= registries[0].account;
    assert.equal(registries[0].account, registries[1].account, 'Both stores must use the configured Cloudflare account');
    assert.deepEqual(registries.map(r => r.bucket), ['spaceghost-extensions', 'melodica-downloads']);
    const sums = verifyRelease(payload.release, payload.files, registries[0].config);
    const fingerprint = digest(JSON.stringify({ tag, assets: payload.release.assets.map(a => [a.name, digest(payload.files.get(a.name).body)]),
      registries: registries.map(r => r.fingerprint), schema: 1 }));
    const statePath = join(cache, 'state.json');
    const previous = JSON.parse(await readFile(statePath, 'utf8').catch(() => '{}'));
    const r2 = new R2(await wranglerBinary(), registries[0].account, output);
    if (!dry && !args.includes('--force-files') && previous.fingerprint === fingerprint && previous.complete) {
      await eventually('Existing release verification', () => checkReleaseSites(version, sums));
      report.status = 'unchanged'; report.previousRun = previous.run; report.elapsedSeconds = (Date.now() - started) / 1000;
      await save(); return report;
    }
    // Compose everything before the first write, including all checksum and package checks.
    const objectsStart = Date.now();
    report.phase = 'objects-and-feeds'; await save();
    report.publication = await publishObjects({ ...payload, sums, registries, r2, output, dry, forceFiles: args.includes('--force-files'),
      verifyFeeds: () => eventually('Browser feeds', () => checkFeeds(version, sums)) });
    report.publicationSeconds = (Date.now() - objectsStart) / 1000;
    if (dry) { report.status = 'dry-run'; report.elapsedSeconds = (Date.now() - started) / 1000; await save(); return report; }
    report.phase = 'public-verification'; await save();
    report.publicChecks = await eventually('Public catalogs and download checksums', () => checkReleaseSites(version, sums));
    const { checkPages } = await import('./check-pages.mjs');
    report.pages = await eventually('Browser catalog checks', () => checkPages(version, join(output, 'pages')));
    report.verified = new Date().toISOString();
    report.phase = 'release-records'; await save();
    // A later retry can finish the records without losing the proven publication.
    await writeFile(statePath, JSON.stringify({ fingerprint, complete: false, run: report.run, owned: previous.owned || {} }));
    const { recordRelease } = await import('./records.mjs');
    const recorded = await recordRelease(report, cache, previous.owned || {},
      progress => writeFile(statePath, JSON.stringify({ fingerprint, complete: false, run: report.run,
        owned: progress.owned, pendingRecords: progress.pending })));
    report.commits = recorded.owned;
    report.pendingRecords = recorded.pending;
    report.phase = 'complete'; report.status = 'published';
    report.elapsedSeconds = (Date.now() - started) / 1000;
    await writeFile(statePath, JSON.stringify({ fingerprint, complete: recorded.pending.length === 0, run: report.run,
      owned: report.commits, pendingRecords: recorded.pending }));
    await save();
    console.log(recorded.pending.length
      ? `${tag}: catalogs, feeds, packages, and public checks passed; recent repository changes deferred handoff records (${recorded.pending.join(', ')}) for a scheduled retry`
      : `${tag}: both catalogs, both feeds, public packages, browser checks, handoffs and public snapshot completed`);
    return report;
  } catch (error) {
    if (error.message.startsWith('Refusing to replace newer release')) { report.status = 'superseded'; report.reason = error.message; await save(); return report; }
    report.status = 'failed'; report.error = error.message; await save(); throw error;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
