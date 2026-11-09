#!/usr/bin/env node
// web/scrobble.js without a browser or network: the listen threshold (half the track
// or 4 minutes; nothing for 30 s or less), the tracker (only forward play while
// playing counts; never an insert; due once), the ListenBrainz body and the API calls
// (bearer, credentials omitted, cursor, errors).

import { strict as assert } from 'node:assert';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const { Scrobbles, ListenTracker, ScrobbleError, listenThreshold, trackMetadata, PAGE_SIZE, genomeTraits, validGenome } = await import(pathToFileURL(resolve(dist, 'scrobble.js')).href);
const log = (...a) => console.log('[scrobble-unit]', ...a);

// Threshold.
assert.equal(listenThreshold(200), 100);
assert.equal(listenThreshold(480), 240);
assert.equal(listenThreshold(600), 240, '4 minutes always counts');
assert.equal(listenThreshold(31), 15.5);
assert.equal(listenThreshold(30), Infinity);
assert.equal(listenThreshold(10), Infinity);
assert.equal(listenThreshold(0), Infinity);
assert.equal(listenThreshold(NaN), Infinity);
log('threshold ok');

// Tracker: 1 s steps while playing.
{
  const song = { title: 'T', artist: 'A' };
  const t = new ListenTracker(song, 1000, 0);
  t.setDuration(200);
  t.setDuration(300); // the first known length stays
  assert.equal(t.duration, 200);
  for (let s = 0; s <= 99; s++) t.tick(s, true);
  assert.equal(t.due(), false, '99 s of 200');
  t.tick(150, true); // a jump is not play
  assert.equal(t.due(), false);
  t.tick(151, false); // paused: no
  assert.equal(t.due(), false);
  t.tick(152, true);
  assert.equal(t.due(), true, '100 s of 200');
  t.sent = true;
  assert.equal(t.due(), false, 'due once');
  const ins = new ListenTracker({ title: 'Insert', isInsert: true }, 0, 200);
  for (let s = 0; s <= 200; s++) ins.tick(s, true);
  assert.equal(ins.due(), false, 'never an insert');
  const short = new ListenTracker(song, 0, 10);
  for (let s = 0; s <= 10; s++) short.tick(s, true);
  assert.equal(short.due(), false, '10 s tracks never count');
  const long = new ListenTracker(song, 0, 3600);
  for (let s = 0; s <= 240; s += 0.25) long.tick(s, true);
  assert.equal(long.due(), true, '4 minutes of an hour');
}
log('tracker ok');

// Body.
{
  const m = trackMetadata({ title: 'Song', artist: 'Band', album: 'LP', coverArt: 'https://img/x.jpg', trackToken: 'TT', audioUrl: 'https://a' }, 200.4);
  assert.deepEqual(m, { artist_name: 'Band', track_name: 'Song', release_name: 'LP', additional_info: { submission_client: 'melodica-web', duration_ms: 200400, art_url: 'https://img/x.jpg' } });
  assert.equal(trackMetadata({ title: 'S', artist: 'B', coverArt: 'http://img/a.jpg' }, 0).additional_info.art_url, 'http://img/a.jpg', 'http art as Pandora gives it');
  assert.equal(trackMetadata({ title: 'S', artist: 'B', coverArt: 'data:x' }, 0).additional_info.art_url, undefined, 'only http(s) URLs');
  const st = trackMetadata({ title: 'S', artist: 'B', trackToken: 'TT' }, 0, '  Slow Light Radio ');
  assert.equal(st.additional_info.station_name, 'Slow Light Radio', 'the station name, as the extension sends it');
  assert.ok(!JSON.stringify(st).includes('TT'), 'never the track token');
  assert.equal(trackMetadata({ title: 'S', artist: 'B' }, 0, 'x'.repeat(300)).additional_info.station_name.length, 128);
}
log('body ok');

