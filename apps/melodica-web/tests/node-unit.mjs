#!/usr/bin/env node
// Exercises the C glue without a Pandora account and without the network:
// canned Pandora-shaped responses are fed to mw_finish for partnerLogin
// (syncTime produced by tests/tools/synctime.c with the partner's key),
// userLogin, stations, playlist, feedback, search, explain and station
// mutations. Checks request building, result serialisation, error mapping
// and the automatic re-login.

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const { PianoClient, PianoError, relayMethod } = await import(pathToFileURL(resolve(dist, 'piano.js')).href);

const log = (...a) => console.log('[unit]', ...a);
const client = new PianoClient({ apiBase: 'https://relay.example/api/', fetch: () => { throw new Error('no network in unit test'); } });
await client.load();

// Blowfish("XXXX1762300000") under the partner's incoming key; see tests/tools/synctime.c.
const partnerBody = JSON.stringify({ stat: 'ok', result: {
  partnerId: '42', partnerAuthToken: 'CANNED+PARTNER/TOKEN==', syncTime: 'c1c474e9d63e974583a750b7e57453c4',
  stationSkipLimit: 6, stationSkipUnit: 'hour' } });

// --- login: canned partnerLogin and userLogin -----------------------------
let req = client.begin({ action: 'login', user: 'unit@example.invalid', password: 'pw' });
assert.equal(req.ok, true);
assert.match(req.urlPath, /method=auth\.partnerLogin$/);
let reply = client.finish(partnerBody);
assert.equal(reply.ok, true, reply.error);
assert.equal(reply.continue, true);
req = client.continueRequest();
assert.match(req.urlPath, /method=auth\.userLogin&auth_token=CANNED%2BPARTNER%2FTOKEN%3D%3D&partner_id=42$/);
assert.match(req.postData, /^[0-9a-f]+$/, 'userLogin body is Blowfish hex');
reply = client.finish(JSON.stringify({ stat: 'ok', result: { userId: 'U1', userAuthToken: 'TOKEN+/=1' } }));
assert.equal(reply.ok, true);
assert.equal(reply.result.userId, 'U1');
assert.equal(client.loggedIn, true);
log('login ok');

// --- error mapping --------------------------------------------------------
req = client.begin({ action: 'stations' });
assert.equal(req.ok, true);
assert.match(req.urlPath, /method=user\.getStationList&auth_token=TOKEN%2B%2F%3D1&partner_id=\d+&user_id=U1$/);
reply = client.finish(JSON.stringify({ stat: 'fail', code: 1001, message: 'Invalid auth token' }));
assert.equal(reply.ok, false);
assert.equal(reply.code, 1001);
assert.equal(reply.status, 1024 + 1001);
assert.equal(new PianoError(reply).needsRelogin, true);
reply = client.finish('garbage');
assert.equal(reply.ok, false, 'finish without a pending request must fail cleanly');
log('error mapping ok');

// --- stations -------------------------------------------------------------
const stationsBody = {
  stat: 'ok',
  result: {
    stations: [
      { stationName: 'QuickMix', stationToken: 'QM', isQuickMix: true, quickMixStationIds: ['S2'] },
      { stationName: 'Jazz "Late" Night', stationToken: 'S1', isShared: false },
      { stationName: 'Ünïcödé 🎵', stationToken: 'S2', isShared: true },
    ],
  },
};
req = client.begin({ action: 'stations' });
reply = client.finish(JSON.stringify(stationsBody));
assert.equal(reply.ok, true, reply.error);
assert.equal(reply.result.stations.length, 3);
assert.deepEqual(reply.result.stations.map((s) => s.id), ['QM', 'S1', 'S2']);
assert.equal(reply.result.stations[1].name, 'Jazz "Late" Night');
assert.equal(reply.result.stations[2].name, 'Ünïcödé 🎵');
assert.equal(reply.result.stations[0].isQuickMix, true);
assert.equal(reply.result.stations[2].useQuickMix, true);
assert.equal(reply.result.stations[1].isCreator, true);
// Refetch must replace, not append.
req = client.begin({ action: 'stations' });
reply = client.finish(JSON.stringify(stationsBody));
assert.equal(reply.result.stations.length, 3);
assert.equal(client.cachedStations().length, 3);
log('stations ok');

