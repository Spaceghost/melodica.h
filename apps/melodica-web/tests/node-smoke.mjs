#!/usr/bin/env node
// Runs the compiled module in Node against the live relay.
//
// Part 1 (always): partnerLogin through the relay must succeed and the
// module must then produce an encrypted auth.userLogin request. No Pandora
// account needed.
//
// Part 2 (only with PANDORA_USER and PANDORA_PASSWORD set): log in, list
// stations, fetch a playlist and HEAD the first audio URL.
//
// Env: MELODICA_API (default https://spacegho.st/melodica/api/),
//      MELODICA_DIST (default ../dist relative to this file),
//      MELODICA_RELAY_TOKEN (access token for the gated relay; without it a
//      401 from the relay ends part 1 as "not provable here", with a log line).

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const apiBase = process.env.MELODICA_API || 'https://spacegho.st/melodica/api/';

const { PianoClient, PIANO_RPC_PREFIX } = await import(pathToFileURL(resolve(dist, 'piano.js')).href);

const log = (...a) => console.log('[smoke]', ...a);
const token = process.env.MELODICA_RELAY_TOKEN || '';
const client = new PianoClient({ apiBase, authToken: token, log: (m) => log(' ', m) });
await client.load();
log(`module loaded: melodica.h compat ${client.version}, relay ${apiBase}${token ? ' (with MELODICA_RELAY_TOKEN)' : ''}`);

// ---- Part 1: partner login through the relay, no account needed ----------
const req1 = client.begin({ action: 'login', user: 'nobody@example.invalid', password: 'not-a-password' });
assert.equal(req1.ok, true, `begin login failed: ${req1.error}`);
assert.ok(req1.urlPath.startsWith(`${PIANO_RPC_PREFIX}method=auth.partnerLogin`), req1.urlPath);
assert.equal(req1.secure, true);
assert.ok(req1.postData.includes('"android"'), 'partnerLogin body carries the partner username');
log('step 1 request:', req1.urlPath);

let body1;
try {
  body1 = await client.post(req1);
} catch (err) {
  // Cloudflare in front of the relay challenges some datacenter clients
  // (GitHub Actions runners get a "Just a moment..." page). That says
  // nothing about the module; in CI treat it as "not provable here".
  const challenged = err.kind === 'relay' && /Just a moment|cf-chl|challenge/i.test(err.raw || '');
  if (challenged && process.env.MELODICA_SMOKE_ALLOW_RELAY_BLOCK === '1') {
    log('WARNING: the relay answered with a Cloudflare challenge page from this network;');
    log('         the live partnerLogin could not be exercised here (MELODICA_SMOKE_ALLOW_RELAY_BLOCK=1).');
    process.exit(0);
  }
  if (err.kind === 'auth' && !token) {
    log(`WARNING: the relay answered HTTP 401: ${err.message}`);
    log('         The relay requires a GitHub sign-in token and MELODICA_RELAY_TOKEN is not set, so the live partnerLogin');
    log('         could not be exercised here. Mint a token with melodica-site/scripts/mint-token.mjs and');
    log('         add it as the MELODICA_RELAY_TOKEN repository secret.');
    process.exit(0);
  }
  throw err;
}
log('relay reply:', body1.slice(0, 120).replace(/\s+/g, ' ') + (body1.length > 120 ? '…' : ''));
const reply1 = client.finish(body1);
assert.equal(reply1.ok, true, `partnerLogin failed: status ${reply1.status} code ${reply1.code} ${reply1.error}`);
assert.equal(reply1.continue, true, 'partnerLogin must ask for the userLogin step');
log('partnerLogin ok; continue =', reply1.continue);

const req2 = client.continueRequest();
assert.equal(req2.ok, true, `continue failed: ${req2.error}`);
assert.ok(req2.urlPath.startsWith(`${PIANO_RPC_PREFIX}method=auth.userLogin&auth_token=`), req2.urlPath);
assert.match(req2.urlPath, /&partner_id=\d+$/);
assert.equal(req2.secure, true);
assert.match(req2.postData, /^[0-9a-f]+$/, 'userLogin body must be Blowfish-encrypted hex');
assert.equal(req2.postData.length % 16, 0, 'Blowfish output is whole 8-byte blocks');
assert.ok(!req2.postData.includes('nobody@example'), 'plaintext must not leak into the body');
log('step 2 request:', req2.urlPath.replace(/auth_token=[^&]+/, 'auth_token=<redacted>'));
log(`step 2 body: ${req2.postData.length} hex chars of Blowfish ciphertext`);
log('PART 1 OK: partnerLogin through the relay succeeded; userLogin request is encrypted.');

// ---- Part 2: real account ---------------------------------------------
const user = process.env.PANDORA_USER;
const password = process.env.PANDORA_PASSWORD;
if (!user || !password) {
  log('PART 2 SKIPPED: set PANDORA_USER and PANDORA_PASSWORD to test login, stations, playlist and audio.');
  process.exit(0);
}

client.fn.init();  // drop the half-finished fake login
const who = await client.login(user, password);
assert.ok(who.loggedIn, 'login did not yield a user auth token');
log('logged in; userId', who.userId);

const stations = await client.stations();
assert.ok(Array.isArray(stations) && stations.length > 0, 'no stations');
log(`stations: ${stations.length}; first: ${stations[0].name}`);

const station = stations.find((s) => !s.isQuickMix) || stations[0];
const songs = await client.playlist(station.id, 'high');
assert.ok(songs.length > 0, 'empty playlist');
const song = songs[0];
log(`playlist for ${station.name}: ${songs.length} songs; first: ${song.artist} – ${song.title} (${song.audioFormat}, ${song.duration}s)`);
assert.match(song.audioUrl, /^https?:\/\//, 'audioUrl is not absolute');
assert.ok(song.trackToken, 'missing trackToken');

let head = await fetch(song.audioUrl, { method: 'HEAD' });
if (!head.ok) head = await fetch(song.audioUrl, { headers: { range: 'bytes=0-0' } });
assert.ok(head.ok, `audio URL answered HTTP ${head.status}`);
log(`audio HEAD ${head.status} content-type=${head.headers.get('content-type')} length=${head.headers.get('content-length')}`);
log('PART 2 OK: login, stations, playlist and audio URL all work.');
