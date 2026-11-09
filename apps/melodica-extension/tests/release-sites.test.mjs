import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkReleaseSites } from '../scripts/check-release-sites.mjs';

function fixture() {
  const version = '0.8.8';
  const sums = new Map();
  const routes = new Map();
  const assets = ['-chrome.zip', '-firefox.zip', '.crx', '.xpi'].map((suffix) => {
    const name = `melodica-extension-${version}${suffix}`;
    const bytes = Buffer.from(`package ${name}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    sums.set(name, sha256);
    for (const prefix of ['/extensions', '/melodica']) routes.set(`${prefix}/dl/melodica-extension/v${version}/${name}`, bytes);
    return { name, sha256, signed: suffix === '.xpi' ? 'amo' : undefined };
  });
  const project = { id: 'melodica-extension', release: { tag: `v${version}` }, assets };
  routes.set('/extensions/releases.json', { extensions: [structuredClone(project)] });
  routes.set('/melodica/releases.json', { projects: [structuredClone(project)] });
  routes.set('/extensions/dl/melodica-extension/updates.json', { addons: { 'melodica-extension@spacegho.st': { updates: [{
    version, update_hash: `sha256:${sums.get(`melodica-extension-${version}.xpi`)}`,
    update_link: `https://spacegho.st/extensions/dl/melodica-extension/v${version}/melodica-extension-${version}.xpi`,
  }] } } });
  routes.set('/extensions/dl/melodica-extension/update.xml', `<gupdate><app appid="obbahflgghfemmpmjppeibnemibgblbd"><updatecheck version="${version}" codebase="https://spacegho.st/extensions/dl/melodica-extension/v${version}/melodica-extension-${version}.crx"/></app></gupdate>`);
  routes.set('/melodica/extension/', `<section class="card" id="melodica-extension">v${version}</section><a href="https://spacegho.st/extensions/">All browser extensions</a>`);
  routes.set('/extensions/', `<a href="/extensions/dl/melodica-extension/v${version}/melodica-extension-${version}.xpi">Install</a>`);
  const fetchImpl = async (url) => {
    const value = routes.get(new URL(url).pathname);
    return value === undefined ? new Response('', { status: 404 }) : new Response(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  return { routes, run: () => checkReleaseSites(version, sums, fetchImpl) };
}

test('both public catalogs, eight package downloads and both browser feeds agree', async () => {
  const result = await fixture().run();
  assert.equal(result.downloads, 8);
});
for (const [path, key] of [['/extensions/releases.json', 'extensions'], ['/melodica/releases.json', 'projects']]) {
  test(`a stale ${path} prevents release completion`, async () => {
    const f = fixture();
    f.routes.get(path)[key][0].release.tag = 'v0.8.7';
    await assert.rejects(f.run(), /published release/);
  });
}
test('a damaged public installable prevents release completion', async () => {
  const f = fixture();
  f.routes.set('/melodica/dl/melodica-extension/v0.8.8/melodica-extension-0.8.8.xpi', Buffer.from('damaged'));
  await assert.rejects(f.run(), /public download checksum/);
});
test('a Firefox feed with the wrong checksum prevents release completion', async () => {
  const f = fixture();
  f.routes.get('/extensions/dl/melodica-extension/updates.json').addons['melodica-extension@spacegho.st'].updates[0].update_hash = 'sha256:wrong';
  await assert.rejects(f.run(), /Firefox update checksum/);
});
test('a stale Chromium feed prevents release completion', async () => {
  const f = fixture();
  f.routes.set('/extensions/dl/melodica-extension/update.xml', '<app appid="obbahflgghfemmpmjppeibnemibgblbd"><updatecheck version="0.8.7"/></app>');
  await assert.rejects(f.run(), /Chromium feed version/);
});
test('a native app on the Melodica extension page prevents release completion', async () => {
  const f = fixture();
  f.routes.set('/melodica/extension/', '<section class="card" id="melodica-extension"></section><section class="card" id="pianobar"></section>');
  await assert.rejects(f.run(), /only its browser extension/);
});
test('an unsigned Firefox package prevents release completion', async () => {
  const f = fixture();
  f.routes.get('/extensions/releases.json').extensions[0].assets.at(-1).signed = 'unsigned';
  await assert.rejects(f.run(), /Mozilla-signed/);
});
