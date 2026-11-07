// Unit test of the GitHub gate's token handling (src/github.imba, bundled for Node
// by scripts/build.mjs as build/node/github.js): claims parsing, expiry, the
// redirect URL's fragment, the auth URLs.
//   node tests/github.test.mjs
import { parseToken, expired, tokenFromRedirect, fromBase64Url, normalizeAuthBase, startUrl, meUrl, AUTH_BASE } from '../build/node/github.js';
import { makeToken, b64url } from './fake-auth.mjs';

let n = 0;
const eq = (a, b, what) => {
  n++;
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error(`FAIL ${what}: ${A} !== ${B}`); process.exit(1); }
};

const now = Math.floor(Date.now() / 1000);

// A well-formed token round-trips its claims; the Worker's `friend` flag becomes `allowed`, a strict boolean.
const t = makeToken({ sub: 'octocat', id: 583231, friend: true, exp: now + 600 });
const c = parseToken(t);
eq(c.sub, 'octocat', 'sub');
eq(c.id, 583231, 'id');
eq(c.allowed, true, 'allowed');
eq(c.exp, now + 600, 'exp');
eq(typeof c.iat, 'number', 'iat');
eq(parseToken(makeToken({ sub: 'x', friend: 'true' })).allowed, false, 'allowed must come from a real boolean');
eq(parseToken(makeToken({ sub: 'x', friend: 1 })).allowed, false, '1 is not true');
eq(parseToken(makeToken({ sub: 'x' })).allowed, false, 'allowed defaults false');
eq(parseToken(makeToken({ sub: 'ünïcødé-日本' })).sub, 'ünïcødé-日本', 'utf-8 sub');

// Padded base64 is accepted too (the Worker emits unpadded base64url).
const padded = `${Buffer.from(JSON.stringify({ sub: 'p', exp: now + 1 })).toString('base64')}.${b64url('sig')}`;
eq(parseToken(padded)?.sub, 'p', 'padded base64');
eq(Buffer.from(fromBase64Url('aGk')).toString(), 'hi', 'base64url decode unpadded');
eq(Buffer.from(fromBase64Url('aGk=')).toString(), 'hi', 'base64url decode padded');
eq(fromBase64Url('a*b'), null, 'base64url rejects other characters');

// Malformed tokens are null, never an exception.
for (const [bad, what] of [
  [null, 'null'], [undefined, 'undefined'], [42, 'number'], ['', 'empty'],
  ['abc', 'no dot'], ['a.b.c', 'three segments'], ['.sig', 'empty claims'], ['claims.', 'empty signature'],
  [`${b64url('not json')}.sig`, 'claims not JSON'],
  [`${b64url('[1,2]')}.sig`, 'claims an array'],
  [`${b64url('"str"')}.sig`, 'claims a string'],
  [`${b64url(JSON.stringify({ exp: now + 1 }))}.sig`, 'no sub'],
  [`${b64url(JSON.stringify({ sub: '', exp: now + 1 }))}.sig`, 'empty sub'],
  [`${b64url(JSON.stringify({ sub: 42, exp: now + 1 }))}.sig`, 'numeric sub'],
  [`${b64url(JSON.stringify({ sub: 'x' }))}.sig`, 'no exp'],
  [`${b64url(JSON.stringify({ sub: 'x', exp: '123' }))}.sig`, 'string exp'],
  ['!!!.sig', 'claims not base64'],
]) eq(parseToken(bad), null, `malformed: ${what}`);

// Expiry is read from exp (seconds), with an explicit clock for the test.
eq(expired(parseToken(makeToken({ sub: 'x', exp: now + 60 })), now), false, 'not expired');
eq(expired(parseToken(makeToken({ sub: 'x', exp: now - 1 })), now), true, 'expired');
eq(expired(parseToken(makeToken({ sub: 'x', exp: now })), now), true, 'exp == now is expired');
eq(expired(null), true, 'null claims are expired');
eq(expired(parseToken(makeToken({ sub: 'x', exp: now - 1 }))), true, 'default clock');

// The redirect URL: the token is read from the fragment only.
const redirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/melodica';
eq(tokenFromRedirect(`${redirect}#melodica_token=${t}`), t, 'fragment token');
eq(tokenFromRedirect(`${redirect}#a=1&melodica_token=${t}&b=2`), t, 'fragment token among others');
eq(tokenFromRedirect(`https://6d656c6f.extensions.allizom.org/melodica#melodica_token=${t}`), t, 'Firefox redirect host');
eq(tokenFromRedirect(`${redirect}?melodica_token=${t}`), null, 'query is not the fragment');
eq(tokenFromRedirect(`${redirect}#melodica_token=garbage`), null, 'fragment with a malformed token');
eq(tokenFromRedirect(`${redirect}#other=1`), null, 'fragment without the token');
eq(tokenFromRedirect(redirect), null, 'no fragment');
eq(tokenFromRedirect('not a url'), null, 'not a URL');
eq(tokenFromRedirect(''), null, 'empty');
eq(tokenFromRedirect(undefined), null, 'undefined');

// Auth URLs: the default base, a test override, trailing slashes, junk.
eq(AUTH_BASE, 'https://spacegho.st/melodica/auth', 'default base');
eq(normalizeAuthBase(''), AUTH_BASE, 'empty override -> default');
eq(normalizeAuthBase(undefined), AUTH_BASE, 'undefined override -> default');
eq(normalizeAuthBase('http://127.0.0.1:4321/melodica/auth/'), 'http://127.0.0.1:4321/melodica/auth', 'override, slash stripped');
eq(normalizeAuthBase('ftp://x/y'), AUTH_BASE, 'non-http override -> default');
eq(normalizeAuthBase('nonsense'), AUTH_BASE, 'junk override -> default');
eq(meUrl(''), 'https://spacegho.st/melodica/auth/me', 'me url');
eq(startUrl('', redirect), `https://spacegho.st/melodica/auth/start?return_to=${encodeURIComponent(redirect)}`, 'start url');
eq(startUrl('http://127.0.0.1:1/melodica/auth/', 'https://x.y/z#q'), 'http://127.0.0.1:1/melodica/auth/start?return_to=https%3A%2F%2Fx.y%2Fz%23q', 'start url encodes the fragment');

console.log(`github gate: ${n} checks ok`);
