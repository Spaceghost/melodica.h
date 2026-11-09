// Playback and relay access end to end against melodica-tuner (0.2.0+).
// serves ad items per its `ads` setting): the built client in a headless browser,
// logging in through a fake relay (tests/tools/fake-relay.mjs, the allow-list of
// docs/ACCOUNT.md) in front of the tuner, with the contract fake account server
// (tests/tools/fake-account.mjs) on the page's origin.
//
//   1. Verify the signed-in account compatibility response.
// The fixture checks the selected playback policy.
//      ad.registerAd in the tuner's log).
//   2. Verify compatibility with only the relay access token.
// The fixture checks the selected playback policy.
//   3. Verify default compatibility and ordinary inserted-item playback.
//      the ad's metadata is fetched, its audio plays in the now-playing card with
//      skip and rating disabled, and ad.registerAd is sent with the tracking tokens
//      the tuner handed out for this station.
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
// (a checkout; the test starts it). Its `ads` setting is changed at runtime
// through POST /__tuner/config. Without a tuner the tests are skipped.
//
// Artifacts: tests/artifacts/smoke-playback.json (what the tuner saw),
// smoke-web-ad.png (an ad in the now-playing card), smoke-web-not-listed.png,
// username-pick.png, username-change.png.

import { test, expect } from '@playwright/test';
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
  `style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; media-src https: http:; ` +
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
  account = makeBackend(origin);
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
// Sign in with the requested compatibility state.
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

// A fresh tuner run with `ads` set; the page opened (signed in to an account whose
// policy is `accountInserts`, when given) and logged in through the relay, whose
// allow-list has the tuner user with `listedInserts`.
async function begin(page, { ads, accountInserts, listedInserts = true, scrobble = false }) {
  relay.seen.length = 0;
  account.allow(tuner.user, { inserts: listedInserts });
  account.setPerson(tuner.user, { username: 'tuner_listener', chosen: true, notice: '' }); // no "Pick a username" over the stations
  await postJson(`${tuner.http}/__tuner/reset`, {});
  const cfg = await postJson(`${tuner.http}/__tuner/config`, { ads });
  expect(cfg.ok, `POST /__tuner/config {ads: ${ads}}`).toBe(true);
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
      window.__adSrc = new Set();
      for (const n of ['playing', 'ended', 'error']) {
        a.addEventListener(n, () => {
          if (n === 'playing' && document.getElementById('app').dataset.ad === 'true') window.__adSrc.add(a.currentSrc);
          window.__audioEvents.push(`${n} ${window.__adSrc.has(a.currentSrc) ? 'ad' : 'song'}`);
        });
      }
    });
  });
  await page.goto(appUrl);
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
  await page.fill('#login-email', tuner.user);
  await page.fill('#login-password', tuner.password);
  await page.click('#login-button');
  expect((await (await policy).json()).playback.plus, 'the policy the page fetched').toBe(!(accountInserts ?? listedInserts));
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
    adAudio: log.filter((e) => e.protocol === 'audio' && e.ad === true),
    songAudio: log.filter((e) => e.protocol === 'audio' && !e.ad),
  };
}