// API calls.
{
  const calls = [];
  let answer = () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  const fetch = async (url, init) => { calls.push({ url, init }); return answer(url, init); };
  let token = 'mat.one';
  const s = new Scrobbles({ origin: 'https://spacegho.st', fetch, token: async () => token });
  assert.deepEqual(s.links, { dashboard: 'https://spacegho.st/melodica/listens/', leaderboard: 'https://spacegho.st/melodica/leaderboard/', crew: 'https://spacegho.st/melodica/map/' });
  await s.submit('single', { title: 'S', artist: 'B' }, 200, 1700000000.7);
  const c = calls.at(-1);
  assert.equal(c.url, 'https://spacegho.st/scrobble/api/me/listens');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.credentials, 'omit');
  assert.equal(c.init.headers.authorization, 'Bearer mat.one');
  assert.deepEqual(JSON.parse(c.init.body), { listen_type: 'single', payload: [{ listened_at: 1700000000, track_metadata: { artist_name: 'B', track_name: 'S', additional_info: { submission_client: 'melodica-web', duration_ms: 200000 } } }] });
  await s.submit('playing_now', { title: 'S', artist: 'B' }, 0);
  assert.equal(JSON.parse(calls.at(-1).init.body).payload[0].listened_at, undefined, 'playing now has no time');
  await s.listens('1700.abc');
  assert.equal(calls.at(-1).url, `https://spacegho.st/scrobble/api/me/listens?limit=${PAGE_SIZE}&before=1700.abc`);
  await s.setSettings({ scrobbling: false });
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { scrobbling: false });
  answer = () => new Response(JSON.stringify({ error: 'scrobbling_off', message: 'Scrobbling is off.' }), { status: 403 });
  await assert.rejects(s.submit('single', { title: 'S', artist: 'B' }, 200, 1), (e) => e instanceof ScrobbleError && e.status === 403 && e.code === 'scrobbling_off');
  answer = () => { throw new TypeError('offline'); };
  await assert.rejects(s.me(), (e) => e.status === 0 && e.code === 'network');
  token = '';
  const before = calls.length;
  await assert.rejects(s.me(), (e) => e.code === 'no_token');
  assert.equal(calls.length, before, 'no request without a bearer');
}
log('api ok');
// Conquest v2: genome traits from the explanation; the thumb body.
{
  const P = "We're playing this track because it features ";
  assert.deepEqual(genomeTraits(P + 'a subtle use of vocal harmony, mild rhythmic syncopation and acoustic sonority.'),
    ['a subtle use of vocal harmony', 'mild rhythmic syncopation', 'acoustic sonority']);
  assert.deepEqual(genomeTraits(P + 'minor key tonality.'), ['minor key tonality']);
  assert.deepEqual(genomeTraits(P + 'x and y.'), ['x', 'y']);
  assert.equal(genomeTraits('Something else.'), null);
  assert.equal(genomeTraits(P + '.'), null);
  assert.equal(genomeTraits(null), null);
  const many = Array.from({ length: 20 }, (_, i) => `trait ${i}`);
  assert.equal(validGenome(many).length, 12);
  assert.deepEqual(validGenome(['ok', 'x'.repeat(65), '', 7, 'ok', 'b\u0001']), ['ok']);
  assert.equal(validGenome([]), null);
  const m = trackMetadata({ artist: 'A', title: 'T', genome: ['g1', 'g2'] }, 200);
  assert.deepEqual(m.additional_info.genome, ['g1', 'g2']);
  assert.equal('genome' in trackMetadata({ artist: 'A', title: 'T', genome: ['x'.repeat(65)] }, 200).additional_info, false);
  assert.equal('genome' in trackMetadata({ artist: 'A', title: 'T' }, 200).additional_info, false);
  const calls = [];
  const s = new Scrobbles({ origin: 'https://spacegho.st', token: () => 'tok', fetch: async (u, init) => { calls.push([u, init]); return new Response('{}', { status: 200 }); } });
  await s.thumb('up', { artist: 'Aurora Fields', title: 'Slow Light' });
  assert.equal(calls[0][0], 'https://spacegho.st/scrobble/api/game/thumb');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { direction: 'up', artist_name: 'Aurora Fields', track_name: 'Slow Light' });
}
log('conquest ok');
log('ALL OK');
