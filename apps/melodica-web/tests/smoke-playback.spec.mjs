// Playback and relay access end to end against melodica-tuner (0.2.0+): the
// built client in a headless browser, logging in through a fake relay
// (tests/tools/fake-relay.mjs, the allow-list of docs/ACCOUNT.md) in front of the
// tuner, with the contract fake account server (tests/tools/fake-account.mjs) on
// the page's origin.
//
//   1. signed in to a spacegho.st account whose playback flags say no inserts: the
//      tuner serves them, the page plays none (no insert request, audio or
//      confirmation in the tuner's log).
//   2. no account; the allow-list entry's flags say the same, read from the policy
//      endpoint with the relay's x-melodica-access token: again none played.
//   3. no account; default flags, the tuner sends an insert after every song: its
//      info is fetched, its audio plays in the now-playing card with skip and
//      rating disabled, and it is confirmed with the tracking tokens the tuner
//      handed out for this station.
//   4. an email not on the allow-list: the relay answers 403, the login card shows
//      its message, the email is recorded as a request, Pandora sees no login.
// 1-3 also check that every relay call after the login carried x-melodica-access.
//
// Usernames (docs/ACCOUNT.md, /oauth/melodica/me and /username with the relay token):
//   5. a generated name: listener-… in the account chip (never the email), "Pick a
//      username" prefilled with the suggestion; 409, 422 and a format error shown in
//      the sheet; the chosen name then in the chip.
//   6. a chosen name: no prompt; "Change username" in the account menu (409 inline,
//      then saved).
//   7. "Not now" keeps the sheet closed for the session; the renamed_github notice.
//   8. a revoked relay token: the page logs out and says the session ended.
//
// Remember me on this device (docs/BRIDGE.md 5, web/vault.js):
//   9. after a remembered login a dump of localStorage, sessionStorage and IndexedDB
//      does not contain the password; a reload resumes the stored session (no
//      auth.userLogin) and plays; signing out deletes the vault.
//  10. a plaintext password left by an older version is moved into the vault and
//      erased; unchecking the box in the account menu deletes the vault.
//
// The tuner comes from TUNER_HTTPS_URL / TUNER_HTTP_URL / TUNER_USER /
// TUNER_PASSWORD (the Spaceghost/melodica-tuner action) or MELODICA_TUNER_DIR
// (a checkout; the test starts it). Its insert setting is changed at runtime
// through POST /__tuner/config. Without a tuner the tests are skipped.
//
// Artifacts: tests/artifacts/smoke-playback.json (what the tuner saw),
// smoke-web-insert.png (an insert in the now-playing card), smoke-web-not-listed.png,
// username-pick.png, username-change.png.

import { test, expect, devices } from '@playwright/test';
// The playback flag as the client reads it (web/account.js).
const flagsOf = (b) => !b.playback.plus;
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { makeBackend } from './tools/fake-account.mjs';
import { makeScrobbles, serveNode } from './tools/fake-scrobble.mjs';
import { makeRelay, REQUEST_SENT } from './tools/fake-relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const ARTIFACTS = resolve(here, 'artifacts');
const APP_PATH = '/melodica/app/';
const SHELL_PATHS = new Set(['/melodica/', '/melodica/listens/', '/melodica/leaderboard/', '/melodica/map/', '/melodica/account/', '/melodica/extension/']);
const sitePage = await import('../site/src/page.js');
const TUNER_DIR = process.env.MELODICA_TUNER_DIR || resolve(here, '..', '..', 'melodica-tuner');

const tuner = {
  https: process.env.TUNER_HTTPS_URL || '',
  http: process.env.TUNER_HTTP_URL || '',
  user: process.env.TUNER_USER || 'test@example.com',
  password: process.env.TUNER_PASSWORD || 'tuner-pass-7Qx', // distinctive: the storage test searches for it
  version: '', proc: null, dir: null,
};
const haveTuner = !!tuner.https || existsSync(join(TUNER_DIR, 'tuner', '__main__.py'));
const report = { policyOff: null, policyOn: null, relayPolicyOff: null, notListed: null };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
};
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; ` +
  `style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; media-src https: http: blob:; ` +
  `connect-src 'self' ${new URL(tuner.https || 'https://x').origin} ${new URL(tuner.http || 'http://x').origin}; font-src 'self'; ` +
  `base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'`;

test.use({ ignoreHTTPSErrors: true, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

const getJson = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} -> ${r.status}`); return r.json(); };
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function startTuner() {
  tuner.dir = await mkdtemp(join(tmpdir(), 'melodica-tuner-'));
  const ready = join(tuner.dir, 'ready');
  const out = [];
  tuner.proc = spawn('python3', ['-m', 'tuner', '--bind', '127.0.0.1', '--https-port', '8443', '--http-port', '8080',
    '--tls-auto', join(tuner.dir, 'certs'), '--user', tuner.user, '--password', tuner.password, '--ready-file', ready],
  { cwd: TUNER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  tuner.proc.stdout.on('data', (d) => out.push(String(d)));
  tuner.proc.stderr.on('data', (d) => out.push(String(d)));
  for (let i = 0; i < 120 && !existsSync(ready); i++) await new Promise((ok) => setTimeout(ok, 500));
  if (!existsSync(ready)) throw new Error(`tuner did not become ready:\n${out.join('')}`);
  [tuner.https, tuner.http] = (await readFile(ready, 'utf8')).trim().split('\n').map((l) => l.trim());
}

let server = null;
let appUrl = '';
let origin = '';
let account = null;
let relay = null;
let scrobbles = null;
const RELAY_PATH = '/melodica/api/';

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (!haveTuner) return;
  if (!tuner.https) await startTuner();
  tuner.version = String((await getJson(`${tuner.http}/__tuner/health`)).version || '');
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === RELAY_PATH) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await relay.handle(req.method, url.search, req.headers, Buffer.concat(chunks));
      res.writeHead(r.status, r.headers);
      res.end(r.body);
      return;
    }
    if (url.pathname.startsWith('/scrobble/')) { await serveNode(scrobbles.handle, req, res, origin); return; }
    if (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (k !== 'host') headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const r = await account.handle(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      const out = {};
      r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
      if (r.headers.getSetCookie().length) out['set-cookie'] = r.headers.getSetCookie();
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    // The shell as the site Worker serves it (site/src/worker.js): index.html with a base
    // for every route, and the hub and the extension page as fragments from site/src/page.js.
    if (SHELL_PATHS.has(url.pathname)) {
      if (url.searchParams.has('fragment')) {
        const html = url.pathname === '/melodica/' ? sitePage.hub(null, { prefix: '/melodica' }) : sitePage.render(null, { prefix: '/melodica' });
        const from = html.indexOf('<header class="hero'); const main = html.slice(from >= 0 ? from : html.indexOf('<main'), html.lastIndexOf('</main>') + 7).replace(/<script[\s\S]*?<\/script>/gi, '');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(main);
        return;
      }
      const page = (await readFile(resolve(DIST, 'index.html'), 'utf8')).replace(/<head>/i, `<head>\n<base href="${APP_PATH}">`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp(randomBytes(16).toString('base64')).replace("base-uri 'none'", "base-uri 'self'") });
      res.end(page);
      return;
    }
    if (!url.pathname.startsWith(APP_PATH)) { res.writeHead(404); res.end(); return; }
    let rel = url.pathname.slice(APP_PATH.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some((p) => !p || p === '.' || p === '..')) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(resolve(DIST, rel));
      const type = MIME[extname(rel)] || 'application/octet-stream';
      const headers = { 'content-type': type, 'content-length': body.length };
      if (type.startsWith('text/html')) headers['content-security-policy'] = csp(randomBytes(16).toString('base64'));
      res.writeHead(200, headers);
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((ok) => server.listen(0, 'localhost', ok));
  origin = `http://localhost:${server.address().port}`;
  account = makeBackend(origin, { github: { crew_map: {} } });
  // Scrobbles on the same origin; off unless a scrobbling test turns it on (no notice elsewhere).
  scrobbles = makeScrobbles({ who: (t) => account.who(t) });
  scrobbles.defaultOn = false;
  scrobbles.attach(server);
  // The page talks to the fake relay (the allow-list in front of the tuner), as the
  // hosted page talks to spacegho.st/melodica/api/.
  relay = makeRelay({ upstream: `${tuner.https}/services/json/`, access: account });
  appUrl = `${origin}${APP_PATH}?api=${encodeURIComponent(`${origin}${RELAY_PATH}`)}`;
});

test.afterAll(async () => {
  if (scrobbles) scrobbles.closeSockets();
  if (server) await new Promise((ok) => server.close(ok));
  if (tuner.proc) tuner.proc.kill('SIGTERM');
  if (tuner.dir) await rm(tuner.dir, { recursive: true, force: true });
  if (haveTuner) {
    await writeFile(resolve(ARTIFACTS, 'smoke-playback.json'), JSON.stringify({ tuner: tuner.version, ...report }, null, 2) + '\n');
  }
});

// Sign in to a spacegho.st account (invite accepted, then "Sign in with spacegho.st")
// whose flags allow inserts or not.
async function signInAccount(page, email, inserts) {
  const t = account.invite(email);
  await page.goto(`${origin}/oauth/invite?t=${t}`);
  await page.getByRole('button', { name: 'Accept and sign in' }).click();
  await page.waitForURL(`${origin}/oauth/`);
  await account.setPolicy(email.split('@')[0], { inserts });
  await page.goto(`${origin}${APP_PATH}`);
  await page.click('#account-signin');
  await expect(page.locator('#account-signed')).toBeVisible({ timeout: 20_000 });
}

// Every relay call after the login carried the relay's access token; none was refused.
function expectRelayTokens() {
  const after = relay.seen.slice(relay.seen.findIndex((e) => e.method === 'auth.userLogin') + 1);
  expect(after.length, 'relay calls after the login').toBeGreaterThan(0);
  expect(after.filter((e) => !e.token).map((e) => e.method), 'relay calls without x-melodica-access').toEqual([]);
  expect(relay.seen.filter((e) => e.status === 401 || e.status === 403).map((e) => e.method), 'refused relay calls').toEqual([]);
}

// A fresh tuner run sending `every` inserts; the page opened (signed in to an account
// whose flags are `accountInserts`, when given) and logged in through the relay, whose
// allow-list has the tuner user with `listedInserts`.
async function begin(page, { every, accountInserts, listedInserts = true, scrobble = false }) {
  relay.seen.length = 0;
  account.allow(tuner.user, { inserts: listedInserts });
  account.setPerson(tuner.user, { username: 'tuner_listener', chosen: true, notice: '' }); // no "Pick a username" over the stations
  await postJson(`${tuner.http}/__tuner/reset`, {});
  const cfg = await postJson(`${tuner.http}/__tuner/config`, { ads: every });
  expect(cfg.ok, `POST /__tuner/config ${every}`).toBe(true);
  const evidence = { errors: [], console: [] };
  page.on('pageerror', (e) => evidence.errors.push(String(e)));
  page.on('console', (m) => evidence.console.push(`[${m.type()}] ${m.text()}`));
  if (accountInserts !== undefined) await signInAccount(page, `listener${Date.now()}@example.com`, accountInserts);
  // The policy request that decides: with the account's token when signed in, else with
  // the relay's access token right after the login.
  const policy = page.waitForResponse((r) => r.url().endsWith('/oauth/melodica/policy') &&
    (accountInserts === undefined ? /^Bearer mat\./ : /^Bearer (?!mat\.)/).test(r.request().headers().authorization || ''), { timeout: 60_000 });
  await page.addInitScript(() => {
    window.__audioEvents = [];
    document.addEventListener('DOMContentLoaded', () => {
      const a = document.getElementById('audio');
      // Kind by the audio URL: the app's own 'ended' handler may already have moved on.
      window.__insSrc = new Set();
      for (const n of ['playing', 'ended', 'error']) {
        a.addEventListener(n, () => {
          if (n === 'playing' && document.getElementById('app').dataset.insert === 'true') window.__insSrc.add(a.currentSrc);
          window.__audioEvents.push(`${n} ${window.__insSrc.has(a.currentSrc) ? 'insert' : 'song'}`);
        });
      }
    });
  });
  await page.goto(appUrl);
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
  await page.fill('#login-email', tuner.user);
  await page.fill('#login-password', tuner.password);
  await page.click('#login-button');
  expect(flagsOf(await (await policy).json()), 'the policy the page fetched').toBe(accountInserts ?? listedInserts);
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 30_000 });
  if (scrobble) {
    // Scrobbling on by default: the notice once, before anything plays.
    await expect(page.locator('#scrobble-notice')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#scrobble-notice-text')).toHaveText('Scrobbling to spacegho.st is on. Turn it off in settings.');
    await page.click('#scrobble-notice-ok');
    await expect(page.locator('#scrobble-notice')).toBeHidden();
  }
  await page.locator('#station-list button.station', { hasNotText: 'QuickMix' }).first().click();
  await expect(page.locator('#np-title')).not.toHaveText(/^(Pick a station)?$/, { timeout: 30_000 });
  return evidence;
}

