import test from 'node:test';
import assert from 'node:assert/strict';
import { renderScrobbleUiPin } from '../scripts/scrobble-ui-pin.mjs';

const valid = {
  commit: 'b6e72c21a10240b94a77ec148a7b071475625154',
  hash: 'edf62c9960bece1a',
  sha256: {
    'scrobble-ui.js': '1'.repeat(64),
    'scrobble-ui.css': '2'.repeat(64),
    'room-media.js': '3'.repeat(64),
  },
};

test('pin updater writes JS, CSS and room media digests in manifest order', () => {
  assert.equal(renderScrobbleUiPin(valid), [
    `commit ${valid.commit}`,
    `hash ${valid.hash}`,
    `${valid.sha256['scrobble-ui.js']}  scrobble-ui.js`,
    `${valid.sha256['scrobble-ui.css']}  scrobble-ui.css`,
    `${valid.sha256['room-media.js']}  room-media.js`,
    '',
  ].join('\n'));
});

test('pin updater accepts the explicit media_sha256 alias', () => {
  const { sha256, ...manifest } = valid;
  manifest.sha256 = { 'scrobble-ui.js': sha256['scrobble-ui.js'], 'scrobble-ui.css': sha256['scrobble-ui.css'] };
  manifest.media_sha256 = sha256['room-media.js'];
  assert.match(renderScrobbleUiPin(manifest), new RegExp(`${manifest.media_sha256}  room-media\\.js`));
});

test('pin updater rejects incomplete manifests instead of dropping room media', () => {
  const { 'room-media.js': _media, ...withoutMedia } = valid.sha256;
  assert.throws(() => renderScrobbleUiPin({ ...valid, sha256: withoutMedia }), /no sha256 for room-media\.js/);
});
