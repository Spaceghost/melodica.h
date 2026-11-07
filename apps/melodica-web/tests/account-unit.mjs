#!/usr/bin/env node
// web/account.js without a browser or network: discovery (same origin only), the
// authorize URL (PKCE S256, state), the way back (state and iss checked, code
// exchanged, address bar cleaned), refresh with rotation, invalid_grant, the policy
// (401 -> refresh -> retry once; every failure is {inserts: true}), the label, sign-out.

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const { Account, ACCOUNT_KEY, PENDING_KEY, pkceChallenge } = await import(pathToFileURL(resolve(dist, 'account.js')).href);
const log = (...a) => console.log('[account-unit]', ...a);

const ORIGIN = 'https://spacegho.st';
const mem = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), m }; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const DISCOVERY = { issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`,
  userinfo_endpoint: `${ORIGIN}/oauth/userinfo`, revocation_endpoint: `${ORIGIN}/oauth/revoke` };

// A scripted server: handlers by path; records every call.
function server(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = { path: u.pathname, method: init.method || 'GET', auth: (init.headers || {}).authorization || '', body: init.body ? new URLSearchParams(init.body) : null };
    calls.push(call);
    const h = routes[u.pathname];
    if (!h) return json({ error: 'not_found' }, 404);
    return h(call);
  };
  return { calls, fetch: fetchImpl };
}
const discovery = () => json(DISCOVERY);

// --- PKCE ------------------------------------------------------------------------
assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'RFC 7636 appendix B');

// --- discovery -----------------------------------------------------------------------
{
  const none = new Account({ origin: ORIGIN, store: mem(), session: mem(), fetch: server({}).fetch });
  assert.equal(await none.discover(), null, 'no account server (404)');
  const cross = new Account({ origin: ORIGIN, store: mem(), session: mem(), fetch: server({ '/.well-known/openid-configuration': () => json({ ...DISCOVERY, token_endpoint: 'https://evil.example/token' }) }).fetch });
  assert.equal(await cross.discover(), null, 'endpoints on another origin are refused (CSP connect-src self)');
  const wrongIss = new Account({ origin: ORIGIN, store: mem(), session: mem(), fetch: server({ '/.well-known/openid-configuration': () => json({ ...DISCOVERY, issuer: 'https://other.example' }) }).fetch });
  assert.equal(await wrongIss.discover(), null);
  let probed = 0;
  const elsewhere = new Account({ origin: 'https://music.example.org', store: mem(), session: mem(), fetch: async () => { probed += 1; return json(DISCOVERY); } });
  assert.equal(await elsewhere.discover(), null, 'a self-hosted origin has no account server');
  assert.equal(probed, 0, 'and nothing is probed there');
  const down = new Account({ origin: ORIGIN, store: mem(), session: mem(), fetch: async () => { throw new TypeError('offline'); } });
  assert.equal(await down.discover(), null);
  assert.deepEqual(await down.policy(), { inserts: true }, 'no account server: the default policy');
  log('discovery ok');
}

// --- sign-in round trip ----------------------------------------------------------------
const store = mem();
const session = mem();
let issued = 0;
const srv = server({
  '/.well-known/openid-configuration': discovery,
  '/oauth/token': (c) => {
    const g = c.body.get('grant_type');
    if (g === 'authorization_code') {
      assert.equal(c.body.get('client_id'), 'melodica-web');
      assert.equal(c.body.get('redirect_uri'), `${ORIGIN}/melodica/app/`);
      assert.equal(c.body.get('code'), 'CODE1');
      assert.equal(createHash('sha256').update(c.body.get('code_verifier')).digest('base64url'), pending.challenge, 'the verifier matches the challenge');
    } else if (g === 'refresh_token') {
      if (c.body.get('refresh_token') !== `R${issued}`) return json({ error: 'invalid_grant' }, 400);
    }
    issued += 1;
    return json({ access_token: `A${issued}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `R${issued}`, scope: 'openid profile' });
  },
  '/oauth/melodica/policy': (c) => (c.auth === `Bearer A${issued}` ? json({ playback: { plus: true }, display: { name: 'pal' } }) : json({ error: 'invalid_token' }, 401)),
  '/oauth/userinfo': () => json({ sub: 'u1', name: 'pal', email: 'pal@example.com', email_verified: true }),
  '/oauth/revoke': () => json({}),
});
let clock = 1_800_000_000_000;
const acct = new Account({ origin: ORIGIN, store, session, fetch: srv.fetch, now: () => clock });
const pending = {};
{
  const url = new URL(await acct.startUrl());
  assert.equal(url.origin + url.pathname, `${ORIGIN}/oauth/authorize`);
  const q = url.searchParams;
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), 'melodica-web');
  assert.equal(q.get('redirect_uri'), `${ORIGIN}/melodica/app/`);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.get('scope'), 'openid profile');
  const saved = JSON.parse(session.get(PENDING_KEY));
  assert.equal(saved.state, q.get('state'));
  assert.match(saved.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  pending.challenge = q.get('code_challenge');
  pending.state = q.get('state');

  // Not our round trip (no pending state match): untouched.
  const hist = { state: null, calls: [], replaceState(s, t, u) { this.calls.push(u); } };
  assert.deepEqual(await acct.finishRedirect({ search: '?code=X&state=other&iss=' + encodeURIComponent(ORIGIN), pathname: '/melodica/app/', hash: '' }, hist), { done: false, error: '' });
  assert.deepEqual(hist.calls, []);
  // Wrong issuer: refused (and the pending state is spent).
  const bad = new Account({ origin: ORIGIN, store: mem(), session: mem(), fetch: srv.fetch });
  bad.session.set(PENDING_KEY, JSON.stringify({ state: 'S', verifier: 'v'.repeat(43), redirectUri: `${ORIGIN}/melodica/app/` }));
  assert.equal((await bad.finishRedirect({ search: '?code=X&state=S&iss=https%3A%2F%2Fevil.example', pathname: '/melodica/app/', hash: '' }, hist)).error, 'wrong_issuer');
  // An error from authorize is reported and cleaned.
  const denied = new Account({ origin: ORIGIN, store: mem(), session: mem(), fetch: srv.fetch });
  denied.session.set(PENDING_KEY, JSON.stringify({ state: 'S2', verifier: 'v'.repeat(43), redirectUri: `${ORIGIN}/melodica/app/` }));
  const h2 = { state: null, calls: [], replaceState(s, t, u) { this.calls.push(u); } };
  assert.deepEqual(await denied.finishRedirect({ search: '?error=access_denied&state=S2&iss=x&api=keep', pathname: '/melodica/app/', hash: '#h' }, h2), { done: true, error: 'access_denied' });
  assert.deepEqual(h2.calls, ['/melodica/app/?api=keep#h'], 'our parameters removed, the rest kept');

  // The real way back. Like a browser's, this history rewrites the location it was
  // given, so nothing may be read from location.search after replaceState.
  const loc = { search: `?code=CODE1&state=${pending.state}&iss=${encodeURIComponent(ORIGIN)}`, pathname: '/melodica/app/', hash: '' };
  const h3 = { state: null, calls: [], replaceState(s, t, u) { this.calls.push(u); const x = new URL(u, ORIGIN); loc.search = x.search; loc.hash = x.hash; } };
  const r = await acct.finishRedirect(loc, h3);
  assert.deepEqual(r, { done: true, error: '' });
  assert.deepEqual(h3.calls, ['/melodica/app/']);
  assert.equal(session.get(PENDING_KEY), null, 'state is single use');
  const t = JSON.parse(store.get(ACCOUNT_KEY));
  assert.deepEqual(t, { access: 'A1', refresh: 'R1', expiresAt: clock + 3600_000 });
  assert.equal(acct.signedIn, true);
  log('sign-in round trip ok');
}