async function tunerSeen() {
  const log = await getJson(`${tuner.http}/__tuner/log`);
  const state = await getJson(`${tuner.http}/__tuner/state`);
  const me = (state.users || []).find((u) => u.email === tuner.user) || {};
  return {
    log,
    inserts: me.ads || [],
    metadata: log.filter((e) => e.protocol === 'json' && e.method === 'ad.getAdMetadata'),
    register: log.filter((e) => e.protocol === 'json' && e.method === 'ad.registerAd'),
    insertAudio: log.filter((e) => e.protocol === 'audio' && e.ad === true),
    songAudio: log.filter((e) => e.protocol === 'audio' && !e.ad),
  };
}

test.describe.serial('playback flags against melodica-tuner', () => {
  test('an account whose flags say no inserts: the tuner serves them, none are played or requested', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    const evidence = await begin(page, { every: 1, accountInserts: false });
    // Play through several songs; every other playlist item is an insert.
    const titles = [];
    for (let i = 0; i < 4; i++) {
      titles.push((await page.locator('#np-title').textContent()).trim());
      await expect(page.locator('#app')).not.toHaveAttribute('data-insert', 'true');
      await expect(page.locator('#btn-next')).toBeEnabled();
      await page.click('#btn-next');
      await expect(page.locator('#np-title')).not.toHaveText(titles.at(-1), { timeout: 20_000 });
    }
    const seen = await tunerSeen();
    const served = seen.log.filter((e) => e.method === 'station.getPlaylist').length;
    report.policyOff = { titles, playlists: served, insertsServed: seen.inserts.length, metadata: seen.metadata.length, register: seen.register.length, insertAudio: seen.insertAudio.length };
    console.log(`flags off: ${JSON.stringify(report.policyOff)}`);
    await info.attach('policy-off', { body: JSON.stringify(report.policyOff, null, 2), contentType: 'application/json' });
    expect(seen.inserts.length, 'the tuner did serve inserts').toBeGreaterThan(0);
    expect(seen.metadata, 'no insert info request').toEqual([]);
    expect(seen.insertAudio, 'no insert audio fetched').toEqual([]);
    expect(seen.register, 'no insert confirmation').toEqual([]);
    expectRelayTokens();
    expect(evidence.errors).toEqual([]);
  });

  test('no account, allow-list entry with inserts off: the flags read with the relay token hold', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    const evidence = await begin(page, { every: 1, listedInserts: false });
    const titles = [];
    for (let i = 0; i < 3; i++) {
      titles.push((await page.locator('#np-title').textContent()).trim());
      await expect(page.locator('#app')).not.toHaveAttribute('data-insert', 'true');
      await page.click('#btn-next');
      await expect(page.locator('#np-title')).not.toHaveText(titles.at(-1), { timeout: 20_000 });
    }
    const seen = await tunerSeen();
    report.relayPolicyOff = { titles, insertsServed: seen.inserts.length, metadata: seen.metadata.length, register: seen.register.length, insertAudio: seen.insertAudio.length, relay: relay.seen.length };
    console.log(`relay-token flags off: ${JSON.stringify(report.relayPolicyOff)}`);
    await info.attach('relay-policy-off', { body: JSON.stringify(report.relayPolicyOff, null, 2), contentType: 'application/json' });
    expect(seen.inserts.length, 'the tuner did serve inserts').toBeGreaterThan(0);
    expect(seen.metadata, 'no insert info request').toEqual([]);
    expect(seen.insertAudio, 'no insert audio fetched').toEqual([]);
    expect(seen.register, 'no insert confirmation').toEqual([]);
    expectRelayTokens();
    expect(evidence.errors).toEqual([]);
  });

  test('no account, default flags: an insert is fetched, played without skip, and confirmed', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    const evidence = await begin(page, { every: 1 });
    // The item after the first song is an insert.
    await expect(page.locator('#app')).not.toHaveAttribute('data-insert', 'true');
    await page.click('#btn-next');
    await expect(page.locator('#app')).toHaveAttribute('data-insert', 'true', { timeout: 20_000 });
    const ins = {
      title: (await page.locator('#np-title').textContent()).trim(),
      company: (await page.locator('#np-artist').textContent()).trim(),
      chip: (await page.locator('#np-quality').textContent()).trim(),
      cover: await page.locator('#cover').getAttribute('src'),
    };
    console.log(`insert in the card: ${JSON.stringify(ins)}`);
    expect(ins.title).not.toBe('');
    expect(ins.company).not.toBe('');
    expect(ins.chip).toBe('');
    expect(ins.cover).toMatch(/^https?:/);
    for (const id of ['#btn-next', '#btn-love', '#btn-ban', '#btn-tired', '#btn-explain']) await expect(page.locator(id), `${id} during the insert`).toBeDisabled();
    // The n key does nothing during an insert.
    await page.locator('body').press('n');
    await expect(page.locator('#app')).toHaveAttribute('data-insert', 'true');
    await page.waitForFunction(() => window.__audioEvents.includes('playing insert'), null, { timeout: 20_000 });
    await page.screenshot({ path: resolve(ARTIFACTS, 'smoke-web-insert.png') });
    await expect.poll(async () => (await tunerSeen()).register.length, { timeout: 20_000, message: 'the confirmation reached the tuner' }).toBeGreaterThan(0);
    // The 5 s clip ends and the next song follows by itself.
    await page.waitForFunction(() => window.__audioEvents.includes('ended insert'), null, { timeout: 30_000 });
    await expect(page.locator('#app')).not.toHaveAttribute('data-insert', 'true', { timeout: 20_000 });
    await expect(page.locator('#btn-next')).toBeEnabled();
    const logged = await page.locator('#history li .hist-title').allTextContents();
    expect(logged, 'the insert is not in the play log').not.toContain(ins.title);

    const seen = await tunerSeen();
    // The tuner logs the decrypted request body as a JSON string.
    const parsed = (e) => (e && typeof e.body === 'string' ? { ...e, body: JSON.parse(e.body) } : e);
    const meta = parsed(seen.metadata[0]);
    const reg = parsed(seen.register[0]);
    const item = seen.inserts.find((a) => a.registered >= 1) || seen.inserts[0] || {};
    report.policyOn = {
      ins, metadata: seen.metadata.length, register: seen.register.length, insertAudio: seen.insertAudio.length,
      metadataBody: meta && meta.body, registerBody: reg && reg.body, registerResponse: reg && reg.response,
      state: item, audioEvents: await page.evaluate(() => window.__audioEvents),
    };
    console.log(`flags default: ${JSON.stringify(report.policyOn)}`);
    await info.attach('policy-on', { body: JSON.stringify(report.policyOn, null, 2), contentType: 'application/json' });
    expect(meta && meta.code, 'insert info succeeded').toBeNull();
    expect(meta.body.returnAdTrackingTokens).toBe(true);
    expect(meta.body.supportAudioAds).toBe(true);
    expect(seen.insertAudio.length, 'insert audio fetched').toBeGreaterThan(0);
    expect(reg && reg.code, 'insert confirmation succeeded').toBeNull();
    expect(reg.response && reg.response.stat).toBe('ok');
    expect(item.metadataFetched).toBeGreaterThanOrEqual(1);
    expect(item.audioFetched).toBeGreaterThanOrEqual(1);
    expect(item.registered).toBeGreaterThanOrEqual(1);
    expect(reg.body.stationId, 'registered for the playing station').toBe(item.registeredStationId);
    expect(reg.body.adTrackingTokens).toEqual(item.adTrackingTokens);
    expectRelayTokens();
    expect(evidence.errors).toEqual([]);
    // Preserve this case's protocol evidence before another case resets the tuner.
    const protocolLog = seen.log.map(({ protocol, method, status, code, ad }) => ({ protocol, method, status, code, ad }));
    await writeFile(resolve(ARTIFACTS, 'smoke-web-playback-log.json'), JSON.stringify(protocolLog, null, 2) + '\n');
  });

  test('an email not on the allow-list: the login card says so and Pandora is not contacted', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    relay.seen.length = 0;
    // No reset: CI's tuner.report reads the insert steps of the case before from this log.
    const logins = async () => (await getJson(`${tuner.http}/__tuner/log`)).filter((e) => e.method === 'auth.userLogin').length;
    const loginsBefore = await logins();
    const email = `stranger${Date.now()}@example.com`;
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(appUrl);
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
    await expect(page.locator('#access-note')).toHaveCount(0);
    await page.fill('#login-email', email);
    await page.fill('#login-password', 'whatever');
    await page.click('#login-button');
    await expect(page.locator('#login-message')).toHaveText(REQUEST_SENT, { timeout: 20_000 });
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
    await page.screenshot({ path: resolve(ARTIFACTS, 'smoke-web-not-listed.png') });
    report.notListed = { message: await page.locator('#login-message').textContent(), relay: relay.seen, requested: account.requests.includes(email) };
    await info.attach('not-listed', { body: JSON.stringify(report.notListed, null, 2), contentType: 'application/json' });
    expect(relay.seen.find((e) => e.method === 'auth.userLogin'), 'the relay refused the login').toMatchObject({ status: 403, email });
    expect(account.requests, 'the email was recorded as a request').toContain(email);
    expect(await logins(), 'no auth.userLogin reached Pandora').toBe(loginsBefore);
    expect(errors).toEqual([]);
  });
});

// Logs in through the relay (no station started) and waits for the player.
async function loginRelay(page) {
  account.allow(tuner.user, { inserts: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(appUrl);
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
  await page.fill('#login-email', tuner.user);
  await page.fill('#login-password', tuner.password);
  await page.click('#login-button');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 30_000 });
  return errors;
}

