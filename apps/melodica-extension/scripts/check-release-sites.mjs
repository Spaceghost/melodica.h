import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = 'https://spacegho.st';
const ID = 'melodica-extension';
const GECKO = 'melodica-extension@spacegho.st';
const CHROME = 'obbahflgghfemmpmjppeibnemibgblbd';

export async function checkReleaseSites(version, sums, fetchImpl = fetch) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const read = async (path, kind = 'json') => {
    const res = await fetchImpl(`${ROOT}${path}${path.includes('?') ? '&' : '?'}release_check=${Date.now()}`, {
      headers: { 'user-agent': 'melodica-ci', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(res.status, 200, `${path}: HTTP ${res.status}`);
    return kind === 'bytes' ? Buffer.from(await res.arrayBuffer()) : kind === 'text' ? res.text() : res.json();
  };
  const stores = [
    ['/extensions', 'extensions'],
    ['/melodica', 'projects'],
  ];
  let downloads = 0;
  for (const [prefix, key] of stores) {
    const manifest = await read(`${prefix}/releases.json`);
    const project = manifest[key]?.find((p) => p.id === ID);
    assert.equal(project?.release?.tag, `v${version}`, `${prefix}: published release`);
    for (const suffix of ['-chrome.zip', '-firefox.zip', '.crx', '.xpi']) {
      const name = `${ID}-${version}${suffix}`;
      const asset = project.assets.find((a) => a.name === name);
      const digest = sums.get(name);
      assert.match(digest || '', /^[0-9a-f]{64}$/, `${name}: release checksum`);
      assert.equal(asset?.sha256, digest, `${prefix}/${name}: manifest checksum`);
      const bytes = await read(`${prefix}/dl/${ID}/v${version}/${name}`, 'bytes');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, `${prefix}/${name}: public download checksum`);
      downloads++;
    }
    if (prefix === '/extensions') {
      assert.equal(project.assets.find((a) => a.name.endsWith('.xpi'))?.signed, 'amo', 'Firefox package is Mozilla-signed');
    }
  }
  const feed = await read(`/extensions/dl/${ID}/updates.json`);
  const update = feed.addons?.[GECKO]?.updates?.find((u) => u.version === version);
  assert.equal(update?.update_link, `${ROOT}/extensions/dl/${ID}/v${version}/${ID}-${version}.xpi`, 'Firefox update URL');
  assert.equal(update?.update_hash, `sha256:${sums.get(`${ID}-${version}.xpi`)}`, 'Firefox update checksum');
  const xml = await read(`/extensions/dl/${ID}/update.xml`, 'text');
  assert.ok(xml.includes(`appid="${CHROME}"`), 'Chromium extension ID');
  assert.ok(xml.includes(`version="${version}"`), 'Chromium feed version');
  assert.ok(xml.includes(`codebase="${ROOT}/extensions/dl/${ID}/v${version}/${ID}-${version}.crx"`), 'Chromium update URL');
  const html = await read('/melodica/extension/?fragment=1', 'text');
  const cards = [...html.matchAll(/<(?:article|section)\b[^>]*class="[^"]*\bcard\b[^"]*"[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cards, [ID], 'Melodica catalog contains only its browser extension');
  assert.ok(html.includes('https://spacegho.st/extensions/'), 'link to all browser extensions');
  assert.ok(html.includes(`v${version}`), 'Melodica install page version');
  const store = await read('/extensions/', 'text');
  assert.ok(store.includes(`${ID}-${version}.xpi`), 'full browser catalog install link');
  return { version, downloads, catalogs: stores.map(([prefix]) => prefix), firefox: true, chromium: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = (process.argv[2] || '').replace(/^v/, '');
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Usage: node scripts/check-release-sites.mjs <version>');
  const body = execFileSync('gh', ['release', 'download', `v${version}`, '--repo', 'Spaceghost/melodica-extension', '--pattern', 'SHA256SUMS', '--output', '-'], { encoding: 'utf8' });
  const sums = new Map(body.split('\n').map((line) => line.match(/^([0-9a-f]{64})\s+\*?(\S+)$/)).filter(Boolean).map((m) => [m[2], m[1]]));
  console.log(JSON.stringify(await checkReleaseSites(version, sums), null, 2));
}