// --- playlist -------------------------------------------------------------
const song = (n) => ({
  artistName: `Artist ${n}`, albumName: `Album ${n}`, songName: `Song\t${n}\n"quoted"\\`,
  trackToken: `TT${n}`, stationId: 'S1', albumArtUrl: `https://img.example/${n}.jpg`,
  songDetailUrl: `https://www.pandora.com/song/${n}`, trackGain: '-3.5', trackLength: 200 + n,
  songRating: n === 1 ? 1 : 0,
  audioUrlMap: {
    highQuality: { encoding: 'aacplus', audioUrl: `https://audio.example/high/${n}.mp4?x=1&y=2`, bitrate: '64' },
    mediumQuality: { encoding: 'aacplus', audioUrl: `https://audio.example/med/${n}.mp4`, bitrate: '64' },
    lowQuality: { encoding: 'aacplus', audioUrl: `https://audio.example/low/${n}.mp4`, bitrate: '32' },
  },
});
const playlistBody = { stat: 'ok', result: { items: [song(1), { adToken: 'ad' }, song(2), song(3)] } };
req = client.begin({ action: 'playlist', stationId: 'S1', quality: 'high' });
assert.equal(req.ok, true, req.error);
assert.match(req.urlPath, /method=station\.getPlaylist&auth_token=/);
assert.match(req.postData, /^[0-9a-f]+$/);
reply = client.finish(JSON.stringify(playlistBody));
assert.equal(reply.ok, true, reply.error);
const songs = reply.result.songs;
assert.equal(songs.length, 3, 'playlist contains playable songs');
assert.equal(songs[0].title, 'Song\t1\n"quoted"\\');
assert.equal(songs[0].audioUrl, 'https://audio.example/high/1.mp4?x=1&y=2');
assert.equal(songs[0].audioFormat, 'aacplus');
assert.equal(songs[0].duration, 201);
assert.equal(songs[0].rating, 1);
assert.equal(songs[1].rating, 0);
assert.equal(songs[0].coverArt, 'https://img.example/1.jpg');
assert.equal(songs[0].stationId, 'S1');
assert.ok(Math.abs(songs[0].fileGain - -3.5) < 1e-6);
req = client.begin({ action: 'playlist', stationId: 'NOPE' });
assert.equal(req.ok, false);
// quality unavailable
req = client.begin({ action: 'playlist', stationId: 'S1', quality: 'high' });
const noHigh = JSON.parse(JSON.stringify(playlistBody));
delete noHigh.result.items[0].audioUrlMap.highQuality;
reply = client.finish(JSON.stringify(noHigh));
assert.equal(reply.ok, false);
assert.equal(reply.status, 6);
log('playlist ok');

// --- feedback / tired / explain -------------------------------------------
req = client.begin({ action: 'rate', trackToken: 'TT2', stationId: 'S1', rating: 'love' });
assert.equal(req.ok, true, req.error);
assert.match(req.urlPath, /method=station\.addFeedback&/);
reply = client.finish(JSON.stringify({ stat: 'ok', result: { feedbackId: 'F1', isPositive: true } }));
assert.equal(reply.ok, true, reply.error);
assert.equal(reply.result.rating, 1);
req = client.begin({ action: 'rate', trackToken: 'TT2', stationId: 'S1', rating: 'ban' });
reply = client.finish(JSON.stringify({ stat: 'ok', result: {} }));
assert.equal(reply.result.rating, 2);
// unknown token (not in the current playlist) falls back to a stand-in song
req = client.begin({ action: 'rate', trackToken: 'STALE', stationId: 'S1', rating: 'love' });
assert.equal(req.ok, true, req.error);
reply = client.finish(JSON.stringify({ stat: 'ok', result: {} }));
assert.equal(reply.ok, true);
req = client.begin({ action: 'tired', trackToken: 'TT3', stationId: 'S1' });
assert.match(req.urlPath, /method=user\.sleepSong&/);
reply = client.finish(JSON.stringify({ stat: 'ok', result: {} }));
assert.equal(reply.result.rating, 3);
req = client.begin({ action: 'explain', trackToken: 'TT1', stationId: 'S1' });
assert.match(req.urlPath, /method=track\.explainTrack&/);
reply = client.finish(JSON.stringify({ stat: 'ok', result: { explanations: [
  { focusTraitName: 'a subtle use of vocal harmony' }, { focusTraitName: 'mild rhythmic syncopation' }] } }));
assert.equal(reply.ok, true, reply.error);
assert.match(reply.result.explanation, /vocal harmony/);
log('feedback, tired, explain ok');