// --- policy, refresh, label -----------------------------------------------------------
{
  assert.deepEqual(await acct.policy(), { inserts: false });
  assert.equal(srv.calls.at(-1).auth, 'Bearer A1');
  assert.equal(acct.name, 'pal');
  // An hour later the access token is refreshed first (rotation: R1 -> R2).
  clock += 3600_000;
  assert.deepEqual(await acct.policy(), { inserts: false });
  assert.equal(JSON.parse(store.get(ACCOUNT_KEY)).refresh, 'R2');
  // A 401 on a token we believed valid: refresh and retry once.
  store.set(ACCOUNT_KEY, JSON.stringify({ ...JSON.parse(store.get(ACCOUNT_KEY)), access: 'STALE' }));
  assert.deepEqual(await acct.policy(), { inserts: false });
  assert.equal(srv.calls.filter((c) => c.path === '/oauth/melodica/policy').at(-1).auth, `Bearer A${issued}`);
  await acct.profile();
  assert.equal(acct.email, 'pal@example.com');
  assert.equal(acct.label, 'pal');
  log('policy and refresh ok');
}

// --- failures are the default policy; invalid_grant signs out ------------------------------
{
  const odd = [json({ playback: {} }), json({ nope: 1 }), new Response('<html>', { status: 200 }), json({}, 500)];
  for (const answer of odd) {
    const s = mem();
    s.set(ACCOUNT_KEY, JSON.stringify({ access: 'A', refresh: 'R', expiresAt: Date.now() + 3600_000 }));
    const a = new Account({ origin: ORIGIN, store: s, session: mem(), fetch: server({ '/.well-known/openid-configuration': discovery, '/oauth/melodica/policy': () => answer.clone() }).fetch });
    assert.deepEqual(await a.policy(), { inserts: true });
  }
  const s = mem();
  s.set(ACCOUNT_KEY, JSON.stringify({ access: 'A', refresh: 'GONE', expiresAt: 0 }));
  const a = new Account({ origin: ORIGIN, store: s, session: mem(), fetch: server({ '/.well-known/openid-configuration': discovery, '/oauth/token': () => json({ error: 'invalid_grant' }, 400) }).fetch });
  assert.deepEqual(await a.policy(), { inserts: true });
  assert.equal(s.get(ACCOUNT_KEY), null, 'invalid_grant: tokens forgotten');
  assert.equal(a.signedIn, false);
  // Labels: display name, else email, else a neutral word.
  const l = new Account({ origin: ORIGIN, store: mem(), session: mem(), fetch: srv.fetch });
  assert.equal(l.label, 'spacegho.st account');
  l.email = 'x@example.com';
  assert.equal(l.label, 'x@example.com');
  log('failure handling ok');
}

