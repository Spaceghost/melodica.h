import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, parseSums, safeName, verifyRelease, makeEntry, mergeManifest, uploadPlan, makeFeeds, compareTags } from '../scripts/release/model.mjs';
import { publishObjects } from '../scripts/release/pipeline.mjs';
import { publicationEvent } from '../scripts/release/event.mjs';
import { updateRecord, assertPublicSnapshot, shouldDeferRecord } from '../scripts/release/records.mjs';

function fixture() {
  const config = { id: 'melodica-extension', gecko_id: 'melodica-extension@spacegho.st', chrome_id: 'obbahflgghfemmpmjppeibnemibgblbd' };
  const release = { tag_name: 'v1.2.3', draft: false, prerelease: false, name: 'Release', html_url: 'https://github.com/release', published_at: '2026-11-09T00:00:00Z', assets: [] };
  const files = new Map();
  for (const name of ['melodica-extension-1.2.3-chrome.zip', 'melodica-extension-1.2.3-firefox.zip', 'melodica-extension-1.2.3.xpi', 'melodica-extension-1.2.3.crx', 'melodica-extension-1.2.3-src.tar.gz', 'smoke-extension.json', 'smoke-brave.json', 'smoke-firefox.json']) {
    const body = name.endsWith('.json') ? Buffer.from('{"ok":true,"steps":["playback"]}') : Buffer.from(name);
    files.set(name, { body, path: '/fixture/' + name, signed: name.endsWith('.xpi'), manifest: { version: '1.2.3', update_url: 'https://spacegho.st/extensions/dl/melodica-extension/update.xml', browser_specific_settings: { gecko: { id: config.gecko_id, update_url: 'https://spacegho.st/extensions/dl/melodica-extension/updates.json' } } } });
    release.assets.push({ name, size: body.length, browser_download_url: 'https://github.com/' + name });
  }
  const text = [...files].map(([name, file]) => `${digest(file.body)}  ${name}`).join('\n') + '\n';
  files.set('SHA256SUMS', { body: Buffer.from(text), path: '/fixture/SHA256SUMS' });
  release.assets.push({ name: 'SHA256SUMS', size: Buffer.byteLength(text), browser_download_url: 'https://github.com/SHA256SUMS' });
  const platform = {
    mirrored: name => !name.endsWith('.tar.gz'),
    classify: name => ({ id: name.startsWith('smoke-') ? 'smoke' : name.endsWith('.xpi') ? 'firefox' : 'file', label: 'fixture' }),
    contentTypeFor: name => name.endsWith('.json') ? 'application/json' : name.endsWith('.xpi') ? 'application/x-xpinstall' : 'application/octet-stream',
  };
  const sums = parseSums(text);
  const registries = ['extensions', 'projects'].map(kind => ({ kind, bucket: kind, config, platform }));
  return { config, release, files, sums, platform, registries };
}
const entry = (f, kind = 'extensions') => makeEntry({ ...f, kind });