// --- search / create / delete ---------------------------------------------
req = client.begin({ action: 'search', query: 'miles "davis" \\ ü' });
assert.match(req.urlPath, /method=music\.search&/);
reply = client.finish(JSON.stringify({ stat: 'ok', result: {
  artists: [{ artistName: 'Miles Davis', musicToken: 'R1', score: 100, likelyMatch: true }],
  songs: [{ songName: 'So What', artistName: 'Miles Davis', musicToken: 'S9', score: 90 }],
} }));
assert.equal(reply.ok, true, reply.error);
assert.equal(reply.result.artists[0].musicId, 'R1');
assert.equal(reply.result.songs[0].title, 'So What');
req = client.begin({ action: 'createStation', token: 'R1' });
assert.match(req.urlPath, /method=station\.createStation&/);
reply = client.finish(JSON.stringify({ stat: 'ok', result: { stationName: 'Miles Davis Radio', stationToken: 'S3' } }));
assert.equal(reply.ok, true, reply.error);
assert.equal(reply.result.stations.length, 4);
req = client.begin({ action: 'deleteStation', stationId: 'S3' });
assert.match(req.urlPath, /method=station\.deleteStation&/);
reply = client.finish(JSON.stringify({ stat: 'ok', result: {} }));
assert.equal(reply.ok, true, reply.error);
assert.equal(reply.result.stations.length, 3);
log('search, create, delete ok');

// --- high-level client wrappers with a fake fetch ---------------------------
let calls = 0;
let expiredOnce = false;
const fake = new PianoClient({ apiBase: 'https://relay.example/api/', fetch: async (url, init) => {
  calls += 1;
  assert.ok(url.startsWith('https://relay.example/api/?method='), url);
  assert.equal(init.method, 'POST');
  const method = new URL(url).searchParams.get('method');
  if (method === 'user.getStationList' && !expiredOnce) {
    expiredOnce = true;
    return new Response(JSON.stringify({ stat: 'fail', code: 1001, message: 'expired' }));
  }
  if (method === 'auth.partnerLogin') return new Response(partnerBody);
  if (method === 'auth.userLogin') return new Response(JSON.stringify({ stat: 'ok', result: { userId: 'U2', userAuthToken: 'T2' } }));
  if (method === 'user.getStationList') return new Response(JSON.stringify(stationsBody));
  throw new Error(`unexpected ${method}`);
} });
await fake.load();
await fake.login('a@b.c', 'pw');
const list = await fake.stations();        // first answer is 1001 -> relogin -> retry
assert.equal(list.length, 3);
assert.equal(calls, 6, `expected relogin round trips, got ${calls}`);
log('client re-login on 1001 ok');

// --- relay access token (docs/ACCOUNT.md): x-melodica-access after userLogin -------------
{
  const seen = [];
  let tokenN = 0;
  let expireNext = false;
  let heard = [];
  const relayed = new PianoClient({ apiBase: 'https://relay.example/api/', onAccess: (t) => heard.push(t), fetch: async (url, init) => {
    const method = new URL(url).searchParams.get('method');
    const token = init.headers['x-melodica-access'] || '';
    seen.push({ method, token });
    if (method === 'auth.partnerLogin') return new Response(partnerBody);
    if (method === 'auth.userLogin') {
      tokenN += 1;
      return new Response(JSON.stringify({ stat: 'ok', result: { userId: 'U2', userAuthToken: 'T2' } }), { headers: { 'x-melodica-access': `tok${tokenN}` } });
    }
    if (expireNext || token !== `tok${tokenN}`) {
      expireNext = false;
      return new Response(JSON.stringify({ stat: 'fail', code: -1, message: 'melodica access is by allow-list; signing in sends your email to the admin as an access request.' }), { status: 401 });
    }
    if (method === 'user.getStationList') return new Response(JSON.stringify(stationsBody));
    throw new Error(`unexpected ${method}`);
  } });
  await relayed.load();
  await relayed.login('a@b.c', 'pw');
  assert.equal(relayed.accessToken, 'tok1');
  assert.deepEqual(heard, ['tok1'], 'onAccess hears the new token');
  assert.deepEqual(seen.map((c) => [c.method, c.token]), [['auth.partnerLogin', ''], ['auth.userLogin', '']], 'auth.* calls carry no token');
  seen.length = 0;
  assert.equal((await relayed.stations()).length, 3);
  assert.deepEqual(seen.map((c) => [c.method, c.token]), [['user.getStationList', 'tok1']], 'later calls carry the token');
  // Expired token (401): log in again, get a new token, retry once.
  seen.length = 0;
  expireNext = true;
  assert.equal((await relayed.stations()).length, 3);
  assert.deepEqual(seen.map((c) => [c.method, c.token]), [
    ['user.getStationList', 'tok1'], ['auth.partnerLogin', ''], ['auth.userLogin', ''],
    ['user.getStationList', 'tok2'],
  ], '401 -> re-login -> retry with the new token');
  assert.deepEqual(heard, ['tok1', 'tok2']);
  relayed.logout();
  assert.equal(relayed.accessToken, '', 'logout forgets the token');

  // Not on the allow-list: 403 with the relay's message, shown as is; no token.
  const refused = new PianoClient({ apiBase: 'https://relay.example/api/', fetch: async (url) => {
    const method = new URL(url).searchParams.get('method');
    if (method === 'auth.partnerLogin') return new Response(partnerBody);
    return new Response(JSON.stringify({ stat: 'fail', code: -1, message: 'melodica access is by allow-list. Your request has been sent.' }), { status: 403 });
  } });
  await refused.load();
  await assert.rejects(refused.login('x@y.z', 'pw'), (err) => err.message === 'melodica access is by allow-list. Your request has been sent.' && err.kind === 'access');
  assert.equal(refused.accessToken, '');
  assert.equal(relayMethod('/services/json/?method=auth.userLogin&partner_id=1'), 'auth.userLogin');
  assert.equal(relayMethod('/x?a=1'), '');
  log('relay access token ok');
}