// --- sign-out ------------------------------------------------------------------------------
{
  const refreshToken = JSON.parse(store.get(ACCOUNT_KEY)).refresh;
  await acct.signOut();
  assert.equal(store.get(ACCOUNT_KEY), null);
  const rev = srv.calls.at(-1);
  assert.equal(rev.path, '/oauth/revoke');
  assert.equal(rev.body.get('token'), refreshToken);
  assert.deepEqual(await acct.policy(), { inserts: true }, 'signed out: the default policy, no request');
  assert.equal(srv.calls.at(-1).path, '/oauth/revoke');
  log('sign-out ok');
}

// --- policy with the relay's access token (no account) ----------------------------------
{
  const calls = [];
  const answers = { good: () => json({ playback: { plus: true }, display: { name: null } }), bad: () => json({ error: 'invalid_token' }, 401) };
  const relaySrv = server({
    '/.well-known/openid-configuration': discovery,
    '/oauth/melodica/policy': (c) => { calls.push(c.auth); return c.auth === 'Bearer mat.good' ? answers.good() : answers.bad(); },
  });
  const a = new Account({ origin: ORIGIN, store: mem(), session: mem(), fetch: relaySrv.fetch });
  assert.deepEqual(await a.policy(''), { inserts: true }, 'no token at all: default, no request');
  assert.deepEqual(calls, []);
  assert.deepEqual(await a.policy('mat.good'), { inserts: false }, 'relay token as the bearer');
  assert.deepEqual(calls, ['Bearer mat.good']);
  assert.deepEqual(await a.policy('mat.old'), { inserts: true }, '401 with a relay token: default, no retry');
  assert.deepEqual(calls, ['Bearer mat.good', 'Bearer mat.old']);
  // Signed in: the account's own token wins over the relay's.
  const s2 = mem();
  s2.set(ACCOUNT_KEY, JSON.stringify({ access: 'OWN', refresh: 'R', expiresAt: Date.now() + 3600_000 }));
  const b = new Account({ origin: ORIGIN, store: s2, session: mem(), fetch: relaySrv.fetch });
  await b.policy('mat.good');
  assert.equal(calls.at(-1), 'Bearer OWN');
  log('relay-token policy ok');
}
log('ALL OK');