test.describe.serial('usernames through the relay', () => {
  test('a generated name: listener in the chip, Pick a username with 409 and 422 inline, then the chosen name', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    account.setPerson(tuner.user, { username: 'listener-1a2b3c', chosen: false, suggested: 'octocat', notice: '', changes: 0 });
    account.claimName('night_owl');
    const errors = await loginRelay(page);
    await expect(page.locator('#signed-in')).toHaveText('listener-1a2b3c', { timeout: 10_000 });
    const sheet = page.locator('#username-pick');
    await expect(sheet).toBeVisible();
    await expect(page.locator('#username-pick-current')).toHaveText('listener-1a2b3c');
    await expect(page.locator('#username-pick-input')).toHaveValue('octocat');
    await expect(page.locator('#username-pick-notice')).toBeHidden();
    const input = page.locator('#username-pick-input');
    const msg = page.locator('#username-pick-message');
    await input.fill('Night-0wl');
    await page.click('#username-pick-save');
    await expect(msg).toHaveText('That username is taken.');
    await input.fill('admin');
    await page.click('#username-pick-save');
    await expect(msg).toHaveText('That username is reserved.');
    await input.fill('a!');
    await page.click('#username-pick-save');
    await expect(msg).toHaveText(/^Use 3 to 24 letters/);
    await input.fill('Moonlit');
    await page.screenshot({ path: resolve(ARTIFACTS, 'username-pick.png') });
    await page.click('#username-pick-save');
    await expect(sheet).toBeHidden();
    await expect(page.locator('#signed-in')).toHaveText('moonlit');
    expect(account.person(tuner.user)).toMatchObject({ username: 'moonlit', chosen: true });
    await expect(page.locator('header.top')).not.toContainText('@');
    expect(errors).toEqual([]);
  });

  test('a chosen name: no prompt, and Change username in the account menu', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    account.setPerson(tuner.user, { username: 'moonlit', chosen: true, suggested: '', notice: '', changes: 0 });
    account.claimName('claimed_one');
    const errors = await loginRelay(page);
    await expect(page.locator('#signed-in')).toHaveText('moonlit', { timeout: 10_000 });
    await page.waitForTimeout(500);
    await expect(page.locator('#username-pick')).toBeHidden();
    await page.click('#account summary');
    await expect(page.locator('#signed-in-full')).toHaveText('Signed in as moonlit');
    const input = page.locator('#username-change-input');
    await expect(input).toHaveValue('moonlit');
    await input.fill('claimed_one');
    await page.click('#username-change-save');
    await expect(page.locator('#username-change-message')).toHaveText('That username is taken.');
    await input.fill('stargazer');
    await page.click('#username-change-save');
    await expect(page.locator('#username-change-message')).toHaveText('Saved.');
    await expect(page.locator('#signed-in')).toHaveText('stargazer');
    await page.screenshot({ path: resolve(ARTIFACTS, 'username-change.png') });
    expect(account.person(tuner.user).username).toBe('stargazer');
    expect(errors).toEqual([]);
  });

  test('Not now keeps the sheet closed for the session; the renamed_github notice shows', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    account.setPerson(tuner.user, { username: 'listener-9f9f9f', chosen: false, suggested: '', notice: 'renamed_github', changes: 0 });
    const errors = await loginRelay(page);
    await expect(page.locator('#username-pick')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#username-pick-notice')).toBeVisible();
    await expect(page.locator('#username-pick-input')).toHaveValue('');
    await page.click('#username-pick-later');
    await expect(page.locator('#username-pick')).toBeHidden();
    await page.click('#account summary');
    await page.click('#logout');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
    await page.fill('#login-password', tuner.password);
    await page.click('#login-button');
    await expect(page.locator('#signed-in')).toHaveText('listener-9f9f9f', { timeout: 30_000 });
    await page.waitForTimeout(500);
    await expect(page.locator('#username-pick')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a revoked relay token: the page logs out and says the session ended', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    account.setPerson(tuner.user, { username: 'stargazer', chosen: true, notice: '', changes: 0 });
    const errors = await loginRelay(page);
    await expect(page.locator('#signed-in')).toHaveText('stargazer', { timeout: 10_000 });
    account.revokeAccess();
    await page.click('#account summary');
    await page.fill('#username-change-input', 'nightjar');
    await page.click('#username-change-save');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 10_000 });
    await expect(page.locator('#login-message')).toHaveText('Your melodica session has ended; log in again.');
    expect(errors).toEqual([]);
  });
});

// Everything this origin stores, as text: localStorage, sessionStorage, and every
// IndexedDB database, store and value (binary values decoded as UTF-8 and Latin-1).
async function storageDump(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const st of [localStorage, sessionStorage]) for (let i = 0; i < st.length; i++) out.push(`${st.key(i)}=${st.getItem(st.key(i))}`);
    const text = (v) => {
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
        const b = new Uint8Array(v.buffer ? v.buffer : v, v.byteOffset || 0, v.byteLength);
        return `${new TextDecoder().decode(b)} ${String.fromCharCode(...b)}`;
      }
      if (v && typeof v === 'object' && !(v instanceof CryptoKey)) return Object.entries(v).map(([k, x]) => `${k}:${text(x)}`).join(' ');
      return String(v);
    };
    const dbs = await indexedDB.databases();
    for (const { name } of dbs) {
      const db = await new Promise((ok, fail) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
      for (const store of db.objectStoreNames) {
        const all = await new Promise((ok) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); });
        for (const v of all) out.push(`${name}/${store}: ${text(v)}`);
      }
      db.close();
    }
    return { text: out.join('\n'), databases: dbs.map((d) => d.name) };
  });
}

test.describe.serial('remember me on this device', () => {
  test('a remembered login: no password in any storage; a reload resumes the session; sign-out deletes the vault', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    account.allow(tuner.user, { inserts: true });
    account.setPerson(tuner.user, { username: 'tuner_listener', chosen: true, notice: '' });
    relay.seen.length = 0;
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(appUrl);
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
    await expect(page.locator('label.check', { has: page.locator('#login-remember') })).toHaveText('Remember me on this device');
    await page.fill('#login-email', tuner.user);
    await page.fill('#login-password', tuner.password);
    await page.check('#login-remember');
    await page.click('#login-button');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 30_000 });
    await expect.poll(async () => (await storageDump(page)).databases, { timeout: 5_000 }).toContain('melodica-vault');
    const dump = await storageDump(page);
    await info.attach('storage', { body: dump.text, contentType: 'text/plain' });
    expect(tuner.password.length, 'a password distinctive enough to search for').toBeGreaterThanOrEqual(6);
    expect(dump.text.includes(tuner.password), 'the password in plain text somewhere in storage').toBe(false);
    expect(dump.text).not.toMatch(/melodica\.password=/);
    // A reload resumes the stored session: straight to the player, no new Pandora login.
    const loginsBefore = relay.seen.filter((e) => e.method === 'auth.userLogin').length;
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 30_000 });
    await page.locator('#station-list button.station', { hasNotText: 'QuickMix' }).first().click();
    await expect(page.locator('#np-title')).not.toHaveText(/^(Pick a station)?$/, { timeout: 30_000 });
    expect(relay.seen.filter((e) => e.method === 'auth.userLogin').length, 'no new auth.userLogin after the reload').toBe(loginsBefore);
    await page.screenshot({ path: resolve(ARTIFACTS, 'remember-resumed.png') });
    // Sign out: the vault (key and record) is gone.
    await page.click('#account summary');
    await page.click('#logout');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
    await expect.poll(async () => (await storageDump(page)).databases, { timeout: 5_000 }).not.toContain('melodica-vault');
    await expect(page.locator('#login-password')).toHaveValue('');
    expect(errors).toEqual([]);
  });

  // Jack: "When I refresh it goes to login page instead of just refreshing with the
  // player." Remember me is on by default; a reload never shows the login card while
  // something is remembered, also when the stored relay token is rejected (revoked, or a
  // relay secret changed) or too old to use.
  test('remember on by default: reloads go straight to the player, never the login card, also with a rejected or expired relay token', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    account.allow(tuner.user, { inserts: true });
    account.setPerson(tuner.user, { username: 'tuner_listener', chosen: true, notice: '' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // Every data-view the page goes through, from the first script on.
    await page.addInitScript(() => {
      window.__views = [];
      new MutationObserver(() => {
        const v = document.getElementById('app') && document.getElementById('app').dataset.view;
        if (v && window.__views.at(-1) !== v) window.__views.push(v);
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-view'] });
    });
    await page.goto(appUrl);
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
    await expect(page.locator('#login-remember'), 'Remember me is on by default').toBeChecked();
    await page.fill('#login-email', tuner.user);
    await page.fill('#login-password', tuner.password);
    await page.click('#login-button');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 30_000 });
    await expect.poll(async () => (await storageDump(page)).databases, { timeout: 5_000 }).toContain('melodica-vault');
    const reloadOnce = async (label) => {
      await page.reload();
      await expect(page.locator('#station-list button.station').first(), `${label}: stations`).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#app')).not.toHaveAttribute('data-restoring', 'true', { timeout: 30_000 });
      const views = await page.evaluate(() => window.__views);
      report.reloadViews = report.reloadViews || {};
      report.reloadViews[label] = views;
      expect(views, `${label}: the views the page went through`).not.toContain('login');
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'player');
    };
    for (let i = 0; i < 5; i++) await reloadOnce(`reload ${i + 1}`);
    // The stored relay token rejected: the remembered password gets a new one silently.
    const loginsBefore = relay.seen.filter((e) => e.method === 'auth.userLogin').length;
    account.revokeAccess();
    await reloadOnce('rejected relay token');
    await page.locator('#station-list button.station', { hasNotText: 'QuickMix' }).first().click();
    await expect(page.locator('#np-title')).not.toHaveText(/^(Pick a station)?$/, { timeout: 30_000 });
    expect(relay.seen.filter((e) => e.method === 'auth.userLogin').length, 'a silent new login').toBeGreaterThan(loginsBefore);
    // The stored relay token too old to use (more than 11 h).
    await page.evaluate(async () => {
      const { Vault } = await import('./vault.js');
      const v = new Vault();
      const rec = await v.read();
      if (rec && rec.relay) rec.relay.at = Date.now() - 13 * 3600_000;
      await v.write(rec);
    });
    await reloadOnce('expired relay token');
    await page.screenshot({ path: resolve(ARTIFACTS, 'remember-reloads.png') });
    expect(errors).toEqual([]);
  });

  test('a plaintext password from an older version moves into the vault; unchecking the box deletes it', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    account.allow(tuner.user, { inserts: true });
    account.setPerson(tuner.user, { username: 'tuner_listener', chosen: true, notice: '' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(appUrl);
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
    await page.evaluate(({ u, p }) => { localStorage.setItem('melodica.email', u); localStorage.setItem('melodica.password', p); }, { u: tuner.user, p: tuner.password });
    await page.reload();
    // Logged in with the moved credential, and no plain text left.
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 30_000 });
    await expect(page.locator('#app')).not.toHaveAttribute('data-restoring', 'true', { timeout: 30_000 });
    const dump = await storageDump(page);
    expect(dump.text.includes(tuner.password)).toBe(false);
    expect(dump.databases).toContain('melodica-vault');
    await page.click('#account summary');
    await expect(page.locator('#remember-menu')).toBeChecked();
    await page.uncheck('#remember-menu');
    await expect.poll(async () => (await storageDump(page)).databases, { timeout: 5_000 }).not.toContain('melodica-vault');
    // Still playing in this tab; the next start shows the login card.
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'player');
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
    expect(errors).toEqual([]);
  });
});

// Scrobbling (web/scrobble.js) against the contract fake of spacegho.st/scrobble/
// (tests/tools/fake-scrobble.mjs): on by default, with a notice once; "playing now" at
// each song start, with the relay token; the tuner's tracks are 10 s, under the 30 s
// minimum, so no listen is submitted (the threshold itself is in node-unit); never an
// insert; the last 15 listens, then more on scroll; the settings; crew only when the
// server says so; logout clears the listens. The insert test runs last: the workflow's
// tuner report reads the insert steps from the tuner's log, which each begin() resets.
// The listens scroll inside their own box (about 15 rows; at most 60vh on phones): the
// page's own scrolling never loads more, scrolling the box does, and the page footer
// stays reachable below it.
// The listens are the shared Scrobbles UI's (mountListens into #sui-listens, the box).
const LISTEN_ROWS = '#sui-listens li.hist';
async function scrollListensBox(page, width) {
  const box = page.locator('#sui-listens');
  await expect.poll(async () => page.locator(LISTEN_ROWS).count()).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  const first = await page.locator(LISTEN_ROWS).count();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(800);
  expect(await page.locator(LISTEN_ROWS).count(), 'scrolling the page loads nothing').toBe(first);
  expect(first, 'one page at first').toBeLessThan(40);
  for (let i = 0; i < 8 && await page.locator(LISTEN_ROWS).count() < 40; i++) {
    await box.evaluate((b) => { b.scrollTop = b.scrollHeight; });
    await page.waitForTimeout(700);
  }
  if (await page.locator(LISTEN_ROWS).count() !== 40) {
    console.log('listens scroll diagnostics:', JSON.stringify(await box.evaluate((b) => ({
      client: b.clientHeight, scroll: b.scrollHeight, top: b.scrollTop,
      overflow: getComputedStyle(b).overflowY, box: b.getBoundingClientRect().toJSON(),
      sentinel: b.querySelector('.sentinel')?.getBoundingClientRect().toJSON(),
      note: b.querySelector('.loading')?.textContent,
    }))));
    console.log('listens page requests:', JSON.stringify(scrobbles.requests.filter((r) => /me(?:\/listens)?/.test(r))));
  }
  await expect(page.locator(LISTEN_ROWS)).toHaveCount(40);
  expect(await box.evaluate((b) => [...b.querySelectorAll('*')].filter((e) => e !== b && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight).length), 'no nested scrollbar').toBe(0);
  const m = await box.evaluate((b) => ({ client: b.clientHeight, scroll: b.scrollHeight, rem: parseFloat(getComputedStyle(document.documentElement).fontSize), vh: innerHeight, overflow: getComputedStyle(b).overflowY }));
  report[`listensBox${width}`] = m;
  expect(m.overflow).toBe('auto');
  expect(m.scroll, 'the box scrolls on its own').toBeGreaterThan(m.client);
  expect(m.client, 'about 15 rows tall at most').toBeLessThanOrEqual(Math.ceil(15 * 3.3 * m.rem) + 1);
  if (width <= 760) expect(m.client, 'at most 60vh on phones').toBeLessThanOrEqual(Math.ceil(0.6 * m.vh) + 1);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator('footer.foot')).toBeInViewport();
}

