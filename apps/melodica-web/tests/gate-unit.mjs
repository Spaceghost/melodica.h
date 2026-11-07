#!/usr/bin/env node
// The GitHub gate's client side without a browser or network: fragment parsing,
// the unverified claims decode, taking the token off the URL into storage, every
// /auth/me outcome (503 off, 401 anonymous, allowed, denied, refreshed token,
// unreachable), start URL and sign-out. Then PianoClient's side of it: the
// Authorization header on relay requests, and a 401 (relay or bridge) becoming a
// PianoError of kind 'auth' that fires onUnauthorized.

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const { GithubGate, parseHash, decodeClaims, looksLikeToken, TOKEN_KEY } = await import(pathToFileURL(resolve(dist, 'gate.js')).href);

const log = (...a) => console.log('[gate-unit]', ...a);
const b64url = (s) => Buffer.from(s).toString('base64url');
const mk = (claims) => `${b64url(JSON.stringify(claims))}.${b64url('fake-mac-32-bytes-0123456789abcd')}`;
const ALLOWED = mk({ sub: 'alice', id: 1, friend: true, iat: 1, exp: 2, chk: 1 });
const DENIED_TOKEN = mk({ sub: 'bob', id: 2, friend: false, iat: 1, exp: 2, chk: 1 });

function memStore() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), m };
}

// --- parseHash / decodeClaims ---------------------------------------------------
assert.deepEqual(parseHash(''), { token: '', error: '', rest: '' });
assert.deepEqual(parseHash('#'), { token: '', error: '', rest: '' });
assert.deepEqual(parseHash(`#melodica_token=${ALLOWED}`), { token: ALLOWED, error: '', rest: '' });
assert.deepEqual(parseHash(`#x=1&melodica_token=${ALLOWED}&y=2`), { token: ALLOWED, error: '', rest: 'x=1&y=2' });
assert.deepEqual(parseHash('#melodica_error=access_denied'), { token: '', error: 'access_denied', rest: '' });
assert.deepEqual(parseHash('#melodica_token=not a token'), { token: '', error: '', rest: '' }, 'junk is not a token');
assert.deepEqual(parseHash('#station=42'), { token: '', error: '', rest: 'station=42' });
assert.equal(looksLikeToken(ALLOWED), true);
assert.equal(looksLikeToken('a.b.c'), false);
assert.equal(looksLikeToken('nodot'), false);
assert.equal(decodeClaims(ALLOWED).sub, 'alice');
assert.equal(decodeClaims(ALLOWED).friend, true);
assert.equal(decodeClaims('zz.zz'), null);
assert.equal(decodeClaims(`${b64url('[1]')}.x`), null, 'claims must be an object with sub');
log('parseHash/decodeClaims ok');

// --- takeTokenFromHash ------------------------------------------------------------
{
  const store = memStore();
  const gate = new GithubGate({ authBase: 'https://spacegho.st/melodica/auth/', store, fetch: () => { throw new Error('no network'); } });
  const replaced = [];
  const history = { state: { s: 1 }, replaceState: (st, _t, url) => replaced.push({ st, url }) };
  const location = { hash: `#melodica_token=${ALLOWED}`, pathname: '/melodica/app/', search: '?q=1' };
  assert.deepEqual(gate.takeTokenFromHash(location, history), { token: ALLOWED, error: '' });
  assert.equal(store.get(TOKEN_KEY), ALLOWED);
  assert.deepEqual(replaced, [{ st: { s: 1 }, url: '/melodica/app/?q=1' }], 'fragment cleaned, query kept, no navigation');
  assert.equal(gate.token, ALLOWED);

  // An error code: nothing stored, URL cleaned, error reported.
  const store2 = memStore();
  const g2 = new GithubGate({ authBase: 'https://spacegho.st/melodica/auth/', store: store2, fetch: () => {} });
  const r2 = [];
  assert.deepEqual(g2.takeTokenFromHash({ hash: '#melodica_error=access_denied&keep=1', pathname: '/melodica/app/', search: '' }, { state: null, replaceState: (_s, _t, u) => r2.push(u) }), { token: '', error: 'access_denied' });
  assert.equal(store2.get(TOKEN_KEY), null);
  assert.deepEqual(r2, ['/melodica/app/#keep=1']);

  // Nothing of ours in the hash: untouched.
  const r3 = [];
  assert.deepEqual(g2.takeTokenFromHash({ hash: '#other', pathname: '/melodica/app/', search: '' }, { state: null, replaceState: (_s, _t, u) => r3.push(u) }), { token: '', error: '' });
  assert.deepEqual(r3, []);

  // A broken replaceState does not lose the token.
  const store4 = memStore();
  const g4 = new GithubGate({ authBase: 'x/', store: store4, fetch: () => {} });
  g4.takeTokenFromHash({ hash: `#melodica_token=${ALLOWED}`, pathname: '/', search: '' }, { replaceState: () => { throw new Error('sandboxed'); } });
  assert.equal(store4.get(TOKEN_KEY), ALLOWED);
  log('takeTokenFromHash ok');
}

