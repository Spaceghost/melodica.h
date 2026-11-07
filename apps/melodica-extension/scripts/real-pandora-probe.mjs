// No-account probe of the extension's own Pandora client (src/pandora.imba +
// the Nelua wasm core) against the real tuner.pandora.com, in Node:
//
//   auth.partnerLogin (no user needed) -> syncTime decrypt -> auth.userLogin
//   with bogus credentials.
//
// If the request framing is right (auth_token/partner_id query, Blowfish
// envelope, syncTime) Pandora answers code 1002 "Wrong email address or
// password" for the bogus user. A wrong envelope or token shows up as 1001
// (INVALID_AUTH_TOKEN), 13 (INSUFFICIENT_CONNECTIVITY, clock) or 3.
//
//   node scripts/real-pandora-probe.mjs [--endpoint URL] [--out report.json] [--expect 1002]
//
// Prints every request URL with its tokens redacted to their length, the
// decrypted syncTime bytes, the clock offset, the decrypted envelope of the
// userLogin request (password redacted) and each response's code/message.
// Exits 0 only when auth.userLogin came back with the expected code.
import { readFileSync, writeFileSync } from 'node:fs';
import { Core } from '../build/node/core.js';
import { Pandora, PandoraError, DEFAULT_ENDPOINT, nowSeconds } from '../build/node/pandora.js';

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const endpoint = arg('--endpoint', DEFAULT_ENDPOINT);
const out = arg('--out', '');
const expect = Number(arg('--expect', '1002'));
const wasm = arg('--core', new URL('../build/core/melodica_core.wasm', import.meta.url));
const EMAIL = 'nobody@example.com';
const PASSWORD = 'wrong-password';

const redactUrl = (url) => {
  const u = new URL(url);
  for (const k of ['auth_token', 'user_id']) {
    const v = u.searchParams.get(k);
    if (v) u.searchParams.set(k, `[${k}:${v.length}chars]`);
  }
  return decodeURIComponent(u.toString());
};
// Tokens and the password reduced to their lengths.
const redactJson = (text) => text
  .replace(/"password":"([^"]*)"/, (m, v) => `"password":"[${v.length}chars]"`)
  .replace(/"(partnerAuthToken|userAuthToken)":"([^"]*)"/g, (m, k, v) => `"${k}":"[${v.length}chars]"`);
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1').replace(/[^\x20-\x7e]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

const report = {
  ok: false, platform: 'pandora-probe', browser: `node ${process.version}`, summary: '', when: new Date().toISOString(), steps: [],
  endpoint, expect, requests: [], partnerLogin: null, userLogin: null,
};
const step = (s) => { if (!report.steps.includes(s)) report.steps.push(s); };
const log = (line) => { console.log(line); };

const core = await Core.load(readFileSync(wasm));
if (!core.init()) throw new Error('core.init failed');
// A second instance keyed with the encrypt key on both sides, to read our own envelopes back.
const mirror = await Core.load(readFileSync(wasm));
mirror.initKeys('6#26FRL$ZWD', '6#26FRL$ZWD');

let lastRaw = null;
const traced = async (url, init) => {
  const entry = { url: redactUrl(url), bodyBytes: String(init.body).length, sentAt: nowSeconds() };
  const method = new URL(url).searchParams.get('method');
  if (method !== 'auth.partnerLogin') {
    const plain = mirror.decryptHex(String(init.body));
    entry.envelope = plain ? redactJson(latin1(plain).replace(/\0+$/, '')) : '<not hex>';
  } else {
    entry.envelope = String(init.body);
  }
  log(`-> POST ${entry.url}`);
  log(`   body ${entry.bodyBytes} bytes; plaintext: ${entry.envelope}`);
  const res = await fetch(url, init);
  const raw = await res.text();
  lastRaw = raw;
  entry.status = res.status;
  try {
    const j = JSON.parse(raw);
    entry.stat = j.stat; entry.code = j.code ?? null; entry.message = j.message ?? null;
    entry.resultKeys = j.result ? Object.keys(j.result).sort() : [];
  } catch { entry.stat = 'not json'; entry.snippet = raw.slice(0, 120); }
  log(`<- HTTP ${res.status} stat=${entry.stat} code=${entry.code ?? ''} ${entry.message ?? ''} keys=${(entry.resultKeys || []).join(',')}`);
  report.requests.push(entry);
  return new Response(raw, { status: res.status, headers: res.headers });
};

const client = new Pandora(core, { endpoint, fetch: traced, log: (l) => log(`   client: ${l}`) });

try {
  const partner = await client.partnerLogin();
  const r = JSON.parse(lastRaw).result;
  const hex = String(r.syncTime);
  const plain = core.decryptHex(hex);
  const serverNow = core.syncTime(nowSeconds());
  report.partnerLogin = {
    partnerId: r.partnerId, partnerIdType: typeof r.partnerId,
    partnerAuthTokenLength: String(r.partnerAuthToken).length,
    partnerAuthTokenNonAlnum: [...new Set(String(r.partnerAuthToken).replace(/[A-Za-z0-9]/g, ''))].sort().join(''),
    syncTimeHex: hex, syncTimeHexLength: hex.length,
    syncTimeDecrypted: plain ? latin1(plain) : null,
    syncTimeSeconds: serverNow, syncOffset: core.syncOffset, hostNow: nowSeconds(),
  };
  log(`   partnerId=${JSON.stringify(r.partnerId)} (${typeof r.partnerId}) partnerAuthToken ${report.partnerLogin.partnerAuthTokenLength} chars, non-alnum "${report.partnerLogin.partnerAuthTokenNonAlnum}"`);
  log(`   syncTime hex (${hex.length}): ${hex}`);
  log(`   syncTime decrypted: ${report.partnerLogin.syncTimeDecrypted}`);
  log(`   server seconds ${serverNow} (${new Date(serverNow * 1000).toISOString()}), offset ${core.syncOffset}s vs host ${nowSeconds()}`);
  if (!partner.authToken || !partner.id) throw new Error('partnerLogin returned no token/id');
  step('auth.partnerLogin ok');
  step(`syncTime decrypted: ${serverNow} (offset ${core.syncOffset}s)`);
} catch (e) {
  report.partnerLogin = { error: String(e && e.message || e), code: e && e.code };
  log(`partnerLogin failed: ${report.partnerLogin.error}`);
  finish(1);
}

try {
  await client.login(EMAIL, PASSWORD);
  report.userLogin = { code: null, message: 'logged in?!' };
  log('auth.userLogin succeeded with bogus credentials (impossible)');
} catch (e) {
  report.userLogin = { code: e instanceof PandoraError ? e.code : null, message: String(e && e.message || e), kind: e && e.kind };
  log(`auth.userLogin -> code ${report.userLogin.code}: ${report.userLogin.message}`);
}
report.ok = report.userLogin.code === expect;
step(`auth.userLogin with bogus credentials -> code ${report.userLogin.code}`);
finish(report.ok ? 0 : 2);

function finish(status) {
  report.summary = report.ok
    ? `auth.partnerLogin ok (syncTime ${report.partnerLogin.syncTimeSeconds}, offset ${report.partnerLogin.syncOffset}s); auth.userLogin with bogus credentials -> code ${report.userLogin.code} (${report.userLogin.message})`
    : `expected code ${expect} from auth.userLogin, got ${report.userLogin ? report.userLogin.code : 'no attempt'}: ${report.userLogin ? report.userLogin.message : report.partnerLogin && report.partnerLogin.error}`;
  log(`${report.ok ? 'OK' : 'FAIL'}: ${report.summary}`);
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  process.exit(status);
}