// ---------------------------------------------------------------- the app shell (0.11.0)
// Every /melodica/ route is one document: the bar stays pinned to the bottom of the
// viewport on every route and at every scroll position, and the audio never stops.
const SHELL_ROUTES = ['home', 'listens', 'leaderboard', 'map', 'account', 'extension', 'app'];
const shellPath = (k) => (k === 'home' ? '/melodica/' : `/melodica/${k}/`);

// The bar's box: its bottom is the viewport's bottom, whatever the scroll.
async function barAt(page) {
  return page.evaluate(() => {
    const r = document.getElementById('bar').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, vh: innerHeight, position: getComputedStyle(document.getElementById('bar')).position };
  });
}

async function checkRouteScroll(page, k, width) {
  const out = [];
  for (const where of ['top', 'middle', 'bottom']) {
    await page.evaluate((w) => {
      const max = document.documentElement.scrollHeight - innerHeight;
      scrollTo(0, w === 'top' ? 0 : w === 'middle' ? Math.round(max / 2) : max);
    }, where);
    await page.waitForTimeout(250);
    const b = await barAt(page);
    out.push({ where, ...b });
    expect(b.position, `${k} ${width} ${where}: fixed`).toBe('fixed');
    expect(Math.abs(b.bottom - b.vh), `${k} ${width} ${where}: bar bottom ${b.bottom} vs viewport ${b.vh}`).toBeLessThanOrEqual(0.5);
    await expect(page.locator('#bar')).toBeInViewport();
    if (where === 'bottom') {
      // Nothing of the route ends up under the bar: the last content clears its top.
      const last = await page.evaluate(() => {
        const v = document.getElementById(document.getElementById('app').dataset.route === 'app' ? 'view-player' : 'route-body');
        return v.getBoundingClientRect().bottom;
      });
      expect(last, `${k} ${width}: content clears the bar`).toBeLessThanOrEqual(b.top + 1);
      await page.screenshot({ path: resolve(ARTIFACTS, `shell-${k}-${width}.png`) });
    }
  }
  return out;
}

async function audioTime(page) {
  return page.evaluate(() => { const a = document.getElementById('audio'); return { t: a.currentTime, paused: a.paused, src: a.currentSrc }; });
}

test.describe.serial('the app shell', () => {
  const key = () => `e:${tuner.user.trim().toLowerCase()}`;
  test.beforeEach(() => { scrobbles.reset(); scrobbles.defaultOn = true; scrobbles.seedCount = 40; scrobbles.crewViewers.add(key()); });
  test.afterAll(() => { if (scrobbles) { scrobbles.reset(); scrobbles.defaultOn = false; } });

  test('every route while playing at 1280 and 390: one document, the bar pinned to the viewport bottom, the audio advancing', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    test.setTimeout(240_000);
    const evidence = await begin(page, { every: 0, scrobble: true });
    await expect.poll(async () => (await audioTime(page)).t, { timeout: 20_000 }).toBeGreaterThan(0.5);
    await page.evaluate(() => { window.__shellDoc = Math.random(); });
    const doc = await page.evaluate(() => window.__shellDoc);
    const loads = [];
    page.on('domcontentloaded', () => loads.push(page.url()));
    const shell = {};
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width > 760 ? 800 : 844 });
      for (const k of SHELL_ROUTES) {
        const before = await audioTime(page);
        await page.click(`.top a[data-k="${k}"]`);
        await expect(page).toHaveURL(`${origin}${shellPath(k)}`);
        await expect(page.locator('#app')).toHaveAttribute('data-route', k);
        await expect(page.locator(`.top a[data-k="${k}"]`)).toHaveAttribute('aria-current', 'page');
        if (k === 'home') await expect(page.locator('#route-body')).toContainText('Launch the player', { timeout: 10_000 });
        if (k === 'extension') await expect(page.locator('#route-body h1, #route-body h2').first()).toBeVisible({ timeout: 10_000 });
        if (k === 'listens') {
          await expect(page.locator('#route-body li.hist').first()).toBeVisible({ timeout: 10_000 });
          // The shared rows as ui/ draws them: cover | title and artist next to it, left-aligned | time on the right.
          const g = await page.evaluate(() => {
            const row = document.querySelector('#route-body .sui li.hist');
            const box = (sel) => { const e = row.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
            const r = row.getBoundingClientRect();
            const cover = row.querySelector('img') ? row.querySelector('img').getBoundingClientRect() : null;
            return { row: { x: r.x, right: r.right, w: r.width }, cover: cover && { x: cover.x, right: cover.right }, title: box('.hist-title'), when: box('.hist-when'), align: getComputedStyle(row.querySelector('.hist-meta')).textAlign, list: row.parentElement.getBoundingClientRect().width };
          });
          expect(g.title.x - g.cover.right, `${width}: title next to the cover`).toBeLessThanOrEqual(24);
          expect(g.title.x - g.cover.right).toBeGreaterThanOrEqual(0);
          expect(['left', 'start']).toContain(g.align);
          expect(g.row.right - g.when.right, `${width}: time in the right column`).toBeLessThanOrEqual(16);
          expect(g.row.w, `${width}: rows fill the list`).toBeGreaterThanOrEqual(g.list - 2);
        }
        if (k === 'leaderboard') await expect(page.locator('#route-body')).toContainText('Slow Light', { timeout: 10_000 });
        if (k === 'map') await expect(page.locator('#route-body svg').first()).toBeVisible({ timeout: 10_000 });
        if (k === 'account') await expect(page.locator('#route-body .account-menu')).toBeVisible();
        if (k === 'app') await expect(page.locator('#view-player')).toBeVisible();
        await expect(page.locator('#mini-title')).not.toHaveText('');
        shell[`${k}${width}`] = await checkRouteScroll(page, k, width);
        await page.waitForTimeout(600);
        const after = await audioTime(page);
        expect(after.paused, `${k} ${width}: still playing`).toBe(false);
        // The same song keeps advancing, or the station moved on to the next one.
        if (after.src === before.src) expect(after.t, `${k} ${width}: currentTime advances`).toBeGreaterThan(before.t);
      }
    }
    expect(await page.evaluate(() => window.__shellDoc), 'the same document throughout').toBe(doc);
    expect(loads, 'no page loads, only history entries').toEqual([]);
    // Back and forward walk the routes inside the document too.
    await page.goBack();
    await expect(page.locator('#app')).toHaveAttribute('data-route', 'extension');
    await page.goForward();
    await expect(page.locator('#app')).toHaveAttribute('data-route', 'app');
    expect((await audioTime(page)).paused).toBe(false);
    // The bar's cover and title open the player.
    await page.click('#site-nav a[data-k="leaderboard"]');
    await page.click('#bar-expand');
    await expect(page.locator('#app')).toHaveAttribute('data-route', 'app');
    report.shell = shell;
    expect(evidence.errors, 'page errors').toEqual([]);
  });

  test('deep links and reloads: each route is served the shell; signed out, the bar says Sign in to play', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    // This test is about serving the shell. The silent spacegho.st sign-in a panel route
    // tries (a redirect through /oauth/authorize that lands back later) has its own tests.
    await page.addInitScript(() => { try { sessionStorage.setItem('melodica.account.panel-silent', '1'); } catch (_) { /* unavailable */ } });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width > 760 ? 800 : 844 });
      for (const k of SHELL_ROUTES) {
        // A panel may make the silent OAuth round trip before its load event.
        // Wait for the document and the completed account bootstrap, then keep
        // the same route/bar assertions across the resulting navigation.
        await page.goto(`${origin}${shellPath(k)}`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#app')).toHaveAttribute('data-account-ready', 'true');
        await expect(page.locator('#app')).toHaveAttribute('data-route', k);
        await expect(page.locator('#bar')).toHaveAttribute('data-state', 'signin', { timeout: 15_000 });
        await expect(page.locator('#bar-signin')).toBeVisible();
        const b = await barAt(page);
        expect(Math.abs(b.bottom - b.vh), `${k} ${width} signed out`).toBeLessThanOrEqual(0.5);
        if (k !== 'app') {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await expect(page.locator('#app')).toHaveAttribute('data-account-ready', 'true');
        }
        await expect(page.locator('#app')).toHaveAttribute('data-route', k);
      }
      await page.screenshot({ path: resolve(ARTIFACTS, `shell-signedout-${width}.png`) });
    }
  });
});

// ---------------------------------------------------------------- the map on a phone (0.11.1)
// knewter's report: Android Chrome, crew, signed in on spacegho.st with GitHub, no map at all.
for (const width of [412, 1280]) test.describe(`the crew map at ${width}`, () => {
  const { defaultBrowserType, ...phone } = devices['Pixel 7'];
  test.use(width === 412 ? { ...phone, viewport: { width, height: 839 } } : { viewport: { width, height: 800 } });
  test('signed out it offers Sign in with GitHub back to the map; with only the spacegho.st cookie a crew member sees the map', async ({ page, context }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      const expected = /Failed to load resource/.test(m.text()) || /WebSocket connection to 'ws:\/\/localhost:\d+\/scrobble\/api\/live' failed: HTTP Authentication failed/.test(m.text());
      if (m.type() === 'error' && !expected) errors.push(m.text());
    });
    await page.goto(`${origin}/melodica/map/`);
    await expect(page.locator('#app')).toHaveAttribute('data-route', 'map');
    await expect(page.locator('#site-nav a[data-k="map"]')).toBeVisible();
    const signin = page.locator('#route-view .route-notice a', { hasText: 'Sign in with GitHub to see the crew map' });
    await expect(signin).toBeVisible({ timeout: 15_000 });
    expect(await signin.getAttribute('href')).toBe('/scrobble/auth/start?next=%2Fmelodica%2Fmap%2F');
    await page.screenshot({ path: resolve(ARTIFACTS, `map-signedout-${width}.png`) });
    // Signed in on spacegho.st (the cookie), never in the player: the map itself.
    const k = 'u:knewter-test';
    scrobbles.crewViewers.add(k);
    scrobbles.cookies.set('crew-cookie', k);
    await context.addCookies([{ name: 'scrobble_session', value: 'crew-cookie', url: origin }]);
    await page.reload();
    await expect(page.locator('#route-body svg .fm-prov').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#site-nav a[data-k="map"]')).toBeVisible();
    await expect(page.locator('#route-view .route-notice')).toHaveCount(0);
    await expect(page.locator('#route-body')).not.toContainText(/undefined|NaN/);
    await expect(page.locator('#bar')).toBeVisible();
    await page.getByRole('button', { name: 'Got it', exact: true }).click();
    await page.locator('#route-body svg').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(ARTIFACTS, `map-crew-${width}.png`) });
    // Signed in but not crew: told so, with the button, never blank.
    scrobbles.crewViewers.delete(k);
    await page.reload();
    await expect(page.locator('#route-view .route-notice')).toContainText('invite-only', { timeout: 15_000 });
    await expect(signin).toBeVisible();
    expect(errors, 'console errors').toEqual([]);
    await context.clearCookies();
  });
  test('an OAuth session alone silently signs in and returns to the crew map', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    // Complete the provider callback locally; keep every request in this test on its fixture server.
    const start = await page.request.get(`${origin}/oauth/github/start`, { maxRedirects: 0 });
    const state = new URL(start.headers().location).searchParams.get('state');
    await page.goto(`${origin}/oauth/github/callback?code=code-crew_map&state=${encodeURIComponent(state)}`);
    await expect(page).toHaveURL(`${origin}/oauth/`);
    await page.route(`${origin}/oauth/token`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      scrobbles.crewViewers.add(account.who(body.access_token));
      await route.fulfill({ response });
    });
    const authorize = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/oauth/authorize') authorize.push(url.searchParams.get('prompt'));
    });
    await page.goto(`${origin}/melodica/map/`);
    await expect(page.locator('#route-body svg .fm-prov').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#site-nav a[data-k="map"]')).toBeVisible();
    await expect(page).toHaveURL(`${origin}/melodica/map/`);
    await expect(page.locator('#route-view .route-notice')).toHaveCount(0);
    await expect(page.locator('#route-body')).not.toContainText(/undefined|NaN/);
    expect(authorize).toEqual(['none']);
    await page.getByRole('button', { name: 'Got it', exact: true }).click();
    await page.locator('#route-body svg').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(ARTIFACTS, `map-oauth-${width}.png`) });
  });
});