assert.equal(new GithubGate({ authBase: 'https://spacegho.st/melodica/auth/', store: memStore() }).startUrl('https://spacegho.st/melodica/app/'),
  'https://spacegho.st/melodica/auth/start?return_to=https%3A%2F%2Fspacegho.st%2Fmelodica%2Fapp%2F');

// --- check(): every outcome -------------------------------------------------------
function fakeMe(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: (init.headers || {}).authorization || '' });
    return handler(url, init);
  };
  return { calls, fetch: fetchImpl };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

{
  // 503: the gate is not configured.
  const f = fakeMe(() => json({ error: 'auth not configured' }, 503));
  const gate = new GithubGate({ authBase: 'https://spacegho.st/melodica/auth/', store: memStore(), fetch: f.fetch });
  const r = await gate.check();
  assert.equal(r.status, 'off');
  assert.deepEqual(f.calls, [{ url: 'https://spacegho.st/melodica/auth/me', method: 'GET', auth: '' }], 'no token: no Authorization header');

  // 401 without a token: anonymous.
  const f2 = fakeMe(() => json({ error: 'missing token' }, 401));
  assert.equal((await new GithubGate({ authBase: 'a/', store: memStore(), fetch: f2.fetch }).check()).status, 'anonymous');

  // 401 with a token: the token is forgotten.
  const store = memStore();
  store.set(TOKEN_KEY, ALLOWED);
  const f3 = fakeMe(() => json({ error: 'invalid or expired token' }, 401));
  const g3 = new GithubGate({ authBase: 'a/', store, fetch: f3.fetch });
  const r3 = await g3.check();
  assert.equal(r3.status, 'anonymous');
  assert.equal(r3.reason, 'rejected');
  assert.equal(store.get(TOKEN_KEY), null, 'rejected token removed');
  assert.equal(f3.calls[0].auth, `Bearer ${ALLOWED}`);

  // Allowed.
  const s4 = memStore(); s4.set(TOKEN_KEY, ALLOWED);
  const f4 = fakeMe(() => json({ login: 'alice', friend: true, exp: 2, checked_at: 1 }));
  const r4 = await new GithubGate({ authBase: 'a/', store: s4, fetch: f4.fetch }).check();
  assert.deepEqual(r4, { status: 'allowed', token: ALLOWED, login: 'alice', allowed: true, stale: false, checkedAt: 1 });

  // Not allowed, stale verdict reported.
  const s5 = memStore(); s5.set(TOKEN_KEY, DENIED_TOKEN);
  const f5 = fakeMe(() => json({ login: 'bob', friend: false, exp: 2, checked_at: 1, stale: true }));
  const r5 = await new GithubGate({ authBase: 'a/', store: s5, fetch: f5.fetch }).check();
  assert.equal(r5.status, 'denied');
  assert.equal(r5.login, 'bob');
  assert.equal(r5.stale, true);

  // A refreshed token from /auth/me replaces the stored one.
  const s6 = memStore(); s6.set(TOKEN_KEY, DENIED_TOKEN);
  const f6 = fakeMe(() => json({ login: 'bob', friend: true, exp: 3, checked_at: 2, token: ALLOWED }));
  const r6 = await new GithubGate({ authBase: 'a/', store: s6, fetch: f6.fetch }).check();
  assert.equal(r6.status, 'allowed');
  assert.equal(r6.token, ALLOWED);
  assert.equal(s6.get(TOKEN_KEY), ALLOWED);

  // Unreachable or odd answers: unknown, token kept (the relay decides).
  const s7 = memStore(); s7.set(TOKEN_KEY, ALLOWED);
  const r7 = await new GithubGate({ authBase: 'a/', store: s7, fetch: async () => { throw new TypeError('Failed to fetch'); } }).check();
  assert.equal(r7.status, 'unknown');
  assert.equal(s7.get(TOKEN_KEY), ALLOWED);
  assert.equal((await new GithubGate({ authBase: 'a/', store: memStore(), fetch: async () => new Response('nope', { status: 404 }) }).check()).status, 'unknown');
  assert.equal((await new GithubGate({ authBase: 'a/', store: memStore(), fetch: async () => new Response('<html>', { status: 200 }) }).check()).status, 'unknown', 'a non-JSON 200 is unknown (the relay decides)');

  // A junk value in storage is not a token.
  const s8 = memStore(); s8.set(TOKEN_KEY, 'garbage');
  assert.equal(new GithubGate({ authBase: 'a/', store: s8 }).token, '');
  log('check() ok');
}

