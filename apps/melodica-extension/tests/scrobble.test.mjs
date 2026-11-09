// Unit test of the Scrobbles helpers (src/scrobble.imba, bundled for Node by
// scripts/build.mjs as build/node/scrobble.js): listen metadata, the 50% / 4 min
// threshold, slots never submitted, the endpoint check and the 15-item list.
//   node tests/scrobble.test.mjs
import {
  trackMetadata, genomeTraits, thresholdSeconds, playingNow, single, scrobbleBase, recentFrom, listenOf, prependListen, isSpot, RECENT_MAX,
  enqueue, outcome, QUEUE_MAX,
} from '../build/node/scrobble.js';

let n = 0;
const eq = (a, b, what) => {
  n++;
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error(`FAIL ${what}: ${A} !== ${B}`); process.exit(1); }
};

const song = { title: 'Slow Light', artist: 'Aurora Fields', album: 'Night Bus', coverArt: 'https://img.example/a.jpg', duration: 200, trackToken: 'T1', audioUrl: 'https://audio.example/x', station: 'QuickMix' };
eq(trackMetadata(song), { artist_name: 'Aurora Fields', track_name: 'Slow Light', additional_info: { submission_client: 'melodica-extension', duration_ms: 200000, art_url: 'https://img.example/a.jpg' }, release_name: 'Night Bus' }, 'metadata: only artist, title, album, duration, art');
eq(trackMetadata({ ...song, coverArt: 'http://img.example/a.jpg', album: '' }).additional_info.art_url, undefined, 'plain-http art dropped');
eq(trackMetadata({ ...song, duration: 0 }, 180).additional_info.duration_ms, 180000, 'duration from the player');
eq(genomeTraits([' minor key tonality ', 'electric guitar riffs', 'minor key tonality', 7, '', 'x'.repeat(65)]), ['minor key tonality', 'electric guitar riffs'], 'genome: trimmed strings of at most 64, no repeats');
eq(genomeTraits(Array.from({ length: 20 }, (_, i) => `trait ${i}`)).length, 12, 'genome: at most 12');
eq(genomeTraits('rock'), null, 'genome: not a list');
eq(genomeTraits([]), null, 'genome: none left');
eq(trackMetadata(song, 0, ['heavy electric distortion']).additional_info.genome, ['heavy electric distortion'], 'genome in additional_info');
eq(trackMetadata(song, 0, []).additional_info.genome, undefined, 'no genome field without traits');
eq(trackMetadata({ ...song, ad: true }), null, 'a slot has no metadata');
eq(trackMetadata({ ...song, kind: 'spot' }), null, 'a slot has no metadata');
eq(isSpot({ ad: true }) && isSpot({ kind: 'spot' }) && !isSpot(song), true, 'isSpot');
eq(thresholdSeconds(200), 100, 'half of a 200 s track');
eq(thresholdSeconds(600), 240, '4 minutes cap');
eq(thresholdSeconds(30), null, '30 s never counts');
eq(thresholdSeconds(0), null, 'unknown length never counts');
const meta = trackMetadata(song);
eq(playingNow(meta), { listen_type: 'playing_now', payload: [{ track_metadata: meta }] }, 'playing_now body');
eq(single(meta, 1794000000.7), { listen_type: 'single', payload: [{ listened_at: 1794000000, track_metadata: meta }] }, 'single body');
eq(scrobbleBase('https://spacegho.st/scrobble/', 'https://spacegho.st'), 'https://spacegho.st/scrobble', 'named endpoint on the same origin');
eq(scrobbleBase('https://evil.example/scrobble', 'https://spacegho.st'), 'https://spacegho.st/scrobble', 'other origin refused');
eq(scrobbleBase(undefined, 'http://localhost:9'), 'http://localhost:9/scrobble', 'missing endpoint');
const many = Array.from({ length: 20 }, (_, i) => ({ listened_at: 100 - i, artist: 'A' + i, title: 'T' + i, art: i % 2 ? 'http://x/y' : 'https://x/y' }));
const r = recentFrom({ listens: many.concat([{ title: 'no artist' }]) });
eq(r.length, RECENT_MAX, '15 listens kept');
eq(r[0], { listened_at: 100, artist: 'A0', title: 'T0', art: 'https://x/y' }, 'listen shape');
eq(r[1].art, undefined, 'non-https art dropped');
eq(recentFrom(null), [], 'no body');
const l = listenOf(meta, 1794000000);
eq(l, { listened_at: 1794000000, artist: 'Aurora Fields', title: 'Slow Light', album: 'Night Bus', duration_ms: 200000, art: 'https://img.example/a.jpg' }, 'listen from metadata');
const p = prependListen(r, l);
eq([p.length, p[0].title, p[1].title], [15, 'Slow Light', 'T0'], 'new play prepended, still 15');
// The offline queue: singles only, no duplicates, at most QUEUE_MAX (oldest dropped).
let q = enqueue([], playingNow(meta));
eq(q, [], 'playing_now is never queued');
q = enqueue(q, single(meta, 1));
q = enqueue(q, single(meta, 1));
eq(q.length, 1, 'the same play is queued once');
for (let i = 2; i < QUEUE_MAX + 10; i++) q = enqueue(q, single(meta, i));
eq([q.length, q[0].payload[0].listened_at], [QUEUE_MAX, 10], 'capped, oldest dropped');
eq([200, 403, 401, 400, 429, 500, 0].map(outcome), ['ok', 'off', 'auth', 'drop', 'retry', 'retry', 'retry'], 'answers');
eq([thresholdSeconds(30), thresholdSeconds(31), thresholdSeconds(200), thresholdSeconds(600)], [null, 15.5, 100, 240], '30 s minimum, half, 4 min cap');
console.log(`scrobble: ${n} checks ok`);