// --- the Pandora session out of and back into the wasm client (docs/BRIDGE.md 4.1) ---
{
  const seen = [];
  const mk = () => new PianoClient({ apiBase: 'https://relay.example/api/', fetch: async (url, init) => {
    const u = new URL(url);
    const method = u.searchParams.get('method');
    seen.push({ method, auth: u.searchParams.get('auth_token'), user: u.searchParams.get('user_id'), partner: u.searchParams.get('partner_id') });
    if (method === 'auth.partnerLogin') return new Response(partnerBody);
    if (method === 'auth.userLogin') return new Response(JSON.stringify({ stat: 'ok', result: { userId: 'U9', userAuthToken: 'USER+TOKEN/9==' } }));
    if (method === 'user.getStationList') return new Response(JSON.stringify(stationsBody));
    throw new Error(`unexpected ${method}`);
  }, onSession: () => { sessions += 1; } });
  let sessions = 0;
  const a = mk();
  await a.load();
  assert.equal(a.session(), null, 'no session before a login');
  await a.login('a@b.c', 'pw');
  assert.equal(sessions, 1, 'onSession after the login');
  const s = a.session();
  assert.deepEqual(s.partner, { authToken: 'CANNED+PARTNER/TOKEN==', id: 42 });
  assert.deepEqual(s.user, { authToken: 'USER+TOKEN/9==', id: 'U9' });
  assert.equal(typeof s.syncOffset, 'number');
  // A second client resumes it: no login, the same tokens on the next call.
  const b = mk();
  await b.load();
  assert.equal(b.restore(s), true);
  assert.equal(b.loggedIn, true);
  assert.deepEqual(b.session(), s, 'what goes in comes out');
  seen.length = 0;
  assert.equal((await b.stations()).length, 3);
  assert.deepEqual(seen.map((x) => x.method), ['user.getStationList'], 'no login round trip');
  assert.equal(seen[0].auth, 'USER+TOKEN/9==');
  assert.equal(seen[0].user, 'U9');
  assert.equal(seen[0].partner, '42');
  // Malformed sessions are refused and leave the client logged out.
  const c = mk();
  await c.load();
  assert.equal(c.restore({ partner: { authToken: 'P', id: 1 }, user: { authToken: '', id: 'x' } }), false);
  assert.equal(c.loggedIn, false);
  assert.equal(c.restore(null), false);
  log('session export and restore ok');
}

// --- churn: no crash across many cycles (memory growth sanity) -------------
for (let i = 0; i < 300; i++) {
  req = client.begin({ action: 'playlist', stationId: 'S1', quality: 'medium' });
  reply = client.finish(JSON.stringify(playlistBody));
  assert.equal(reply.ok, true);
}
log('300 playlist cycles ok; heap', (client.module.HEAPU8 ? client.module.HEAPU8.length : '?'), 'bytes');
log('ALL OK');