test.describe.serial('playback against melodica-tuner', () => {
  test('the signed-in compatibility response is applied', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    const evidence = await begin(page, { ads: 1, accountInserts: false });
    // Play through several songs; with ads: 1 every other playlist item is an ad.
    const titles = [];
    for (let i = 0; i < 4; i++) {
      titles.push((await page.locator('#np-title').textContent()).trim());
      await expect(page.locator('#app')).not.toHaveAttribute('data-ad', 'true');
      await expect(page.locator('#btn-next')).toBeEnabled();
      await page.click('#btn-next');
      await expect(page.locator('#np-title')).not.toHaveText(titles.at(-1), { timeout: 20_000 });
    }
    const seen = await tunerSeen();
    const served = seen.log.filter((e) => e.method === 'station.getPlaylist').length;
    report.policyOff = { titles, playlists: served, adItemsServed: seen.inserts.length, metadata: seen.metadata.length, register: seen.register.length, adAudio: seen.adAudio.length };
    console.log(`account compatibility: ${JSON.stringify(report.policyOff)}`);
    await info.attach('policy-off', { body: JSON.stringify(report.policyOff, null, 2), contentType: 'application/json' });
    expect(seen.inserts.length, 'the tuner did serve ad items').toBeGreaterThan(0);
    expect(seen.metadata, 'metadata count unchanged').toEqual([]);
    expect(seen.adAudio, 'slot audio count unchanged').toEqual([]);
    expect(seen.register, 'confirmation count unchanged').toEqual([]);
    expectRelayTokens();
    expect(evidence.errors).toEqual([]);
  });

  test('the relay-token compatibility response is applied', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    const evidence = await begin(page, { ads: 1, listedInserts: false });
    const titles = [];
    for (let i = 0; i < 3; i++) {
      titles.push((await page.locator('#np-title').textContent()).trim());
      await expect(page.locator('#app')).not.toHaveAttribute('data-ad', 'true');
      await page.click('#btn-next');
      await expect(page.locator('#np-title')).not.toHaveText(titles.at(-1), { timeout: 20_000 });
    }
    const seen = await tunerSeen();
    report.relayPolicyOff = { titles, adItemsServed: seen.inserts.length, metadata: seen.metadata.length, register: seen.register.length, adAudio: seen.adAudio.length, relay: relay.seen.length };
    console.log(`relay-token compatibility: ${JSON.stringify(report.relayPolicyOff)}`);
    await info.attach('relay-policy-off', { body: JSON.stringify(report.relayPolicyOff, null, 2), contentType: 'application/json' });
    expect(seen.inserts.length, 'the tuner did serve ad items').toBeGreaterThan(0);
    expect(seen.metadata, 'metadata count unchanged').toEqual([]);
    expect(seen.adAudio, 'slot audio count unchanged').toEqual([]);
    expect(seen.register, 'confirmation count unchanged').toEqual([]);
    expectRelayTokens();
    expect(evidence.errors).toEqual([]);
  });

  test('default playback fetches and registers a playlist slot', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    const evidence = await begin(page, { ads: 1 });
    // With ads: 1 the item after the first song is an ad.
    await expect(page.locator('#app')).not.toHaveAttribute('data-ad', 'true');
    await page.click('#btn-next');
    await expect(page.locator('#app')).toHaveAttribute('data-ad', 'true', { timeout: 20_000 });
    const ad = {
      title: (await page.locator('#np-title').textContent()).trim(),
      company: (await page.locator('#np-artist').textContent()).trim(),
      chip: (await page.locator('#np-quality').textContent()).trim(),
      cover: await page.locator('#cover').getAttribute('src'),
    };
    console.log(`ad in the card: ${JSON.stringify(ad)}`);
    expect(ad.title).not.toBe('');
    expect(ad.company).not.toBe('');
    expect(ad.chip).toBe('ad');
    expect(ad.cover).toMatch(/^https?:/);
    for (const id of ['#btn-next', '#btn-love', '#btn-ban', '#btn-tired', '#btn-explain']) await expect(page.locator(id), `${id} during the ad`).toBeDisabled();
    // The n key does nothing during an ad.
    await page.locator('body').press('n');
    await expect(page.locator('#app')).toHaveAttribute('data-ad', 'true');
    await page.waitForFunction(() => window.__audioEvents.includes('playing ad'), null, { timeout: 20_000 });
    await page.screenshot({ path: resolve(ARTIFACTS, 'smoke-web-ad.png') });
    await expect.poll(async () => (await tunerSeen()).register.length, { timeout: 20_000, message: 'ad.registerAd reached the tuner' }).toBeGreaterThan(0);
    // The 5 s clip ends and the next song follows by itself.
    await page.waitForFunction(() => window.__audioEvents.includes('ended ad'), null, { timeout: 30_000 });
    await expect(page.locator('#app')).not.toHaveAttribute('data-ad', 'true', { timeout: 20_000 });
    await expect(page.locator('#btn-next')).toBeEnabled();
    const logged = await page.locator('#history li .hist-title').allTextContents();
    expect(logged, 'the ad is not in the play log').not.toContain(ad.title);

    const seen = await tunerSeen();
    // The tuner logs the decrypted request body as a JSON string.
    const parsed = (e) => (e && typeof e.body === 'string' ? { ...e, body: JSON.parse(e.body) } : e);
    const meta = parsed(seen.metadata[0]);
    const reg = parsed(seen.register[0]);
    const item = seen.inserts.find((a) => a.registered >= 1) || seen.inserts[0] || {};
    report.policyOn = {
      ad, metadata: seen.metadata.length, register: seen.register.length, adAudio: seen.adAudio.length,
      metadataBody: meta && meta.body, registerBody: reg && reg.body, registerResponse: reg && reg.response,
      state: item, audioEvents: await page.evaluate(() => window.__audioEvents),
    };
    console.log(`policy default: ${JSON.stringify(report.policyOn)}`);
    await info.attach('policy-on', { body: JSON.stringify(report.policyOn, null, 2), contentType: 'application/json' });
    expect(meta && meta.code, 'ad.getAdMetadata succeeded').toBeNull();
    expect(meta.body.returnAdTrackingTokens).toBe(true);
    expect(meta.body.supportAudioAds).toBe(true);
    expect(seen.adAudio.length, 'ad audio fetched').toBeGreaterThan(0);
    expect(reg && reg.code, 'ad.registerAd succeeded').toBeNull();
    expect(reg.response && reg.response.stat).toBe('ok');
    expect(item.metadataFetched).toBeGreaterThanOrEqual(1);
    expect(item.audioFetched).toBeGreaterThanOrEqual(1);
    expect(item.registered).toBeGreaterThanOrEqual(1);
    expect(reg.body.stationId, 'registered for the playing station').toBe(item.registeredStationId);
    expect(reg.body.adTrackingTokens).toEqual(item.adTrackingTokens);
    expectRelayTokens();
    expect(evidence.errors).toEqual([]);
  });

  test('an email not on the allow-list: the login card says so and Pandora is not contacted', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    relay.seen.length = 0;
    // No reset: CI's tuner.report reads the ad steps of the case before from this log.
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
// ad; the last 15 listens, then more on scroll; the settings; crew only when the server
// says so; logout clears the listens. The ad test runs last: the workflow's tuner
// report reads the ad steps from the tuner's log, which each begin() resets.
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

test.describe.serial('scrobbling to spacegho.st', () => {
  test('at 390 wide: the listens scroll in their own box and the footer stays reachable', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    await page.setViewportSize({ width: 390, height: 844 });
    await begin(page, { ads: 0, scrobble: true });
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
    await begin(page, { ads: 0, scrobble: true });
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
    await begin(page, { ads: 0, scrobble: true });
    await expect(page.locator('#site-nav a[aria-current="page"]')).toHaveAttribute('data-k', 'app');
    for (const k of ['home', 'listens', 'leaderboard', 'map', 'extension', 'account']) {
      const path = k === 'home' ? '/melodica/' : `/melodica/${k}/`;
      await expect(page.locator(`#site-nav a[data-k="${k}"]`)).toHaveAttribute('href', `${origin}${path}`);
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
    await page.locator('#tab-map').press('ArrowRight'); // keyboard: wraps to the first tab
    await expect(page.locator('#tab-listens')).toHaveAttribute('aria-selected', 'true');
    await page.click('#tab-map');
    await expect(page.locator('#sui-map svg').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#sui-map')).not.toContainText('Invalid');
    expect(scrobbles.requests.some((r) => r.startsWith('GET /scrobble/api/game')), 'the map read the game').toBe(true);
    await page.locator('#listens-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(ARTIFACTS, 'panels-map-1280.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no sideways page scroll at 390').toBeLessThanOrEqual(390);
    await page.locator('#listens-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(ARTIFACTS, 'panels-map-390.png') });
    await page.click('#tab-leaderboard');
    await page.screenshot({ path: resolve(ARTIFACTS, 'panels-leaderboard-390.png') });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(ARTIFACTS, 'panels-nav-390.png') });
    expect(errors, 'page errors').toEqual([]);
    expect(await page.evaluate(() => window.__csp || []), 'CSP violations').toEqual([]);
  });

  test('no map for a listener outside the crew', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    await begin(page, { ads: 0, scrobble: true });
    await expect(page.locator('#listens-panel')).toBeVisible();
    await expect(page.locator(LISTEN_ROWS).first()).toBeVisible();
    await expect(page.locator('#tab-map')).toBeHidden();
    expect(scrobbles.requests.filter((r) => r.startsWith('GET /scrobble/api/game')), 'no game request').toEqual([]);
  });

  test('no crew link for a listener the server does not mark as crew', async ({ page }) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    await begin(page, { ads: 0, scrobble: true });
    await page.click('#account summary');
    await expect(page.locator('#scrobble-settings')).toBeVisible();
    await expect(page.locator('#scrobble-crew-wrap')).toBeHidden();
  });
  test('on by default: the notice, playing now at each song start, never an ad, 15 listens then more on scroll', async ({ page }, info) => {
    test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
    const evidence = await begin(page, { ads: 1, scrobble: true });
    await expect(page.locator('#listens-panel')).toBeVisible();
    expect(scrobbles.requests[0], 'the first request').toBe('GET /scrobble/api/me');
    await expect(page.locator(`${LISTEN_ROWS} .hist-title`).first()).toHaveText('Seed Song 1');
    await scrollListensBox(page, 1280);
    expect(scrobbles.requests.filter((r) => r.startsWith('GET /scrobble/api/me/listens?') && /cursor=/.test(r)).length, 'pages after the first, by cursor').toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: resolve(ARTIFACTS, 'scrobble-listens.png'), fullPage: true });

    // A song, an ad, and the song after it play through.
    await page.click('#btn-next');
    await expect(page.locator('#app')).toHaveAttribute('data-ad', 'true', { timeout: 20_000 });
    const adTitle = (await page.locator('#np-title').textContent()).trim();
    await page.waitForFunction(() => window.__audioEvents.includes('ended ad'), null, { timeout: 30_000 });
    await expect(page.locator('#app')).not.toHaveAttribute('data-ad', 'true', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const logged = await page.locator('#history li .hist-title').allTextContents();
    const posts = scrobbles.posts.map((p) => ({ key: p.key, type: p.body.listen_type, title: p.body.payload[0].track_metadata.track_name, client: p.body.payload[0].track_metadata.additional_info.submission_client }));
    report.scrobble = { posts, logged, adTitle, requests: scrobbles.requests.slice(0, 20) };
    console.log(`scrobble posts: ${JSON.stringify(posts)}`);
    expect(posts.length, 'playing now sent').toBeGreaterThanOrEqual(2);
    expect(posts.every((p) => p.key === key()), 'every submit named the listener by the relay token').toBe(true);
    expect(posts.every((p) => p.type === 'playing_now'), 'no listen for 10 s tracks').toBe(true);
    expect(posts.every((p) => p.client === 'melodica-web')).toBe(true);
    expect(posts.map((p) => p.title), 'never the ad').not.toContain(adTitle);
    for (const p of posts) expect(logged, `${p.title} is a song from the play log`).toContain(p.title);
    await expect(page.locator('#site-nav a[data-k="leaderboard"]')).toHaveAttribute('href', `${origin}/melodica/leaderboard/`);
    expect(evidence.errors).toEqual([]);
  });
});
