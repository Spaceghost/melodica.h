#!/usr/bin/env node
// Playlist inserts in the C glue, without a network: canned Pandora answers. A
// playlist reply lists its inserts ("inserts": token + position) next to the
// songs libpiano keeps; insertInfo and insertPlayed build authenticated,
// encrypted requests; their answers are parsed (quality choice, tracking
// tokens, Pandora errors). PianoClient.playlist puts insert markers at their
// positions.

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const { PianoClient, PianoError } = await import(pathToFileURL(resolve(dist, 'piano.js')).href);
const log = (...a) => console.log('[inserts-unit]', ...a);

// Same canned partner login as node-unit.mjs (syncTime from tests/tools/synctime.c).
const partnerBody = JSON.stringify({ stat: 'ok', result: {
  partnerId: '42', partnerAuthToken: 'CANNED+PARTNER/TOKEN==', syncTime: 'c1c474e9d63e974583a750b7e57453c4',
  stationSkipLimit: 6, stationSkipUnit: 'hour' } });

const canned = [];
const sent = [];
const fetchImpl = async (url, init) => {
  sent.push({ url, body: init.body });
  const next = canned.shift();
  if (!next) throw new Error(`unexpected request ${url}`);
  return new Response(next, { status: 200 });
};
const client = new PianoClient({ apiBase: 'https://relay.example/api/', fetch: fetchImpl });
await client.load();

canned.push(partnerBody, JSON.stringify({ stat: 'ok', result: { userId: 'U1', userAuthToken: 'TOKEN+/=1' } }));
await client.login('unit@example.invalid', 'pw');
canned.push(JSON.stringify({ stat: 'ok', result: { stations: [{ stationId: 'S1', stationName: 'One', stationToken: 'S1', isQuickMix: false }] } }));
await client.stations();

// --- playlist with inserts -----------------------------------------------------
const song = (n) => ({ artistName: `Artist ${n}`, albumName: 'Album', songName: `Song ${n}`, trackToken: `T${n}`, stationId: 'S1',
  trackLength: 100, audioUrlMap: { highQuality: { encoding: 'aacplus', audioUrl: `https://cdn.example/${n}.m4a` },
    mediumQuality: { encoding: 'aacplus', audioUrl: `https://cdn.example/${n}m.m4a` }, lowQuality: { encoding: 'aacplus', audioUrl: `https://cdn.example/${n}l.m4a` } } });
canned.push(JSON.stringify({ stat: 'ok', result: { items: [{ adToken: 'INS-FIRST' }, song(1), song(2), { adToken: 'INS-MID' }, song(3), { adToken: '' }] } }));
const list = await client.playlist('S1', 'high');
assert.deepEqual(list.map((s) => (s.isInsert ? `ins:${s.insertToken}` : s.title)), ['ins:INS-FIRST', 'Song 1', 'Song 2', 'ins:INS-MID', 'Song 3'],
  'inserts sit where Pandora put them; an empty token is dropped');
assert.equal(list[0].stationId, 'S1');
log('playlist inserts ok');

// --- insertInfo ----------------------------------------------------------------
canned.push(JSON.stringify({ stat: 'ok', result: {
  title: 'Insert Title', companyName: 'Insert Co', imageUrl: 'https://img.example/ins.png', clickThroughUrl: 'https://link.example/',
  audioUrlMap: { highQuality: { encoding: 'aacplus', audioUrl: 'https://cdn.example/ins-high.m4a' }, lowQuality: { encoding: 'mp3', audioUrl: 'https://cdn.example/ins-low.mp3' } },
  adTrackingTokens: ['TRK1', 'TRK2'] } }));
const meta = await client.insertInfo('INS-FIRST', 'high');
const req = sent.at(-1);
assert.match(req.url, /\?method=ad\.getAdMetadata&auth_token=TOKEN%2B%2F%3D1&partner_id=42&user_id=U1$/);
assert.match(req.body, /^[0-9a-f]+$/, 'the body is Blowfish hex');
assert.equal(req.body.length % 16, 0);
assert.ok(!req.body.includes('INS-FIRST'), 'nothing in plain text');
assert.deepEqual(meta, { title: 'Insert Title', artist: 'Insert Co', imageUrl: 'https://img.example/ins.png', link: 'https://link.example/',
  audioUrl: 'https://cdn.example/ins-high.m4a', audioFormat: 'aacplus', trackingTokens: ['TRK1', 'TRK2'] });
// Medium asked, only high/low there: the best available.
canned.push(JSON.stringify({ stat: 'ok', result: { title: 'T', audioUrlMap: { highQuality: { encoding: 'aacplus', audioUrl: 'https://cdn.example/h.m4a' } }, adTrackingTokens: [] } }));
assert.equal((await client.insertInfo('INS-MID', 'medium')).audioUrl, 'https://cdn.example/h.m4a');
// No audio at all: audioUrl null (the page passes over it).
canned.push(JSON.stringify({ stat: 'ok', result: { title: 'Silent' } }));
const silent = await client.insertInfo('INS-X');
assert.equal(silent.audioUrl, null);
assert.deepEqual(silent.trackingTokens, []);
log('insertInfo ok');

// --- insertPlayed ----------------------------------------------------------------
canned.push(JSON.stringify({ stat: 'ok', result: {} }));
assert.deepEqual(await client.insertPlayed('S1', ['TRK1', 'TRK2']), { registered: true });
assert.match(sent.at(-1).url, /\?method=ad\.registerAd&auth_token=TOKEN%2B%2F%3D1&partner_id=42&user_id=U1$/);
assert.match(sent.at(-1).body, /^[0-9a-f]+$/);
// Pandora errors map like any other call.
canned.push(JSON.stringify({ stat: 'fail', code: 1039, message: 'rate limited' }));
await assert.rejects(client.insertPlayed('S1', ['TRK1']), (err) => err instanceof PianoError && err.code === 1039);
// Bad requests are refused before anything is sent.
const before = sent.length;
await assert.rejects(client.insertPlayed('S1', 'not-an-array'), (err) => err instanceof PianoError && /trackingTokens/.test(err.raw));
await assert.rejects(client.call({ action: 'insertInfo' }), (err) => /token/.test(err.raw));
assert.equal(sent.length, before);
// An expired session (1001) on an insert call re-logs in like everything else.
canned.push(JSON.stringify({ stat: 'fail', code: 1001, message: 'expired' }),
  partnerBody, JSON.stringify({ stat: 'ok', result: { userId: 'U1', userAuthToken: 'TOKEN2' } }),
  JSON.stringify({ stat: 'ok', result: { stations: [{ stationId: 'S1', stationName: 'One', stationToken: 'S1', isQuickMix: false }] } }),
  JSON.stringify({ stat: 'ok', result: {} }));
assert.deepEqual(await client.insertPlayed('S1', ['TRK1']), { registered: true });
assert.match(sent.at(-1).url, /auth_token=TOKEN2&/);
assert.equal(canned.length, 0);
log('insertPlayed ok');

// The ordinary calls still work after insert calls.
canned.push(JSON.stringify({ stat: 'ok', result: { items: [song(4)] } }));
assert.deepEqual((await client.playlist('S1')).map((s) => s.title), ['Song 4']);
log('ALL OK');
