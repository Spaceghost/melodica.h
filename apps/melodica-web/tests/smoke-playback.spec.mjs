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
// The tuner comes from TUNER_HTTPS_URL / TUNER_HTTP_URL / TUNER_USER /
// TUNER_PASSWORD (the Spaceghost/melodica-tuner action) or MELODICA_TUNER_DIR
// (a checkout; the test starts it). Its `ads` setting is changed at runtime
// through POST /__tuner/config. Without a tuner the tests are skipped.
//
// Artifacts: tests/artifacts/smoke-playback.json (what the tuner saw),
// smoke-web-ad.png (an ad in the now-playing card), smoke-web-not-listed.png.

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
  password: process.env.TUNER_PASSWORD || 'test',
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
  // The page talks to the fake relay (the allow-list in front of the tuner), as the
  // hosted page talks to spacegho.st/melodica/api/.
  relay = makeRelay({ upstream: `${tuner.https}/services/json/`, access: account });
  appUrl = `${origin}${APP_PATH}?api=${encodeURIComponent(`${origin}${RELAY_PATH}`)}`;
});

test.afterAll(async () => {
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
async function begin(page, { ads, accountInserts, listedInserts = true }) {
  relay.seen.length = 0;
  account.allow(tuner.user, { inserts: listedInserts });
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
  await expect(page.locator('#access-note')).toBeVisible();
  await page.fill('#login-email', tuner.user);
  await page.fill('#login-password', tuner.password);
  await page.click('#login-button');
  expect((await (await policy).json()).playback.plus, 'the policy the page fetched').toBe(!(accountInserts ?? listedInserts));
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 30_000 });
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
    await expect(page.locator('#access-note')).toHaveText('melodica access is by allow-list; signing in sends your email to the admin as an access request.');
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