// The player first, then a panel route: the silent spacegho.st sign-in (prompt=none) runs
// on arriving at the panel, not only when the page was opened on it. A spacegho.st account
// that is crew gets the map, one that is not gets the invite-only text, none gets the button.
test.describe('the map after the player (silent sign-in on the route change)', () => {
  for (const crew of [true, false]) {
    test(`${crew ? 'crew' : 'not crew'}: app, then the Map link`, async ({ page, context }) => {
      test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
      scrobbles.crewAccounts = crew;
      await signInAccount(page, `crewmap-${crew ? 'a' : 'b'}@example.com`, true);
      await context.clearCookies({ name: 'scrobble_session' });
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.goto(`${origin}${APP_PATH}`);
      await page.click('#site-nav a[data-k="map"]');
      await expect(page).toHaveURL(`${origin}/melodica/map/`, { timeout: 20_000 });
      if (crew) {
        await expect(page.locator('#route-body svg').first()).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('#route-view .route-notice')).toHaveCount(0);
      } else {
        await expect(page.locator('#route-view .route-notice')).toContainText('invite-only', { timeout: 20_000 });
        await expect(page.locator('#route-view .route-notice a', { hasText: 'Sign in with GitHub' })).toBeVisible();
      }
      scrobbles.crewAccounts = false;
    });
  }
});

test('the public hub stays on home without starting account sign-in', async ({ page }) => {
  test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
  const authorize = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/oauth/authorize') authorize.push(url.searchParams.get('prompt'));
  });
  await page.goto(`${origin}/melodica/`);
  await expect(page.locator('#app')).toHaveAttribute('data-account-ready', 'true');
  await expect(page.locator('[data-hub-board]')).toContainText('Sign in to Melodica');
  await expect(page.locator('[data-hub-board] .boards')).toHaveCount(0);
  await expect(page.locator('[data-hub-me]')).toContainText('Sign in with spacegho.st');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'home');
  await expect(page).toHaveURL(`${origin}/melodica/`);
  await expect(page.locator('#bar')).toHaveAttribute('data-state', 'signin');
  expect(authorize).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('melodica.account.return'))).toBeNull();
});

