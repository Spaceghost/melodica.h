// Unit test of the update awareness (src/update.imba, bundled for Node by
// scripts/build.mjs as build/node/update.js): the version compare, reading the
// newest version out of both feed shapes, the feed URL per build, and the banner.
//   node tests/update.test.mjs
import { compareVersions, isVersion, latestVersion, feedUrl, bannerState, STORE_URL, GECKO_ID, EXTENSION_ID } from '../build/node/update.js';

let n = 0;
const eq = (a, b, what) => {
  n++;
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error(`FAIL ${what}: ${A} !== ${B}`); process.exit(1); }
};

// Version compare: numeric per part, missing parts are 0, a -tag is ignored.
for (const [a, b, want] of [
  ['0.2.0', '0.1.7', 1], ['0.1.7', '0.2.0', -1], ['0.2.0', '0.2.0', 0],
  ['0.10.0', '0.9.9', 1], ['1.0', '1.0.0', 0], ['1.0.1', '1.0', 1],
  ['v0.3.0', '0.2.0', 1], ['0.2.0-dev', '0.2.0', 0], ['0.0.0', '0.0.0-abc1234', 0],
  ['junk', '0.0.1', -1], ['junk', '', 0], ['', '0.0.0', 0], [undefined, null, 0],
]) eq(compareVersions(a, b), want, `compare ${a} ${b}`);
eq(isVersion('0.2.0'), true, 'isVersion');
eq(isVersion('v0.2.0-rc1'), true, 'isVersion tag');
eq(isVersion('latest'), false, 'isVersion word');
eq(isVersion(''), false, 'isVersion empty');

// Feed per build: the Firefox manifest carries browser_specific_settings.
eq(feedUrl({ browser_specific_settings: { gecko: { id: GECKO_ID } } }), `https://spacegho.st/extensions/dl/${EXTENSION_ID}/updates.json`, 'firefox feed');
eq(feedUrl({}), 'https://spacegho.st/extensions/releases.json', 'chromium feed');
eq(feedUrl({}, 'https://127.0.0.1:1/extensions'), 'https://127.0.0.1:1/extensions/releases.json', 'feed base override');

// updates.json (Firefox's own format, as extensions-site writes it).
const updatesJson = { addons: { [GECKO_ID]: { updates: [
  { version: '0.1.7', update_link: 'https://spacegho.st/extensions/dl/melodica-extension/v0.1.7/melodica-extension-0.1.7.xpi', update_hash: 'sha256:f5cd' },
  { version: '0.2.0', update_link: 'https://spacegho.st/extensions/dl/melodica-extension/v0.2.0/melodica-extension-0.2.0.xpi', update_hash: 'sha256:abcd' },
] } } };
eq(latestVersion(updatesJson), '0.2.0', 'updates.json newest');
eq(latestVersion({ addons: { 'other@example.org': { updates: [{ version: '9.0.0' }] } } }), null, 'updates.json for another add-on');
eq(latestVersion({ addons: { [GECKO_ID]: { updates: [] } } }), null, 'updates.json empty');

// releases.json (the store manifest).
const releasesJson = { generated: 'x', extensions: [
  { id: 'other', release: { tag: 'v9.9.9' }, feeds: { chrome: { version: '9.9.9' } } },
  { id: EXTENSION_ID, release: { tag: 'v0.2.0' }, feeds: { firefox: { version: '0.2.0' }, chrome: { version: '0.2.0' } } },
] };
eq(latestVersion(releasesJson), '0.2.0', 'releases.json version');
eq(latestVersion({ extensions: [{ id: EXTENSION_ID, release: { tag: 'v0.3.0' }, feeds: {} }] }), '0.3.0', 'releases.json falls back to the tag');
eq(latestVersion({ extensions: [{ id: EXTENSION_ID, release: null, feeds: {} }] }), null, 'releases.json unreleased');
eq(latestVersion({ extensions: [] }), null, 'releases.json without the extension');
for (const bad of [null, undefined, 'str', 42, [], {}, { addons: 'x' }, { extensions: 'x' }]) eq(latestVersion(bad), null, `latestVersion of ${JSON.stringify(bad)}`);

// The banner: only when the store (or the browser's fetched update) is newer.
eq(bannerState('0.2.0', '0.2.0'), null, 'up to date');
eq(bannerState('0.2.0', '0.1.7'), null, 'store older');
eq(bannerState('0.2.0', null), null, 'nothing known');
eq(bannerState('0.0.0', '99.0.0'), { version: '99.0.0', text: 'melodica 99.0.0 is available', url: STORE_URL, reload: false }, 'banner from the feed');
eq(bannerState('0.2.0', '0.2.0', '0.3.0'), { version: '0.3.0', text: 'melodica 0.3.0 is available', url: STORE_URL, reload: true }, 'banner with a fetched update: reload');
eq(bannerState('0.2.0', '0.4.0', '0.3.0'), { version: '0.4.0', text: 'melodica 0.4.0 is available', url: STORE_URL, reload: true }, 'store newer than the fetched update, reload still offered');
eq(bannerState('0.3.0', '0.2.0', '0.2.0'), null, 'fetched update older than running');
eq(bannerState('0.2.0', 'junk', 'junk'), null, 'junk versions');
eq(STORE_URL, 'https://spacegho.st/extensions/#melodica-extension', 'store url');

console.log(`update: ${n} checks ok`);
