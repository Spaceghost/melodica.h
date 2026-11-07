// Unit test of the spacegho.st account helpers (src/account.imba, bundled for Node by
// scripts/build.mjs as build/node/account.js): PKCE, the authorize URL, the redirect
// check, token storage, the policy answer and the account label.
//   node tests/account.test.mjs
import { createHash } from 'node:crypto';
import {
  normalizeAccountBase, randomString, pkceChallenge, authorizeUrl, parseRedirect, storedTokens,
  accessFresh, policyFrom, accountLabel, jwtClaims, ACCOUNT_BASE, CLIENT_ID, SCOPE,
} from '../build/node/account.js';

let n = 0;
const eq = (a, b, what) => {
  n++;
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error(`FAIL ${what}: ${A} !== ${B}`); process.exit(1); }
};

// Base: https anywhere, http only on localhost, junk falls back to spacegho.st.
eq(normalizeAccountBase(''), ACCOUNT_BASE, 'empty base');
eq(normalizeAccountBase('https://auth.example/x/'), 'https://auth.example', 'https origin');
eq(normalizeAccountBase('http://localhost:8790/'), 'http://localhost:8790', 'http localhost');
eq(normalizeAccountBase('http://evil.example'), ACCOUNT_BASE, 'plain http elsewhere refused');
eq(normalizeAccountBase('not a url'), ACCOUNT_BASE, 'junk');

// PKCE S256: base64url(SHA-256(verifier)), the RFC 7636 appendix B vector.
eq(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'RFC 7636 vector');
const v = randomString(32);
eq(/^[A-Za-z0-9_-]{43}$/.test(v), true, 'verifier is 43 base64url chars');
eq(await pkceChallenge(v), createHash('sha256').update(v).digest('base64url'), 'challenge matches node crypto');
eq(randomString(32) === v, false, 'verifiers differ');

// Authorize URL.
const u = new URL(authorizeUrl('https://spacegho.st', { clientId: CLIENT_ID, redirectUri: 'https://abc.chromiumapp.org/oauth', challenge: 'C', state: 'S' }));
eq(u.origin + u.pathname, 'https://spacegho.st/oauth/authorize', 'authorize endpoint');
eq([...u.searchParams].map(([k, x]) => `${k}=${x}`), ['response_type=code', `client_id=${CLIENT_ID}`, 'redirect_uri=https://abc.chromiumapp.org/oauth', 'code_challenge=C', 'code_challenge_method=S256', 'state=S', `scope=${SCOPE}`], 'authorize query');
eq(new URL(authorizeUrl('https://spacegho.st', { clientId: 'c', redirectUri: 'r', challenge: 'C', state: 'S', prompt: 'none' })).searchParams.get('prompt'), 'none', 'prompt');

// Redirect check.
const ok = { state: 'S', issuer: 'https://spacegho.st' };
eq(parseRedirect('https://x.chromiumapp.org/oauth?code=abc&state=S&iss=https%3A%2F%2Fspacegho.st', ok), { code: 'abc' }, 'good redirect');
eq(parseRedirect('https://x.chromiumapp.org/oauth?code=abc&state=S', ok), { code: 'abc' }, 'iss optional');
eq(!!parseRedirect('https://x/?code=abc&state=T', ok).error, true, 'state mismatch');
eq(!!parseRedirect('https://x/?code=abc&state=S&iss=https%3A%2F%2Fevil.example', ok).error, true, 'issuer mismatch');
eq(parseRedirect('https://x/?error=access_denied&state=S', ok), { error: 'access_denied' }, 'error passed on');
eq(!!parseRedirect('https://x/?state=S', ok).error, true, 'no code');
eq(!!parseRedirect('', ok).error, true, 'no url');

// Token storage and freshness.
const st = storedTokens({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: 'i' }, 1000);
eq(st, { access: 'a', refresh: 'r', accessExp: 1000 + 3600000, idToken: 'i' }, 'stored tokens');
eq(storedTokens({ access_token: 'a' }), null, 'no refresh token, nothing stored');
eq(accessFresh(st, 1000), true, 'fresh');
eq(accessFresh(st, 1000 + 3600000 - 30000), false, 'stale within the last minute');
eq(accessFresh(null), false, 'no tokens');

// Policy: only a 200 with a boolean counts; everything else is the default.
eq(policyFrom(200, { playback: { plus: true }, display: { name: 'alice' } }), { spots: false, name: 'alice' }, 'policy false + name');
eq(policyFrom(200, { playback: { plus: false }, display: { name: null } }), { spots: true, name: null }, 'policy true');
eq(policyFrom(200, { playback: { plus: 'false' } }), { spots: true, name: null }, 'string is not a boolean');
eq(policyFrom(401, { error: 'invalid_token' }), { spots: true, name: null }, '401');
eq(policyFrom(503, null), { spots: true, name: null }, '5xx');
eq(policyFrom(200, { playback: {} }), { spots: true, name: null }, 'missing flag');

// Label: display name, else userinfo name, else email, else neutral.
eq(accountLabel({ name: 'alice' }, { email: 'a@example.com' }), 'alice', 'display name first');
eq(accountLabel({ name: null }, { name: 'Bob' }), 'Bob', 'userinfo name');
eq(accountLabel({ name: null }, { email: 'invitee@example.com' }), 'invitee@example.com', 'email-only account');
eq(accountLabel(null, null), 'spacegho.st account', 'neutral fallback');

// JWT claims (display only).
const jwt = ['{"alg":"ES256"}', '{"sub":"u_1","name":"Zoë"}'].map((x) => Buffer.from(x).toString('base64url')).join('.') + '.sig';
eq(jwtClaims(jwt), { sub: 'u_1', name: 'Zoë' }, 'jwt claims utf-8');
eq(jwtClaims('nope'), null, 'bad jwt');

console.log(`account: ${n} checks ok`);