test.describe('live hub panels', () => {
  for (const width of [390, 1280]) for (const transport of ['socket', 'poll']) {
    test(`${width}: listening, counts and crew change without reload over ${transport}`, async ({ page, context }) => {
      test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
      scrobbles.reset();
      scrobbles.seedCount = 0;
      const key = 'e:hub-fixture';
      scrobbles.cookies.set('hub-session', key);
      scrobbles.crewViewers.add(key);
      await context.addCookies([{ name: 'scrobble_session', value: 'hub-session', url: origin }]);
      await page.addInitScript(() => sessionStorage.setItem('melodica.account.panel-silent', '1'));
      if (transport === 'poll') await page.routeWebSocket('**/scrobble/api/live', (ws) => ws.close());
      await page.setViewportSize({ width, height: 900 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${origin}/melodica/`);
      const me = page.locator('[data-hub-me]');
      const crew = page.locator('[data-hub-live]');
      await expect(me.locator('.sui-np')).toContainText('Nothing playing');
      await expect(crew.locator('.live-strip')).toBeAttached();
      await expect(page.locator('#site-nav a[data-k="map"]')).toBeVisible();
      if (transport === 'poll') {
        await expect.poll(() => scrobbles.requests.some((r) => r.includes('live/poll'))).toBe(true);
        await page.waitForTimeout(500);
      } else await expect.poll(() => scrobbles.requests.filter((r) => r === 'WS /scrobble/api/live').length).toBeGreaterThan(0);
      await page.evaluate(() => { window.__hubDoc = 'same-document'; });
      const title = `Live Hub ${width} ${transport}`;
      const started = Date.now();
      const track = { title, artist: 'Hub Artist', duration_ms: 200000, started_at: started };
      scrobbles.emit(key, { type: 'playing', now_playing: track });
      scrobbles.emit(key, { type: 'listen', listen: { id: `hub-${width}-${transport}`, title: 'Finished Hub Song', artist: 'Hub Artist', listened_at: Math.floor(started / 1000), session: Math.floor(started / 1000) } });
      scrobbles.emit(key, { type: 'nowplaying', members: [{ github: 'hub-crew', name: 'Hub Crew', avatar: '', track }] });
      await expect(me.locator('.sui-np b')).toHaveText(title, { timeout: 2000 });
      await expect(me.locator('.hist-title').first()).toHaveText('Finished Hub Song', { timeout: 2000 });
      await expect(me.locator('.sui-stats dd').first()).toHaveText('1', { timeout: 2000 });
      await expect(crew.locator('.live-card .t')).toHaveText(title, { timeout: 2000 });
      expect(Date.now() - started, 'all hub panels update within two seconds').toBeLessThan(2000);
      expect(await page.evaluate(() => window.__hubDoc)).toBe('same-document');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const bar = await barAt(page);
      expect(Math.abs(bar.bottom - bar.vh)).toBeLessThanOrEqual(0.5);
      await page.screenshot({ path: resolve(ARTIFACTS, `hub-live-${width}-${transport}.png`) });
      const stored = scrobbles.accounts.get(key);
      stored.now = track;
      stored.listens.push({ id: `hub-${width}-${transport}`, title: 'Finished Hub Song', artist: 'Hub Artist', listened_at: Math.floor(started / 1000), session: Math.floor(started / 1000) });
      const socketsBefore = scrobbles.requests.filter((r) => r === 'WS /scrobble/api/live').length;
      await page.click('#site-nav a[data-k="listens"]');
      await expect(page.locator('#app')).toHaveAttribute('data-route', 'listens');
      const listens = page.locator('#route-body .sui-listens');
      await expect(listens.locator('.sui-np b')).toHaveText(title);
      if (transport === 'poll') {
        const before = scrobbles.requests.filter((r) => r.includes('live/poll')).length;
        await expect.poll(() => scrobbles.requests.filter((r) => r.includes('live/poll')).length).toBeGreaterThan(before);
        await page.waitForTimeout(500);
      } else await expect.poll(() => scrobbles.requests.filter((r) => r === 'WS /scrobble/api/live').length).toBeGreaterThan(socketsBefore);
      const next = Date.now();
      scrobbles.emit(key, { type: 'playing', now_playing: { ...track, title: 'Next Hub Song' } });
      scrobbles.emit(key, { type: 'listen', listen: { id: `next-${width}-${transport}`, title: 'Another Listen', artist: 'Hub Artist', listened_at: Math.floor(next / 1000), session: Math.floor(next / 1000) } });
      await expect(listens.locator('.sui-np b')).toHaveText('Next Hub Song', { timeout: 2000 });
      await expect(listens.locator('.hist-title').first()).toHaveText('Another Listen', { timeout: 2000 });
      await expect(listens.locator('.sui-stats dd').first()).toHaveText('2');
      expect(Date.now() - next, 'listens route updates within two seconds').toBeLessThan(2000);
      expect(await page.evaluate(() => window.__hubDoc)).toBe('same-document');
      expect(errors).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------- Resume (0.11.0)
// The tuner's tones are 10 s long; these tests stretch them (MP3 frames repeated)
// so a song can be played to 1:23. Every audio request the page makes is recorded.
// An MP3 whose first frame is a Xing/Info header states its own length (10 s here);
// without it the browser reckons the length from the size, so repeats count.
function withoutInfoFrame(buf) {
  let o = 0;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') o = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  const h = buf.readUInt32BE(o);
  if ((h >>> 21) !== 0x7ff) return buf.subarray(o);
  const br = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][(h >>> 12) & 0xf] * 1000;
  const sr = [44100, 48000, 32000][(h >>> 10) & 3];
  const len = Math.floor((144 * br) / sr) + ((h >>> 9) & 1);
  const first = buf.subarray(o, o + len).toString('latin1');
  return first.includes('Xing') || first.includes('Info') ? buf.subarray(o + len) : buf.subarray(o);
}

async function longAudio(page, { refuse = () => false } = {}) {
  const seen = [];
  const cache = new Map();
  await page.route(/\/audio\/[^/?]+\.(mp3|m4a)(\?|$)/, async (route) => {
    const u = route.request().url();
    seen.push(u);
    if (refuse(u)) { await route.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*' }, body: 'expired' }); return; }
    if (!cache.has(u)) {
      if (page.isClosed()) return;
      // The MP3 of the same song (the tuner's android partner hands out m4a, which
      // does not concatenate); the browser sniffs the type.
      const headers = { ...route.request().headers() }; delete headers.range;
      let r;
      try { r = await route.fetch({ url: u.replace(/-\d+\.m4a(\?|$)/, '-128.mp3$1'), headers }); } catch { return; } // the test has ended
      let one;
      try { one = withoutInfoFrame(await r.body()); } catch { return; } // the page went away meanwhile
      cache.set(u, Buffer.concat(Array(14).fill(one)));
    }
    const body = cache.get(u);
    const cors = { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
    // Ranges, so the media element can seek.
    const m = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (m) {
      const from = Number(m[1]);
      const to = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      const part = body.subarray(from, to + 1);
      await route.fulfill({ status: 206, body: part, headers: { ...cors, 'content-range': `bytes ${from}-${to}/${body.length}`, 'content-length': String(part.length) } });
      return;
    }
    await route.fulfill({ status: 200, body, headers: { ...cors, 'content-length': String(body.length) } });
  });
  return seen;
}

// Plays to `at` seconds (seeking just before it, then playing through it).
async function playTo(page, at) {
  await expect.poll(async () => page.evaluate(() => { const a = document.getElementById('audio'); return Number.isFinite(a.duration) ? a.duration : 0; }), { timeout: 20_000 }).toBeGreaterThan(at + 5);
  await page.evaluate((t) => { document.getElementById('audio').currentTime = t; }, at - 1.5);
  try {
    await expect.poll(async () => (await audioTime(page)).t, { timeout: 10_000 }).toBeGreaterThanOrEqual(at);
  } catch (err) {
    console.log('seek state', await page.locator('#audio').evaluate((a) => ({ time: a.currentTime, duration: a.duration, paused: a.paused, ended: a.ended, ready: a.readyState, network: a.networkState, error: a.error && a.error.code })));
    throw err;
  }
  return (await audioTime(page)).t;
}

const hasCopy = (page, token) => page.evaluate(async (t) => {
  const c = await caches.open('melodica-audio-v1');
  return !!(await c.match(`${location.origin}/melodica/__audio/${encodeURIComponent(t)}`));
}, token);
const copies = (page) => page.evaluate(async () => (await (await caches.open('melodica-audio-v1')).keys()).map((r) => decodeURIComponent(r.url.split('/__audio/')[1])));
const songToken = (page) => page.evaluate(() => { const li = document.querySelector('#history li[data-token]'); return li ? li.dataset.token : ''; });

async function expectResumedAt(page, at, info) {
  await expect(page.locator('#bar-resume')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#bar-resume')).toHaveText(`Resume at ${fmt(at)}`);
  await page.screenshot({ path: resolve(ARTIFACTS, `resume-${info}.png`) });
  await page.click('#bar-resume');
  await expect.poll(async () => (await audioTime(page)).paused, { timeout: 20_000 }).toBe(false);
  const t = (await audioTime(page)).t;
  expect(Math.abs(t - at), `${info}: resumed at ${t}, left at ${at}`).toBeLessThanOrEqual(1);
  await expect(page.locator('#bar-resume')).toBeHidden();
  return t;
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

test.describe.serial('Resume: the last song on this device', () => {
  test('play to 1:23, leave the site, come back with history.back: Resume plays on from 1:23', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    test.setTimeout(180_000);
    await longAudio(page);
    await begin(page, { every: 0 });
    const title = (await page.locator('#np-title').textContent()).trim();
    const at = await playTo(page, 83);
    await page.goto(`${tuner.http}/`); // another site
    await page.goBack();
    await expect(page.locator('#mini-title')).toHaveText(title, { timeout: 30_000 });
    // Where it was when the page went away (it played on while the test navigated).
    const left = await page.evaluate(() => { try { return JSON.parse(sessionStorage.getItem('melodica.lastPosition')).p; } catch (_) { return null; } });
    expect(left, 'the position at pagehide').not.toBeNull();
    expect(left).toBeGreaterThanOrEqual(at);
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'player');
    expect((await audioTime(page)).paused, 'shown paused').toBe(true);
    await expectResumedAt(page, left, 'back');
    await expect(page.locator('#np-title')).toHaveText(title);
  });

  test('a reload: the same, paused at its position until Resume', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    test.setTimeout(180_000);
    await longAudio(page);
    await begin(page, { every: 0 });
    const title = (await page.locator('#np-title').textContent()).trim();
    await playTo(page, 83);
    await page.reload();
    await expect(page.locator('#mini-title')).toHaveText(title, { timeout: 30_000 });
    const at = await page.evaluate(() => JSON.parse(sessionStorage.getItem('melodica.lastPosition')).p);
    expect(at).toBeGreaterThanOrEqual(83);
    await expect(page.locator('#time-cur')).toHaveText(fmt(at));
    await page.waitForTimeout(1500);
    expect((await audioTime(page)).paused, 'nothing plays before Resume').toBe(true);
    await expectResumedAt(page, at, 'reload');
  });

  test("an expired link (403): Resume plays this device's copy at its position, then the station goes on", async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    test.setTimeout(240_000);
    let expired = new Set();
    const seen = await longAudio(page, { refuse: (u) => expired.has(u) });
    await begin(page, { every: 0 });
    const title = (await page.locator('#np-title').textContent()).trim();
    const token = await songToken(page);
    expect(token).not.toBe('');
    await expect.poll(() => hasCopy(page, token), { timeout: 30_000, message: 'a copy of the playing song' }).toBe(true);
    expect((await copies(page)).length, 'the playing song and the next at most').toBeLessThanOrEqual(2);
    const at = await playTo(page, 83);
    // Every link handed out so far now answers 403, like an expired Pandora link.
    expired = new Set(seen);
    await page.reload();
    await expect(page.locator('#mini-title')).toHaveText(title, { timeout: 30_000 });
    await expectResumedAt(page, at, 'expired');
    expect((await audioTime(page)).src, 'played from the copy').toMatch(/^blob:/);
    await expect(page.locator('#player-message')).toContainText("That song's link expired");
    // To the end of it: the next song is from a new playlist, and the copy is deleted.
    const before = seen.length;
    await page.evaluate(() => { const a = document.getElementById('audio'); a.currentTime = a.duration - 1; });
    await expect(page.locator('#np-title')).not.toHaveText(title, { timeout: 30_000 });
    await expect.poll(async () => (await audioTime(page)).paused, { timeout: 20_000 }).toBe(false);
    expect((await audioTime(page)).src).not.toMatch(/^blob:/);
    expect(seen.slice(before).some((u) => !expired.has(u)), 'a fresh link').toBe(true);
    await expect.poll(() => hasCopy(page, token), { timeout: 10_000 }).toBe(false);
  });

  test('the link and the copy both gone: "That song\'s link expired; continuing the station"', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    test.setTimeout(180_000);
    let expired = new Set();
    const seen = await longAudio(page, { refuse: (u) => expired.has(u) });
    await begin(page, { every: 0 });
    const title = (await page.locator('#np-title').textContent()).trim();
    await playTo(page, 20);
    expired = new Set(seen);
    await page.evaluate(async () => caches.delete('melodica-audio-v1'));
    await page.reload();
    await expect(page.locator('#bar-resume')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(async () => caches.delete('melodica-audio-v1')); // a copy started again before the reload finished
    await page.click('#bar-resume');
    await expect(page.locator('#player-message')).toHaveText("That song's link expired; continuing the station", { timeout: 20_000 });
    await expect(page.locator('#np-title')).not.toHaveText(title, { timeout: 30_000 });
    await expect.poll(async () => (await audioTime(page)).paused, { timeout: 20_000 }).toBe(false);
  });
});

// ---------------------------------------------------------------- first paint (0.11.2)
// Measured the same way for any build: "visible" is the first frame with the player
// shown and not "Restoring…"; "interactive" the first frame with station buttons and
// the restore done (data-ready, or for builds before 0.11.2 the player after the
// restore). Both relative to DOMContentLoaded.
const PAINT_PROBE = () => {
  window.__paint = {};
  try { window.__paint.snap = !!localStorage.getItem('melodica.snapshot'); } catch (_) { window.__paint.snap = null; }
  const tick = () => {
    const app = document.getElementById('app');
    const vp = document.getElementById('view-player');
    const p = window.__paint;
    if (app && vp && !vp.hidden && !app.dataset.restoring && p.visible === undefined) {
      p.visible = performance.now();
      p.title = document.getElementById('np-title').textContent;
    }
    if (p.visible !== undefined && p.interactive === undefined && document.querySelector('#station-list button.station')
      && (app.dataset.ready === 'true' || (app.dataset.view === 'player' && !app.dataset.restoring && !('snapshot' in app.dataset) && !('ready' in app.dataset) && !window.__mwTiming))) {
      p.interactive = performance.now();
      p.resume = !document.getElementById('bar-resume').hidden;
    }
    if (p.interactive === undefined) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
const VISIBLE_MS = Number(process.env.MW_VISIBLE_MS || 100);
const INTERACTIVE_MS = Number(process.env.MW_INTERACTIVE_MS || 300);
async function paintTimes(page) {
  await expect.poll(() => page.evaluate(() => window.__paint && window.__paint.interactive !== undefined), { timeout: 30_000 }).toBe(true);
  return page.evaluate(() => {
    const dcl = performance.getEntriesByType('navigation')[0].domContentLoadedEventStart;
    const t = window.__mwTiming || {};
    return { visible: Math.round(window.__paint.visible - dcl), interactive: Math.round(window.__paint.interactive - dcl), title: window.__paint.title, resume: window.__paint.resume, snap: window.__paint.snap, marks: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v - dcl)])) };
  });
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('first paint after a reload: the player in under 100 ms of DOMContentLoaded, live in under 300 ms (1280 and 390)', async ({ page }, info) => {
  test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
  test.setTimeout(180_000);
  await page.addInitScript(PAINT_PROBE);
  await begin(page, { every: 0 });
  await page.waitForTimeout(2500); // the snapshot and the session are written
  const lastTitle = await page.locator('#np-title').textContent();
  await page.route(/\/(melodica\/api\/|oauth\/)/, async (route) => { await new Promise((ok) => setTimeout(ok, 250)); await route.fallback(); });
  const out = {};
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width > 760 ? 800 : 844 });
    const runs = [];
    for (let i = 0; i < 5; i++) {
      // As hosted: no ?api= (so the page also looks for the extension, which is not
      // installed here), and 250 ms of network on every relay and account request.
      await page.goto(`${origin}${APP_PATH}`);
      runs.push(await paintTimes(page));
      await expect(page.locator('#login-email')).toBeHidden();
    }
    out[width] = { runs, visible: median(runs.map((r) => r.visible)), interactive: median(runs.map((r) => r.interactive)) };
  }
  report.firstPaint = out;
  console.log(`first paint (standalone): ${JSON.stringify(out)}`);
  await info.attach('first-paint', { body: JSON.stringify(out, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: resolve(ARTIFACTS, 'first-paint-390.png') });
  for (const width of [1280, 390]) {
    for (const run of out[width].runs) {
      expect(run.title, `${width}: last-known song at first paint`).toBe(lastTitle);
      expect(run.resume, `${width}: Resume is ready with the controls`).toBe(true);
      expect(run.visible, `${width}: player visible (ms after DOMContentLoaded)`).toBeLessThan(VISIBLE_MS);
      expect(run.interactive, `${width}: controls live (ms after DOMContentLoaded)`).toBeLessThan(INTERACTIVE_MS);
    }
  }
  const playlists = () => relay.seen.filter((r) => r.method === 'station.getPlaylist').length;
  const before = playlists();
  await page.click('#btn-play');
  await expect.poll(() => page.locator('#audio').evaluate((a) => !a.paused)).toBe(true);
  expect(playlists(), 'immediate Play resumes the remembered song').toBe(before);
});

// ---------------------------------------------------------------- Play in melodica (0.11.1)
test("?seed=artist:<name>&autoplay=1 (the map's ▶ Play fallback): a station from that artist plays", async ({ page }) => {
  test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
  test.setTimeout(120_000);
  await begin(page, { every: 0 });
  const artist = (await page.locator('#np-artist').textContent()).trim();
  expect(artist).not.toBe('');
  const before = await page.locator('#station-list li').count();
  await page.goto(`${appUrl}&seed=${encodeURIComponent(`artist:${artist}`)}&autoplay=1`);
  await expect(page.locator('#station-list li')).not.toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => page.locator('#station-list li').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(before);
  await expect(page.locator('#np-station')).toContainText(artist, { timeout: 30_000 });
  await expect.poll(async () => (await audioTime(page)).paused, { timeout: 20_000 }).toBe(false);
  expect(new URL(page.url()).searchParams.has('seed'), 'the seed is taken off the address').toBe(false);
  await expect(page.locator('#bar-resume')).toBeHidden();
  await page.screenshot({ path: resolve(ARTIFACTS, 'seed-artist.png') });
});

// ---------------------------------------------------------------- Sign in with GitHub (0.11.0)
test('the login card: Sign in with GitHub goes to spacegho.st GitHub sign-in, then the authorize round trip', async ({ page }) => {
  test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
  let started = '';
  await page.route(/\/oauth\/github\/start/, async (route) => { started = route.request().url(); await route.fulfill({ status: 200, contentType: 'text/plain', body: 'github' }); });
  await page.goto(appUrl);
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
  await expect(page.locator('#login-github')).toBeVisible();
  await page.screenshot({ path: resolve(ARTIFACTS, 'login-github.png') });
  await page.click('#login-github');
  await expect.poll(() => started).not.toBe('');
  const next = new URL(started).searchParams.get('next');
  expect(next).toMatch(/^\/oauth\/authorize\?/);
  const q = new URLSearchParams(next.split('?')[1]);
  expect(q.get('response_type')).toBe('code');
  expect(q.get('code_challenge_method')).toBe('S256');
  expect(q.get('redirect_uri')).toBe(`${origin}/melodica/app/`);
});

// (Before the scrobbling tests: the CI's tuner report reads the log the last test leaves,
// and that one plays inserts.)
test.describe.serial('scrobbling to spacegho.st', () => {
  test('the submit response shows a deployment without waiting for a live event', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    await longAudio(page);
    scrobbles.deploymentFor = (l) => ({ season: '2026-11', counted: 1, units: 1.5, listens: [{ listened_at: l.listened_at,
      artist_name: l.artist, track_name: l.title, counted: true, units: 1.5, town: { key: l.artist.toLowerCase(), name: l.artist, armies: 4 },
      provinces: [{ key: 'indie rock', land: 'Rock', units: 1.5, stronghold: { name: 'Ironhold' } }] }] });
    try {
      await begin(page, { every: 0, scrobble: true });
      // The tuner metadata describes its short fixture. The extended media above
      // lets this presentation test cross a 32 s track's real listen threshold.
      await page.evaluate(async () => {
        const { ListenTracker } = await import('./scrobble.js');
        const due = ListenTracker.prototype.due;
        ListenTracker.prototype.due = function () { this.duration = 32; return due.call(this); };
        document.getElementById('audio').playbackRate = 4;
      });
      await expect(page.locator('#deploy-feedback')).toContainText('Your listen deployed 1.5 units to Ironhold');
      expect(scrobbles.events, 'the response alone supplied the feedback').toEqual([]);
      await expect.poll(() => scrobbles.posts.filter((p) => p.body.listen_type === 'single').length).toBe(1);
      await page.click('#site-nav a[data-k="listens"]');
      await expect(page.locator('#route-body .sui-dep').first()).toContainText('+1.5 ⚔ Ironhold');
      await page.screenshot({ path: resolve(ARTIFACTS, 'listen-deployment-response.png') });
    } finally { delete scrobbles.deploymentFor; }
  });

  test('at 390 wide: the listens scroll in their own box and the footer stays reachable', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    await page.setViewportSize({ width: 390, height: 844 });
    await begin(page, { every: 0, scrobble: true });
    await expect(page.locator('#listens-panel')).toBeVisible();
    await scrollListensBox(page, 390);
    await page.screenshot({ path: resolve(ARTIFACTS, 'scrobble-listens-390.png'), fullPage: true });
  });

  const key = () => `e:${tuner.user.trim().toLowerCase()}`;
  test.beforeEach(() => { scrobbles.reset(); scrobbles.defaultOn = true; scrobbles.seedCount = 40; });
  test.afterAll(() => { if (scrobbles) { scrobbles.reset(); scrobbles.defaultOn = false; } });

  test('settings: off stops submitting, the leaderboard toggle, crew only for GitHub, the server turning it off, logout clears', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    scrobbles.crewViewers.add(key());
    await begin(page, { every: 0, scrobble: true });
    await page.click('#account summary');
    await expect(page.locator('#scrobble-settings')).toBeVisible();
    await expect(page.locator('#scrobble-on')).toBeChecked();
    await expect(page.locator('#scrobble-board')).toBeChecked();
    await expect(page.locator('#scrobble-crew-wrap')).toBeVisible();
    await expect(page.locator('#scrobble-crew')).toHaveAttribute('href', `${origin}/melodica/map/`);
    await expect(page.locator('#scrobble-leaderboard')).toHaveAttribute('href', `${origin}/melodica/leaderboard/`);
    await expect(page.locator('#scrobble-dashboard')).toHaveAttribute('href', `${origin}/melodica/listens/`);
    await expect(page.locator('#username-change label')).toHaveText('Listener name (your username)');
    await page.screenshot({ path: resolve(ARTIFACTS, 'scrobble-settings.png') });

    await page.uncheck('#scrobble-board');
    await expect.poll(() => scrobbles.accounts.get(key()).settings.leaderboard).toBe(false);
    await page.uncheck('#scrobble-on');
    await expect.poll(() => scrobbles.accounts.get(key()).settings.scrobbling).toBe(false);
    await expect(page.locator('#scrobble-board')).toBeDisabled();
    const n = scrobbles.posts.length;
    const t = (await page.locator('#np-title').textContent()).trim();
    await page.click('#btn-next');
    await expect(page.locator('#np-title')).not.toHaveText(t, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect(scrobbles.posts.length, 'nothing sent while off').toBe(n);

    // On again; then the server turns it off (elsewhere): the next submit's 403 shows it here.
    if ((await page.locator('#account').getAttribute('open')) === null) await page.click('#account summary'); // closed by the click on next
    await page.check('#scrobble-on');
    await expect.poll(() => scrobbles.accounts.get(key()).settings.scrobbling).toBe(true);
    scrobbles.accounts.get(key()).settings.scrobbling = false;
    const t2 = (await page.locator('#np-title').textContent()).trim();
    await page.click('#btn-next');
    await expect(page.locator('#np-title')).not.toHaveText(t2, { timeout: 20_000 });
    await expect(page.locator('#scrobble-on')).not.toBeChecked({ timeout: 10_000 });

    if ((await page.locator('#account').getAttribute('open')) === null) await page.click('#account summary');
    await page.click('#logout');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
    await expect(page.locator(LISTEN_ROWS)).toHaveCount(0);
    await expect(page.locator('#listens-panel')).toBeHidden();
    await expect(page.locator('#scrobble-settings')).toBeHidden();
  });

  test('panels: leaderboard, live listens, and the map for the crew, at 1280 and 390 wide', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    scrobbles.crewViewers.add(key());
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const csp = [];
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => (window.__csp = window.__csp || []).push(`${e.violatedDirective} ${e.blockedURI}`)));
    await begin(page, { every: 0, scrobble: true });
    await expect(page.locator('#site-nav a[aria-current="page"]')).toHaveAttribute('data-k', 'app');
    for (const k of ['home', 'listens', 'leaderboard', 'map', 'extension', 'account']) {
      const path = k === 'home' ? '/melodica/' : `/melodica/${k}/`;
      await expect(page.locator(`.top a[data-k="${k}"]`)).toHaveAttribute('href', `${origin}${path}`);
    }
    await expect(page.locator(`${LISTEN_ROWS}`).first()).toBeVisible();
    // A listen arriving over the live channel (the fake's WebSocket).
    await expect(page.locator('#live-state')).toHaveText('live', { timeout: 10_000 });
    expect(scrobbles.requests.filter((r) => r.startsWith('WS ')), 'the WebSocket carried the bearer').not.toContain('WS /scrobble/api/live (refused)');
    scrobbles.emit(key(), { type: 'listen', listen: { id: 'live-1', listened_at: Math.floor(Date.now() / 1000), session: Math.floor(Date.now() / 1000), artist: 'Live Artist', title: 'Live Song' } });
    await expect(page.locator(`${LISTEN_ROWS} .hist-title`, { hasText: 'Live Song' })).toBeVisible({ timeout: 10_000 });
    await page.click('#tab-leaderboard');
    await expect(page.locator('#pane-leaderboard')).toBeVisible();
    await expect(page.locator('#pane-listens')).toBeHidden();
    await expect(page.locator('#sui-leaderboard')).toContainText('Slow Light', { timeout: 10_000 });
    await page.locator('#listens-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(ARTIFACTS, 'panels-leaderboard-1280.png') });
    await expect(page.locator('#tab-map')).toBeVisible();
    // One map: the player's Map tab opens the /melodica/map/ route, the same view the nav opens.
    await page.click('#tab-map');
    await expect(page).toHaveURL(`${origin}/melodica/map/`);
    await expect(page.locator('#route-body svg').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#route-body')).not.toContainText('Invalid');
    expect(scrobbles.requests.some((r) => r.startsWith('GET /scrobble/api/game')), 'the map read the game').toBe(true);
    const shape = (p) => p.evaluate(() => { const h = document.querySelector('#route-body .sui-host'); const walk = (n, d) => d > 4 ? '' : `${n.tagName}.${[...n.classList].sort().join('.')}[${[...n.children].map((c) => walk(c, d + 1)).join(',')}]`; return walk(h, 0); });
    const fromTab = await shape(page);
    await page.screenshot({ path: resolve(ARTIFACTS, 'map-from-player-tab-1280.png') });
    await page.click('#site-nav a[data-k="app"]');
    await page.click('#site-nav a[data-k="map"]');
    await expect(page.locator('#route-body svg').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(ARTIFACTS, 'map-page-1280.png') });
    expect(await shape(page), 'the player tab map and the map page are one view').toBe(fromTab);
    expect(await page.locator('#sui-map svg').count(), 'no second map in the player').toBe(0);
    await page.click('#site-nav a[data-k="app"]');
    await page.locator('#listens-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(ARTIFACTS, 'panels-map-1280.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no sideways page scroll at 390').toBeLessThanOrEqual(390);
    await page.click('#site-nav a[data-k="map"]');
    await expect(page.locator('#route-body svg').first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: resolve(ARTIFACTS, 'panels-map-390.png') });
    await page.click('#site-nav a[data-k="app"]');
    await page.locator('#listens-panel').scrollIntoViewIfNeeded();
    await page.click('#tab-leaderboard');
    await page.screenshot({ path: resolve(ARTIFACTS, 'panels-leaderboard-390.png') });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(ARTIFACTS, 'panels-nav-390.png') });
    expect(errors, 'page errors').toEqual([]);
    expect(await page.evaluate(() => window.__csp || []), 'CSP violations').toEqual([]);
  });

  test('no map for a listener outside the crew', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    await begin(page, { every: 0, scrobble: true });
    await expect(page.locator('#listens-panel')).toBeVisible();
    await expect(page.locator(LISTEN_ROWS).first()).toBeVisible();
    await expect(page.locator('#tab-map')).toBeHidden();
    expect(scrobbles.requests.filter((r) => r.startsWith('GET /scrobble/api/game')), 'no game request').toEqual([]);
  });

  test('no crew link for a listener the server does not mark as crew', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    await begin(page, { every: 0, scrobble: true });
    await page.click('#account summary');
    await expect(page.locator('#scrobble-settings')).toBeVisible();
    await expect(page.locator('#scrobble-crew-wrap')).toBeHidden();
  });
  test('on by default: the notice, playing now at each song start, never an insert, 15 listens then more on scroll', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    const evidence = await begin(page, { every: 1, scrobble: true });
    await expect(page.locator('#listens-panel')).toBeVisible();
    expect(scrobbles.requests[0], 'the first request').toBe('GET /scrobble/api/me');
    await expect(page.locator(`${LISTEN_ROWS} .hist-title`).first()).toHaveText('Seed Song 1');
    await scrollListensBox(page, 1280);
    expect(scrobbles.requests.filter((r) => r.startsWith('GET /scrobble/api/me/listens?') && /cursor=/.test(r)).length, 'pages after the first, by cursor').toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: resolve(ARTIFACTS, 'scrobble-listens.png'), fullPage: true });

    // A song, an insert, and the song after it play through.
    await page.click('#btn-next');
    await expect(page.locator('#app')).toHaveAttribute('data-insert', 'true', { timeout: 20_000 });
    const insTitle = (await page.locator('#np-title').textContent()).trim();
    await page.waitForFunction(() => window.__audioEvents.includes('ended insert'), null, { timeout: 30_000 });
    await expect(page.locator('#app')).not.toHaveAttribute('data-insert', 'true', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const logged = await page.locator('#history li .hist-title').allTextContents();
    const posts = scrobbles.posts.map((p) => ({ key: p.key, type: p.body.listen_type, title: p.body.payload[0].track_metadata.track_name, client: p.body.payload[0].track_metadata.additional_info.submission_client }));
    report.scrobble = { posts, logged, insTitle, requests: scrobbles.requests.slice(0, 20) };
    console.log(`scrobble posts: ${JSON.stringify(posts)}`);
    expect(posts.length, 'playing now sent').toBeGreaterThanOrEqual(2);
    expect(posts.every((p) => p.key === key()), 'every submit named the listener by the relay token').toBe(true);
    expect(posts.every((p) => p.type === 'playing_now'), 'no listen for 10 s tracks').toBe(true);
    expect(posts.every((p) => p.client === 'melodica-web')).toBe(true);
    expect(posts.map((p) => p.title), 'never the insert').not.toContain(insTitle);
    for (const p of posts) expect(logged, `${p.title} is a song from the play log`).toContain(p.title);
    await expect(page.locator('#site-nav a[data-k="leaderboard"]')).toHaveAttribute('href', `${origin}/melodica/leaderboard/`);
    expect(evidence.errors).toEqual([]);
  });

  test('signed-in non-crew account can open the standalone leaderboard', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    scrobbles.crewAccounts = false;
    const evidence = await begin(page, { every: 0, scrobble: true });
    scrobbles.crewViewers.delete(key());
    await page.click('#site-nav a[data-k="leaderboard"]');
    await expect(page).toHaveURL(`${origin}/melodica/leaderboard/`);
    await expect(page.locator('#route-body')).toContainText('Slow Light', { timeout: 15_000 });
    await expect(page.locator('#route-view .route-notice')).toHaveCount(0);
    expect(evidence.errors, 'page errors').toEqual([]);
    expect(scrobbles.requests.filter((r) => r.startsWith('GET /scrobble/api/me'))).not.toHaveLength(0);
    scrobbles.crewAccounts = false;
  });
});


for (const width of [1280, 390]) {
  test(`one engine in three tabs at ${width}: remote pause/play stays in the original tab, close hands off without relay or me`, async ({ page, context }) => {
    test.skip(!haveTuner, 'no tuner');
    await page.setViewportSize({ width, height: 844 });
    await longAudio(page);
    await begin(page, { every: 0 });
    await expect.poll(() => page.locator('#audio').evaluate((a) => !a.paused)).toBe(true);
    const title = await page.locator('#np-title').textContent();
    const baseline = relay.seen.length;
    const meHits = [];
    context.on('request', (r) => { if (/\/(me|policy)(?:\?|$)/.test(new URL(r.url()).pathname)) meHits.push(r.url()); });
    const others = [await context.newPage(), await context.newPage()];
    for (const p of others) {
      await p.setViewportSize({ width, height: 844 });
      await longAudio(p);
      await p.goto(appUrl);
      await expect(p.locator('#app')).toHaveAttribute('data-engine', 'remote');
      await expect(p.locator('#np-title')).toHaveText(title);
      expect(await p.locator('#audio').evaluate((a) => a.getAttribute('src'))).toBeNull();
    }
    expect(relay.seen.length, 'remote bootstrap makes no relay requests').toBe(baseline);
    await others[0].click('#btn-play');
    await expect.poll(() => page.locator('#audio').evaluate((a) => a.paused)).toBe(true);
    // Opening another remote while the original engine is paused must not take it over.
    await others[1].reload();
    await expect(others[1].locator('#np-title')).toHaveText(title);
    await others[1].click('#btn-play');
    await expect.poll(() => page.locator('#audio').evaluate((a) => !a.paused)).toBe(true);
    for (const p of others) expect(await p.locator('#audio').evaluate((a) => a.getAttribute('src'))).toBeNull();
    expect(relay.seen.length).toBe(baseline);
    // Give the encrypted checkpoint time to commit before the document is destroyed.
    await expect.poll(() => page.evaluate(async () => {
      const { Vault } = await import('./vault.js');
      const v = await new Vault().read('tab-engine-v1');
      return !!(v?.song && v.playing);
    })).toBe(true);
    const meBefore = meHits.length;
    await page.close();
    await expect.poll(async () => Promise.all(others.map((p) => p.locator('#app').getAttribute('data-engine')))).toContain('owner');
    const owner = (await others[0].locator('#app').getAttribute('data-engine')) === 'owner' ? others[0] : others[1];
    await expect(owner.locator('#np-title')).toHaveText(title);
    await expect.poll(() => owner.locator('#audio').evaluate((a) => !a.paused)).toBe(true);
    const remote = others.find((p) => p !== owner);
    expect(await remote.locator('#audio').evaluate((a) => a.getAttribute('src'))).toBeNull();
    expect(relay.seen.length, 'close handoff reuses session and queue').toBe(baseline);
    expect(meHits.length, 'close handoff does not refetch me').toBe(meBefore);
    expect(meBefore, 'remote bootstrap does not fetch me or policy').toBe(0);
    const storage = await owner.evaluate(() => localStorage.getItem('melodica.tabs.v1'));
    expect(storage).not.toContain(tuner.password);
    expect(storage).not.toContain('audioUrl');
    for (let i = 0; i < 4; i++) {
      const before = await owner.locator('#np-title').textContent();
      await owner.click('#btn-next');
      await expect(owner.locator('#np-title')).not.toHaveText(before);
    }
    expect(relay.seen.filter((r) => r.method === 'station.getPlaylist').length, 'refill works after handoff').toBeGreaterThan(1);
  });
}

test('the engine reloads into the same song with Resume and makes no relay request', async ({ page, context }) => {
  test.skip(!haveTuner, 'no tuner');
  await longAudio(page);
  await begin(page, { every: 0 });
  const remote = await context.newPage();
  await longAudio(remote);
  await remote.goto(appUrl);
  await expect(remote.locator('#app')).toHaveAttribute('data-engine', 'remote');
  await page.locator('#audio').evaluate((a) => { a.currentTime = 42; });
  await expect.poll(() => page.evaluate(async () => {
    const { Vault } = await import('./vault.js');
    return (await new Vault().read('tab-engine-v1'))?.position || 0;
  })).toBeGreaterThanOrEqual(42);
  const title = await page.locator('#np-title').textContent();
  const baseline = relay.seen.length;
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-engine', 'owner');
  await expect(page.locator('#np-title')).toHaveText(title);
  await expect(page.locator('#bar-resume')).toBeVisible();
  await page.click('#bar-resume');
  await expect.poll(() => page.locator('#audio').evaluate((a) => a.currentTime)).toBeGreaterThanOrEqual(42);
  await expect(remote.locator('#app')).toHaveAttribute('data-engine', 'remote');
  expect(relay.seen.length).toBe(baseline);
});

test('BroadcastChannel and a storage lease keep the engine sticky when Web Locks are unavailable', async ({ page, context }) => {
  test.skip(!haveTuner, 'no tuner');
  await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  await longAudio(page);
  await begin(page, { every: 0 });
  await expect.poll(() => relay.seen.some((r) => r.method === 'track.explainTrack')).toBe(true);
  await page.click('#account summary');
  await page.uncheck('#remember-menu');
  await page.click('#account summary');
  const baseline = relay.seen.length;
  const meHits = [];
  context.on('request', (r) => { if (/\/(me|policy)$/.test(new URL(r.url()).pathname)) meHits.push(r.url()); });
  const remote = await context.newPage();
  await remote.goto(appUrl);
  await expect(remote.locator('#app')).toHaveAttribute('data-engine', 'remote');
  await expect(remote.locator('#np-title')).toHaveText(await page.locator('#np-title').textContent());
  await remote.click('#btn-play');
  await expect.poll(() => page.locator('#audio').evaluate((a) => a.paused)).toBe(true);
  await remote.click('#btn-play');
  await expect.poll(() => page.locator('#audio').evaluate((a) => !a.paused)).toBe(true);
  expect(await remote.locator('#audio').evaluate((a) => a.getAttribute('src'))).toBeNull();
  expect(relay.seen.length).toBe(baseline);
  expect(meHits, 'a remote with Remember off reuses the engine account cache').toEqual([]);
});

test('extension appearance and disappearance transfer the same live play without relay or me requests', async ({ page, context }) => {
  test.skip(!haveTuner, 'no tuner');
  await longAudio(page);
  const explicit = appUrl;
  appUrl = `${origin}${APP_PATH}`;
  try { await begin(page, { every: 0 }); } finally { appUrl = explicit; }
  const title = await page.locator('#np-title').textContent();
  const baseline = relay.seen.length;
  const meHits = [];
  context.on('request', (r) => { if (/\/(me|policy)$/.test(new URL(r.url()).pathname)) meHits.push(r.url()); });
  await page.evaluate(() => {
    let session = null, relay = null, playback = null, stations = [];
    window.__handoff = { available: true, imports: 0, exports: 0, copyReads: 0 };
    // A valid PCM fixture larger than one chunk: cached by the fake extension,
    // unavailable to the web page except through explicit bridge-copy replies.
    const bytes = new Uint8Array(44 + 16000 * 12 * 2);
    const wav = new DataView(bytes.buffer);
    const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
    ascii(0, 'RIFF'); wav.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVEfmt ');
    wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
    wav.setUint32(24, 16000, true); wav.setUint32(28, 32000, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
    ascii(36, 'data'); wav.setUint32(40, bytes.length - 44, true);
    const post = (m) => window.postMessage({ melodica: 1, ...m }, location.origin);
    const view = () => ({ changedAt: Date.now(), loggedIn: !!session, status: playback?.status || 'idle',
      track: playback?.song || null, station: playback?.station ? { token: playback.station.id, name: playback.station.name } : null,
      position: playback?.position || 0, duration: playback?.duration || 0, volume: 80, quality: 'high',
      stations: stations.map((s) => ({ token: s.id, name: s.name, isQuickMix: s.isQuickMix })), queueLength: playback?.queue?.length || 0 });
    const ready = () => post({ type: 'ready', name: 'melodica-extension', version: '0.8.8', player: true, session: 1 });
    addEventListener('message', (ev) => {
      const d = ev.data;
      if (ev.source !== window || ev.origin !== location.origin || !d || d.melodica !== 1 || !window.__handoff.available) return;
      if (d.type === 'hello') ready();
      if (d.type === 'subscribe') post({ type: 'state', state: view() });
      if (d.type === 'session-get') post({ type: 'session', id: d.id, session, access: relay?.token || null, credential: null, account: { signedIn: false }, revoked: [] });
      if (d.type === 'session-offer') {
        session = d.session; relay = d.relay; stations = d.stations || [];
        post({ type: 'result', id: d.id, ok: true, outcome: 'signed-in' });
      }
      if (d.type === 'command' && d.action === 'playback-import') {
        playback = d.playback; window.__handoff.imports++;
        post({ type: 'result', id: d.id, ok: true, state: view() });
      }
      if (d.type === 'command' && d.action === 'playback-export') {
        window.__handoff.exports++;
        post({ type: 'result', id: d.id, ok: true, playback: playback && { ...playback, at: Date.now(), song: { ...playback.song, fetchedAt: 1 } } });
      }
      if (d.type === 'command' && d.action === 'playback-copy' && playback) {
        window.__handoff.copyReads++;
        const part = bytes.subarray(d.offset, d.offset + Math.min(262144, d.limit));
        let binary = '';
        for (let i = 0; i < part.length; i += 32768) binary += String.fromCharCode(...part.subarray(i, i + 32768));
        post({ type: 'result', id: d.id, ok: true, copy: { sid: session.sid, trackToken: playback.song.trackToken,
          offset: d.offset, total: bytes.length, mime: 'audio/wav', bytes: btoa(binary), done: d.offset + part.length === bytes.length } });
      }
    });
    ready();
  });
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote');
  await expect.poll(() => page.evaluate(() => window.__handoff.imports)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__handoff.exports)).toBeGreaterThan(0);
  await expect(page.locator('#np-title')).toHaveText(title);
  expect(await page.locator('#audio').evaluate((a) => a.getAttribute('src'))).toBeNull();
  expect(relay.seen.length).toBe(baseline);
  await expect.poll(() => page.evaluate(async () => {
    const c = await caches.open('melodica-audio-v1');
    for (const request of await c.keys()) { const r = await c.match(request); if (r.headers.get('content-type') === 'audio/wav') return (await r.blob()).size; }
    return 0;
  })).toBe(384044);
  expect(await page.evaluate(() => window.__handoff.copyReads)).toBeGreaterThan(1);
  // The explicit export is saved encrypted; it is absent from public localStorage.
  await expect.poll(() => page.evaluate(async () => {
    const { Vault } = await import('./vault.js');
    return (await new Vault().read('tab-engine-v1'))?.tab;
  })).toBe('extension');
  await page.evaluate(() => { window.__handoff.available = false; });
  await page.waitForTimeout(7500); // two missed replies do not prove the audio engine stopped
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote');
  expect(await page.locator('#audio').evaluate((a) => a.getAttribute('src'))).toBeNull();
  await page.evaluate(() => window.postMessage({ melodica: 1, type: 'gone', reason: 'runtime-invalidated' }, location.origin));
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'local', { timeout: 15000 });
  await expect(page.locator('#app')).toHaveAttribute('data-engine', 'owner');
  await expect(page.locator('#np-title')).toHaveText(title);
  await expect.poll(() => page.locator('#audio').evaluate((a) => !a.paused)).toBe(true);
  expect(relay.seen.length).toBe(baseline);
  expect(meHits, 'transfer does not fetch me or policy').toEqual([]);
  expect(await page.locator('#audio').evaluate((a) => a.currentSrc.startsWith('blob:')), 'the expired song resumes from the transferred copy').toBe(true);
});

test('back to a former engine while another tab plays stays remote', async ({ page, context }) => {
  test.skip(!haveTuner, 'no tuner');
  await longAudio(page);
  await begin(page, { every: 0 });
  const remote = await context.newPage();
  await longAudio(remote);
  await remote.goto(appUrl);
  await expect(remote.locator('#app')).toHaveAttribute('data-engine', 'remote');
  await expect.poll(() => page.evaluate(async () => {
    const { Vault } = await import('./vault.js');
    return !!(await new Vault().read('tab-engine-v1'))?.song;
  })).toBe(true);
  const baseline = relay.seen.length;
  await page.goto('about:blank');
  await expect(remote.locator('#app')).toHaveAttribute('data-engine', 'owner');
  await expect.poll(() => remote.locator('#audio').evaluate((a) => !a.paused)).toBe(true);
  await page.goBack();
  await expect(page.locator('#app')).toHaveAttribute('data-engine', 'remote');
  expect(await page.locator('#audio').evaluate((a) => a.getAttribute('src'))).toBeNull();
  expect(relay.seen.length).toBe(baseline);
});

test('a blocked close handoff offers one-tap Resume without fetching another playlist', async ({ page, context }) => {
  test.skip(!haveTuner, 'no tuner');
  await longAudio(page);
  await begin(page, { every: 0 });
  const remote = await context.newPage();
  await longAudio(remote);
  await remote.goto(appUrl);
  await expect(remote.locator('#app')).toHaveAttribute('data-engine', 'remote');
  await remote.evaluate(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      HTMLMediaElement.prototype.play = play;
      return Promise.reject(new DOMException('Autoplay requires a gesture', 'NotAllowedError'));
    };
  });
  await expect.poll(() => page.evaluate(async () => {
    const { Vault } = await import('./vault.js');
    return !!(await new Vault().read('tab-engine-v1'))?.song;
  })).toBe(true);
  const baseline = relay.seen.length;
  await page.close();
  await expect(remote.locator('#app')).toHaveAttribute('data-engine', 'owner');
  await expect(remote.locator('#bar-resume')).toBeVisible();
  await remote.click('#bar-resume');
  await expect.poll(() => remote.locator('#audio').evaluate((a) => !a.paused)).toBe(true);
  expect(relay.seen.length).toBe(baseline);
});