test('complete signed packages and passing browser proofs satisfy publication preflight', () => {
  const f = fixture(); assert.equal(verifyRelease(f.release, f.files, f.config).size, 8);
});
test('signed installables may publish while absent full-browser reports are explicitly pending', () => {
  const f = fixture();
  const pending = ['smoke-extension.json', 'smoke-brave.json', 'smoke-firefox.json'];
  f.release.assets = f.release.assets.filter(asset => !pending.includes(asset.name));
  for (const name of pending) f.files.delete(name);
  const sumsText = [...f.files].filter(([name]) => name !== 'SHA256SUMS')
    .map(([name, file]) => `${digest(file.body)}  ${name}`).join('\n') + '\n';
  f.files.set('SHA256SUMS', { body: Buffer.from(sumsText), path: '/fixture/SHA256SUMS' });
  f.release.assets.find(asset => asset.name === 'SHA256SUMS').size = Buffer.byteLength(sumsText);
  f.sums = parseSums(sumsText);
  verifyRelease(f.release, f.files, f.config);
  const published = entry(f);
  assert.deepEqual(published.browserProofs, { status: 'pending', chromium: 'pending', brave: 'pending', firefox: 'pending' });
  assert.equal(published.assets.some(asset => asset.platform.id === 'smoke'), false);
});
test('a supplied failing browser report remains a publication blocker', () => {
  const f = fixture();
  const report = f.files.get('smoke-brave.json');
  report.body = Buffer.from('{"ok":false}');
  f.release.assets.find(asset => asset.name === 'smoke-brave.json').size = report.body.length;
  const sumsText = [...f.files].filter(([name]) => name !== 'SHA256SUMS')
    .map(([name, file]) => `${digest(file.body)}  ${name}`).join('\n') + '\n';
  f.files.set('SHA256SUMS', { body: Buffer.from(sumsText) });
  f.release.assets.find(asset => asset.name === 'SHA256SUMS').size = Buffer.byteLength(sumsText);
  assert.throws(() => verifyRelease(f.release, f.files, f.config), /browser proof must pass/);
});
test('a changed download fails its checksum before publication', () => {
  const f = fixture(); f.files.get('melodica-extension-1.2.3.crx').body[0] ^= 1;
  assert.throws(() => verifyRelease(f.release, f.files, f.config), /checksum mismatch/);
});
test('an unsigned Firefox package cannot publish', () => {
  const f = fixture(); f.files.get('melodica-extension-1.2.3.xpi').signed = false;
  assert.throws(() => verifyRelease(f.release, f.files, f.config), /signed by Mozilla/);
});
test('a wrong package version cannot publish under the requested tag', () => {
  const f = fixture(); f.files.get('melodica-extension-1.2.3.xpi').manifest.version = '1.2.2';
  assert.throws(() => verifyRelease(f.release, f.files, f.config), /Firefox package version/);
});
test('a draft cannot publish', () => {
  const f = fixture(); f.release.draft = true;
  assert.throws(() => verifyRelease(f.release, f.files, f.config), /Draft releases/);
});
test('duplicate checksums and unsafe filenames are refused', () => {
  assert.throws(() => parseSums(`${'a'.repeat(64)}  file\n${'b'.repeat(64)}  file\n`), /Duplicate/);
  for (const name of ['../escape', '--option', 'file*.zip', 'line\nfile']) assert.throws(() => safeName(name));
});
test('release versions are compared numerically', () => {
  assert.equal(compareTags('v1.10.0', 'v1.9.9'), 1);
});
test('the browser store omits source archives while the Melodica mirror retains them', () => {
  const f = fixture(); assert.equal(entry(f).assets.length, 8); assert.equal(entry(f, 'projects').assets.length, 9);
});
test('an unchanged release needs no asset uploads', () => {
  const f = fixture(); const e = entry(f); assert.deepEqual(uploadPlan({ extensions: [e] }, 'extensions', e), []);
});
test('a versioned installable cannot be replaced with different bytes', () => {
  const f = fixture(); const old = entry(f); const next = structuredClone(old); next.assets.find(a => a.name.endsWith('.xpi')).sha256 = '0'.repeat(64);
  assert.throws(() => uploadPlan({ extensions: [old] }, 'extensions', next), /cannot change/);
});
test('a newer live version cannot be rolled back by a delayed workflow', () => {
  const f = fixture(); const old = entry(f); old.release.tag = 'v1.2.4';
  assert.throws(() => mergeManifest({ extensions: [old] }, 'extensions', entry(f)), /newer release/);
});
test('merging a release preserves every other project and manifest property', () => {
  const f = fixture(); const other = { id: 'native-app', release: { tag: '2026.11.09' }, assets: [{ name: 'app.zip' }] };
  const next = mergeManifest({ site: { title: 'existing' }, projects: [other] }, 'projects', entry(f, 'projects'));
  assert.deepEqual(next.projects[0], other); assert.deepEqual(next.site, { title: 'existing' });
});
test('browser feed pointers match the tag and signed file checksum', () => {
  const f = fixture(); const feeds = makeFeeds(f.config, 'v1.2.3', 'a'.repeat(64));
  assert.equal(JSON.parse(feeds['updates.json']).addons[f.config.gecko_id].updates[0].update_hash, `sha256:${'a'.repeat(64)}`);
  assert.match(feeds['update.xml'], /version="1.2.3"/);
});

