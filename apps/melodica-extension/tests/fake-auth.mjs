// A stand-in for the melodica-site Worker's GET /melodica/auth/me, for the smoke
// tests (the real GitHub round trip cannot run in CI). It follows the contract the
// Worker implements, deciding from the token's own claims and verifying nothing:
//
//   no/malformed token, exp in the past, or sub "revoked"  -> 401 {"error": "invalid token"}
//   sub "unconfigured"                                      -> 503 {"error": "auth not configured"}
//   otherwise                                               -> 200 {login, friend, exp, checked_at, token?}
//                                                              (friend is the Worker's name for "allowed"; sub "allowed-ci" also gets a refreshed token)
//
// CORS headers are sent as the Worker sends them for extension origins. /start is
// not served: it would need GitHub.
import http from 'node:http';

export const b64url = (s) => Buffer.from(s).toString('base64url');

// A token with these claims over sensible defaults (friend false, 7-day exp) and a
// second segment that is not an HMAC of anything.
export function makeToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const c = { id: 1, iat: now, exp: now + 7 * 86400, chk: now, friend: false, ...claims };
  return `${b64url(JSON.stringify(c))}.${b64url('fake-signature-the-client-never-checks')}`;
}

export function parseClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0]) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return c && typeof c.sub === 'string' && typeof c.exp === 'number' ? c : null;
  } catch {
    return null;
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization',
  'access-control-allow-methods': 'GET, OPTIONS',
  'cache-control': 'no-store',
};

// Answer an /melodica/auth/* request; false when the URL is not one. `calls`, when
// given, collects {path, sub, status} for the report.
export function handleAuth(req, res, calls) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/melodica/auth/')) return false;
  const json = (status, body, sub) => {
    if (calls) calls.push({ path: url.pathname, method: req.method, sub: sub ?? null, status });
    const text = JSON.stringify(body);
    res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return true;
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
  if (url.pathname !== '/melodica/auth/me') return json(404, { error: 'not found' });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const claims = parseClaims(token);
  const now = Math.floor(Date.now() / 1000);
  if (claims && claims.sub === 'unconfigured') return json(503, { error: 'auth not configured' }, claims.sub);
  if (!claims || claims.sub === 'revoked' || !(claims.exp > now)) return json(401, { error: 'invalid token' }, claims && claims.sub);
  const body = { login: claims.sub, friend: claims.friend === true, exp: claims.exp, checked_at: now };
  if (claims.sub === 'allowed-ci') body.token = makeToken({ ...claims, chk: now, refreshed: true });
  return json(200, body, claims.sub);
}

// A plain http server for the Firefox smoke (Chromium's smoke serves the same handler
// from its https "spacegho.st" server). Resolves with {server, base, calls}.
export async function startFakeAuth() {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (!handleAuth(req, res, calls)) { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, calls, base: `http://127.0.0.1:${server.address().port}/melodica/auth` };
}
