// A stand-in for the spacegho.st relay (melodica-site src/relay.js) in front of a
// Pandora-compatible server (melodica-tuner), following the relay section of
// docs/ACCOUNT.md:
//
//   auth.partnerLogin, test.checkLicensing   forwarded, no token needed
//   auth.userLogin   the username is read from the Blowfish body; not on the allow-list:
//                    403 {"stat":"fail","code":-1,"message":"melodica access is by allow-list. Your request has been sent."}
//                    (upstream is not contacted, the email is recorded as a request);
//                    allowed: forwarded, and on stat "ok" the answer carries x-melodica-access
//   anything else    needs a valid x-melodica-access, else 401 with the allow-list message
//
// makeRelay({upstream, access}): `access` is the fake account server (fake-account.mjs),
// whose accessCheck(email) / accessVerify(token) play spaceghost-auth's MelodicaAccess.
// handle(method, headers, body) -> {status, headers, body}. `seen` records each call.

import https from 'node:https';
import http from 'node:http';
import { ANDROID_ENCRYPT_KEY, decryptHex } from './blowfish.mjs';

export const ACCESS_HEADER = 'x-melodica-access';
export const ACCESS_MESSAGE = 'melodica access is by allow-list; signing in sends your email to the admin as an access request.';
export const REQUEST_SENT = 'melodica access is by allow-list. Your request has been sent.';
const OPEN = new Set(['auth.partnerLogin', 'test.checkLicensing']);
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': `content-type, authorization, ${ACCESS_HEADER}`,
  'access-control-expose-headers': ACCESS_HEADER,
};

function loginEmail(text) {
  const plain = decryptHex(ANDROID_ENCRYPT_KEY, text.trim());
  try { const j = JSON.parse(plain); return typeof j.username === 'string' ? j.username : null; } catch { return null; }
}

function post(url, search, body) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((ok, fail) => {
    const req = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname + search, method: 'POST',
      rejectUnauthorized: false, headers: { 'content-type': 'text/plain', 'content-length': body.length } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

export function makeRelay({ upstream, access }) {
  const seen = [];
  const fail = (status, message) => ({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ stat: 'fail', code: -1, message }) });
  async function handle(httpMethod, search, headers, body) {
    if (httpMethod === 'OPTIONS') return { status: 204, headers: CORS, body: '' };
    const method = new URLSearchParams(search).get('method') || '';
    const token = headers[ACCESS_HEADER] || '';
    const entry = { method, token: !!token, status: 0 };
    seen.push(entry);
    let grant = null;
    if (method === 'auth.userLogin') {
      const email = loginEmail(body.toString('utf8'));
      entry.email = email;
      if (!email) { entry.status = 400; return fail(400, ACCESS_MESSAGE); }
      const d = access.accessCheck(email);
      if (!d.allowed) { entry.status = 403; return fail(403, REQUEST_SENT); }
      grant = d.token;
    } else if (!OPEN.has(method) && !access.accessVerify(token)) {
      entry.status = 401;
      return fail(401, ACCESS_MESSAGE);
    }
    const up = await post(upstream, search, body);
    entry.status = up.status;
    const out = { ...CORS, 'content-type': 'application/json' };
    if (grant) {
      let ok = false;
      try { ok = up.status === 200 && JSON.parse(up.text).stat === 'ok'; } catch { /* no token */ }
      if (ok) out[ACCESS_HEADER] = grant;
    }
    return { status: up.status, headers: out, body: up.text };
  }
  return { handle, seen };
}