async function pipelineFixture(options = {}) {
  const f = fixture();
  const output = await mkdtemp(join(tmpdir(), 'publication-test-'));
  const events = [];
  const data = { extensions: { extensions: [] }, projects: { projects: [{ id: 'other', value: 1 }] } };
  const r2 = {
    async get(bucket) { events.push(`get:${bucket}`); return structuredClone(data[bucket]); },
    async bulk(bucket) { events.push(`bulk:${bucket}`); data.projects.projects[0].value = 2; if (options.failUpload) throw new Error('upload failed'); },
    async put(bucket, key, path) { events.push(`put:${bucket}:${key}`); if (key === 'releases.json') data[bucket] = JSON.parse(await readFile(path, 'utf8')); },
  };
  try {
    await publishObjects({ ...f, r2, output, dry: options.dry,
      verifyFeeds: async () => { events.push('verify-feeds'); if (options.failFeed) throw new Error('feed failed'); } });
    return { events, data };
  } finally { await rm(output, { recursive: true, force: true }); }
}
test('uploads finish and feeds are checked before either manifest is published', async () => {
  const { events, data } = await pipelineFixture();
  const lastBulk = Math.max(...events.map((e, i) => e.startsWith('bulk:') ? i : -1));
  const firstFeed = events.findIndex(e => e.startsWith('put:') && !e.endsWith('releases.json'));
  assert.ok(lastBulk < firstFeed);
  assert.ok(events.indexOf('verify-feeds') < events.indexOf('put:extensions:releases.json'));
  assert.equal(data.projects.projects[0].value, 2, 'a concurrent change is retained by the final manifest reread');
});
test('dry runs never upload or move a public pointer', async () => {
  const { events } = await pipelineFixture({ dry: true });
  assert.ok(events.every(e => e.startsWith('get:')));
});
test('an upload failure stops publication', async () => {
  await assert.rejects(pipelineFixture({ failUpload: true }), /upload failed/);
});
test('a failed feed check stops catalog publication', async () => {
  await assert.rejects(pipelineFixture({ failFeed: true }), /feed failed/);
});
test('only successful tag CI or completed tag iOS workflows can trigger publication', () => {
  const workflow_run = { event: 'push', name: 'ci', conclusion: 'success', head_branch: 'v1.2.3', head_repository: { full_name: 'Spaceghost/melodica-extension' } };
  assert.equal(publicationEvent('workflow_run', { workflow_run }).publish, true);
  for (const change of [{ event: 'pull_request' }, { head_branch: 'master' }, { conclusion: 'failure' }, { head_repository: { full_name: 'other/repo' } }]) {
    assert.equal(publicationEvent('workflow_run', { workflow_run: { ...workflow_run, ...change } }).publish, false);
  }
  assert.equal(publicationEvent('workflow_run', { workflow_run: { ...workflow_run, name: 'ios', conclusion: 'failure' } }).publish, true);
});
test('manual repair and scheduled catch-up require no new release', () => {
  assert.deepEqual(publicationEvent('schedule', {}), { publish: true, tag: '', force: false });
  assert.equal(publicationEvent('workflow_dispatch', { inputs: { tag: 'v1.2.3' } }).tag, 'v1.2.3');
  assert.throws(() => publicationEvent('workflow_dispatch', { inputs: { tag: 'branch' } }));
});
test('record updates are idempotent and retain unrelated handoff content', () => {
  const previous = '# Handoff\n\nKeep these feature notes.\n';
  const once = updateRecord(previous, '## Publication\n\nDone.');
  assert.equal(updateRecord(once, '## Publication\n\nDone.'), once);
  assert.ok(once.includes('Keep these feature notes.'));
});
test('recent independent repository commits defer release metadata without blocking publication', () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldDeferRecord(now - 60_000, now), true);
  assert.equal(shouldDeferRecord(now - 16 * 60_000, now), false);
});
test('public snapshots reject the private shared UI and reference parser', () => {
  assert.doesNotThrow(() => assertPublicSnapshot(['apps/melodica-extension/src/player.imba']));
  assert.doesNotThrow(() => assertPublicSnapshot(['apps/melodica-extension/scripts/scrobble-ui-pin.mjs']));
  for (const path of ['apps/melodica-extension/vendor/scrobble-ui/scrobble-ui.js', 'apps/melodica-extension/tests/listen-uri-reference.mjs', 'apps/other/file']) {
    assert.throws(() => assertPublicSnapshot([path]));
  }
});