// --- signOut ------------------------------------------------------------------------
{
  const store = memStore(); store.set(TOKEN_KEY, ALLOWED);
  const f = fakeMe(() => json({ ok: true }));
  const gate = new GithubGate({ authBase: 'https://spacegho.st/melodica/auth/', store, fetch: f.fetch });
  await gate.signOut();
  assert.equal(store.get(TOKEN_KEY), null);
  assert.deepEqual(f.calls, [{ url: 'https://spacegho.st/melodica/auth/logout', method: 'POST', auth: `Bearer ${ALLOWED}` }]);
  await gate.signOut(); // idempotent, no second call
  assert.equal(f.calls.length, 1);
  const failing = new GithubGate({ authBase: 'a/', store: (() => { const s = memStore(); s.set(TOKEN_KEY, ALLOWED); return s; })(), fetch: async () => { throw new Error('offline'); } });
  await failing.signOut(); // a failed courtesy call is not an error
  log('signOut ok');
}

// --- PianoClient: Authorization header and the 401 path -------------------------------
{
  const { PianoClient, PianoError } = await import(pathToFileURL(resolve(dist, 'piano.js')).href);
  const { BridgeTransport } = await import(pathToFileURL(resolve(dist, 'bridge.js')).href);
  const req = { urlPath: '/services/json/?method=auth.partnerLogin', postData: 'deadbeef' };
  const DENIED = { stat: 'fail', code: -1, message: 'melodica is not available for this account: sign in with GitHub' };

  const seen = [];
  const relay = async (url, init) => {
    seen.push(init.headers);
    return init.headers.authorization === `Bearer ${ALLOWED}` ? new Response('{"stat":"ok"}') : json(DENIED, 401);
  };
  const fired = [];
  const client = new PianoClient({ apiBase: 'https://spacegho.st/melodica/api/', fetch: relay, onUnauthorized: (e) => fired.push(e) });
  await assert.rejects(client.post(req), (err) => err instanceof PianoError && err.kind === 'auth' && err.message === DENIED.message);
  assert.equal(seen[0].authorization, undefined, 'no token: no header');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].kind, 'auth');
  assert.equal(fired[0].badCredentials, false, 'not a Pandora password problem');
  assert.equal(fired[0].needsRelogin, false);

  client.authToken = ALLOWED;
  assert.equal(await client.post(req), '{"stat":"ok"}');
  assert.equal(seen[1].authorization, `Bearer ${ALLOWED}`);
  assert.equal(seen[1]['content-type'], 'text/plain');

  // A non-JSON 401 still becomes an auth error with a generic message.
  const plain = new PianoClient({ apiBase: 'https://r/api/', fetch: async () => new Response('Unauthorized', { status: 401 }) });
  await assert.rejects(plain.post(req), (err) => err.kind === 'auth' && /signing in with GitHub/.test(err.message));

  // Through the bridge: a 401 answer is the same auth error and is final (no relay fallback).
  const listeners = new Set();
  const win = {
    location: { origin: 'https://spacegho.st' },
    addEventListener: (t, fn) => { if (t === 'message') listeners.add(fn); },
    removeEventListener: (t, fn) => listeners.delete(fn),
    postMessage(data) { for (const fn of [...listeners]) fn({ source: win, origin: 'https://spacegho.st', data }); },
  };
  const relayCalls = [];
  const bridged = new PianoClient({ apiBase: 'https://r/api/', fetch: async () => { relayCalls.push(1); return new Response('{"stat":"ok"}'); }, onUnauthorized: (e) => fired.push(e) });
  bridged.bridge = new BridgeTransport(win, { timeout: 200 }).start();
  win.postMessage({ melodica: 1, type: 'ready', name: 'melodica extension', version: '0.2.0' });
  const answer401 = (ev) => {
    const d = ev.data;
    if (d && d.melodica === 1 && d.type === 'request') {
      setTimeout(() => win.postMessage({ melodica: 1, type: 'response', id: d.id, ok: false, status: 401, body: new TextEncoder().encode(JSON.stringify(DENIED)) }), 0);
    }
  };
  listeners.add(answer401);
  await assert.rejects(bridged.post(req), (err) => err.kind === 'auth' && err.message === DENIED.message);
  assert.equal(relayCalls.length, 0, 'no fallback to the relay on 401');
  assert.equal(fired.length, 2);
  log('PianoClient auth header and 401 ok');
}

log('ALL OK');
