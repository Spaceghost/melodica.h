import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseListenUri, listenUri, routeOf } from '../src/listen-uri.js';

test('parses every target in all three forms', () => {
  const cases = [
    ['listen://artist/Modest%20Mouse', { target: 'artist', name: 'Modest Mouse' }],
    ['web+listen://genre/thrash%20metal', { target: 'genre', name: 'thrash metal' }],
    ['https://spacegho.st/listen/station/4123456789012345', { target: 'station', station: '4123456789012345' }],
    ['listen://track/' + 'a'.repeat(64) + '?t=95', { target: 'track', track: 'a'.repeat(64), t: 95 }],
    ['listen://map/neon-plains/synthwave-reach', { target: 'map', land: 'neon-plains', province: 'synthwave-reach' }],
    ['listen://map/neon-plains', { target: 'map', land: 'neon-plains' }],
    ['listen://user/knewter', { target: 'user', username: 'knewter' }],
    ['listen://listens', { target: 'listens' }],
    ['LISTEN://Leaderboard/', { target: 'leaderboard' }],
    ['listen://artist/Sigur%20R%C3%B3s', { target: 'artist', name: 'Sigur Rós' }],
  ];
  for (const [u, want] of cases) {
    const p = parseListenUri(u);
    assert.ok(p, u);
    for (const [k, v] of Object.entries(want)) assert.equal(p[k], v, `${u} ${k}`);
    assert.equal(parseListenUri(p.https).uri, p.uri, 'https round trip');
    assert.equal(parseListenUri(p.web).uri, p.uri, 'web+ round trip');
  }
  assert.equal(parseListenUri('listen://artist/AC%2FDC'), null, 'no slash inside a name');
  assert.equal(listenUri({ target: 'artist', name: 'Guns N\' Roses' }).https, "https://spacegho.st/listen/artist/Guns%20N'%20Roses");
  assert.equal(parseListenUri(listenUri({ target: 'artist', name: 'Guns N\' Roses' }).uri).name, "Guns N' Roses");
});

test('rejects anything not allow-listed', () => {
  const bad = [
    'listen://http://evil.example', 'listen://url/https%3A%2F%2Fevil.example', 'listen://artist', 'listen://artist/a/b',
    'listen://artist/%00x', 'listen://artist/%2e%2e', 'listen://artist/' + 'x'.repeat(201), 'listen://artist/%E0%A4%A',
    'listen://artist/ x', 'listen://artist/x?autoplay=1', 'listen://track/zzz!?t=1', 'listen://track/abc?t=999999',
    'listen://track/abc?t=1&t=2', 'listen://map/Neon_Plains', 'listen://map/a/b/c', 'listen://user/A', 'listen://station/12-34',
    'listen://artist/x#frag', 'javascript:alert(1)', 'https://evil.example/listen/artist/x', 'https://spacegho.st/listen/../oauth/admin',
    'listen://listens/extra', 'listen://artist/<script>', 42, null,
  ];
  for (const u of bad) assert.equal(parseListenUri(u), null, String(u));
  assert.equal(listenUri({ target: 'url', name: 'x' }), null);
  assert.equal(listenUri({ target: 'artist', name: '..' }), null);
  assert.ok(listenUri({ target: 'artist', name: '...' }), 'three dots is a name');
  assert.equal(listenUri({ target: 'user', username: 'NO' }), null);
});

test('routes stay on spacegho.st melodica pages', () => {
  assert.equal(routeOf(parseListenUri('listen://artist/Modest%20Mouse')), '/melodica/app/?seed=artist:Modest%20Mouse');
  assert.equal(routeOf(parseListenUri('listen://map/neon-plains/synthwave-reach')), '/melodica/map/?land=neon-plains&province=synthwave-reach');
  assert.equal(routeOf(parseListenUri('listen://track/abc?t=5')), '/melodica/listens/?track=abc&t=5');
  for (const u of ['listen://listens', 'listen://leaderboard', 'listen://user/knewter', 'listen://station/123', 'listen://genre/dance']) {
    assert.match(routeOf(parseListenUri(u)), /^\/melodica\//);
  }
});
