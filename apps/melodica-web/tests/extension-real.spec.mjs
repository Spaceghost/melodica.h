// The page with the REAL melodica extension (a released Chrome build, unpacked),
// against melodica-tuner. When the extension answers, the page is only a view and a
// remote of the extension's background player; it never plays on its own.
//
//   - Chromium with the unpacked extension (MELODICA_EXT_DIR) resolves spacegho.st to
//     a local HTTPS server (--host-resolver-rules, a throwaway certificate) serving
//     dist/ under /melodica/app/ with the site's CSP, and the account server
//     (tests/tools/fake-account.mjs: the allow-list the extension asks before its
//     Pandora login) under /oauth/. The extension's endpoint is the tuner.
//   - Before the extension has a Pandora session the page says to sign in in the
//     extension and offers to open its login; it shows no Pandora login of its own.
//   - The extension logs in (its popup) and plays a station. The page shows the
//     extension's track; play/pause, next, station and volume from the page drive the
//     extension (within 5 s, measured on the extension's state, which its audio
//     engine confirms), and the same changes made in the extension show on the page
//     within 1 s; every timing is in the report. The page has no <audio> source and fetches no audio, and makes no
//     relay request.
//
// Env: MELODICA_EXT_DIR (unpacked Chrome build; the test is skipped without it),
// TUNER_HTTPS_URL / TUNER_HTTP_URL / TUNER_USER / TUNER_PASSWORD or MELODICA_TUNER_DIR.
// Artifacts: tests/artifacts/extension-real.json, extension-real-*.png.

import { test, expect, chromium } from '@playwright/test';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { makeBackend } from './tools/fake-account.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const ARTIFACTS = resolve(here, 'artifacts');
const EXT = process.env.MELODICA_EXT_DIR ? resolve(process.env.MELODICA_EXT_DIR) : '';
const TUNER_DIR = process.env.MELODICA_TUNER_DIR || resolve(here, '..', '..', 'melodica-tuner');
const ORIGIN = 'https://spacegho.st';
const APP = `${ORIGIN}/melodica/app/`;
const SYNC_MS = 1000;
// Page -> extension is measured on the extension's own state, which its audio engine
// (offscreen document) confirms. That leg is usually 70-550 ms but the first command
// has been seen to take up to 4 s inside the extension, so it is allowed 5 s here;
// every timing is in tests/artifacts/extension-real.json.
const EXT_MS = 5000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm' };
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
  `img-src 'self' data: https: http:; media-src https: http:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'`;

const tuner = {
  https: process.env.TUNER_HTTPS_URL || '', http: process.env.TUNER_HTTP_URL || '',
  user: process.env.TUNER_USER || 'test@example.com', password: process.env.TUNER_PASSWORD || 'test', proc: null, dir: null,
};
const haveTuner = !!tuner.https || existsSync(join(TUNER_DIR, 'tuner', '__main__.py'));
const report = { extension: '', timings: {}, acts: {}, steps: [] };
const getJson = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} -> ${r.status}`); return r.json(); };

let server = null;
let tmp = '';
let context = null;
let backend = null;
let pageRef = null;
const appRequests = [];

async function serve(req, res) {
  const url = new URL(req.url, ORIGIN);
  try {
    if (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (k !== 'host') headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const r = await backend.handle(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      const out = {};
      r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (!url.pathname.startsWith('/melodica/app/')) { res.writeHead(404); res.end('not found'); return; }
    let rel = url.pathname.slice('/melodica/app/'.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some((p) => !p || p === '.' || p === '..')) { res.writeHead(404); res.end(); return; }
    const body = await readFile(resolve(DIST, rel));
    const type = MIME[extname(rel)] || 'application/octet-stream';
    const headers = { 'content-type': type };
    if (type.startsWith('text/html')) headers['content-security-policy'] = csp(randomBytes(16).toString('base64'));
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500); res.end(String(err && err.stack || err));
  }
}

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

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (!EXT || !haveTuner) return;
  if (!tuner.https) await startTuner();
  await fetch(`${tuner.http}/__tuner/reset`, { method: 'POST' });
  tmp = await mkdtemp(join(tmpdir(), 'melodica-extreal-'));
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=spacegho.st',
    '-addext', 'subjectAltName=DNS:spacegho.st', '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem')], { encoding: 'utf8' });
  if (gen.status !== 0) throw new Error(`openssl: ${gen.stderr}`);
  server = https.createServer({ key: await readFile(join(tmp, 'key.pem')), cert: await readFile(join(tmp, 'cert.pem')) }, serve);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  backend = makeBackend(ORIGIN, {});
  backend.allow(tuner.user, { inserts: true });
  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--ignore-certificate-errors',
      `--host-resolver-rules=MAP spacegho.st 127.0.0.1:${server.address().port}, MAP github.com ~NOTFOUND`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

test.afterAll(async () => {
  if (context) await context.close().catch(() => {});
  if (server) await new Promise((ok) => server.close(ok));
  if (tuner.proc) tuner.proc.kill('SIGTERM');
  for (const d of [tmp, tuner.dir]) if (d) await rm(d, { recursive: true, force: true }).catch(() => {});
  if (EXT && haveTuner) await writeFile(resolve(ARTIFACTS, 'extension-real.json'), JSON.stringify(report, null, 2) + '\n');
});

async function extensionId() {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  return new URL(sw.url()).host;
}

// Measure how long `check` takes to pass after `act` (polling every 25 ms).
async function within(label, act, check, ms = SYNC_MS) {
  const ex = process.env.DIAG ? expect.soft : expect;
  const t0 = Date.now();
  const res = await act();
  if (res && typeof res === 'object') report.acts[label] = { ok: res.ok, error: res.error, status: res.state && res.state.status };
  let last = null;
  while (Date.now() - t0 < ms * 3) {
    try { if (await check()) { report.timings[label] = Date.now() - t0; console.log(`${label}: ${report.timings[label]} ms`); break; } } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (report.timings[label] === undefined) console.log(`${label}: not seen; the extension answered ${JSON.stringify(report.acts[label] || null)}; page play button ${await pageRef.locator('#btn-play').getAttribute('data-state')}`);
  ex(report.timings[label], `${label} took effect (${last ? last.message : 'timed out'})`).toBeDefined();
  if (report.timings[label] !== undefined) ex(report.timings[label], `${label} within ${ms} ms`).toBeLessThanOrEqual(ms);
}

// One retry: the released extension's engine has been seen to drop a resume.
test.describe.configure({ retries: 1 });

test('the page is a remote of the real extension: no local playback, both directions in sync', async ({}, info) => {
  test.skip(!EXT, 'no extension build: set MELODICA_EXT_DIR to an unpacked Chrome build');
  test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
  test.setTimeout(180_000);
  const id = await extensionId();
  const manifest = JSON.parse(await readFile(resolve(EXT, 'manifest.json'), 'utf8'));
  report.extension = `${manifest.name} ${manifest.version}`;
  console.log(`extension ${id}: ${report.extension}`);

  // An extension page to talk to the background as the popup does.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${id}/options.html`);
  await ext.fill('#endpoint', `${tuner.https}/services/json/`);
  await ext.click('#save');
  await expect(ext.locator('#options-message')).toContainText('Saved');
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const bg = async () => (await send({ type: 'player-get' })).state;

  // 1. No Pandora session in the extension: the page is its view and says where to sign in.
  const page = await context.newPage();
  pageRef = page;
  page.on('request', (r) => appRequests.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(APP);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote', { timeout: 10_000 });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'player');
  await expect(page.locator('#remote-signin')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#remote-signin-text')).toHaveText('Sign in in the melodica extension');
  await expect(page.locator('#view-login')).toBeHidden();
  await page.screenshot({ path: resolve(ARTIFACTS, 'extension-real-signin.png') });
  report.steps.push('no session: sign-in prompt');
  // "Open the extension's login": the extension opens its login page (a new tab).
  const opened = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await page.click('#remote-signin-open');
  const loginTab = await opened;
  report.openLogin = loginTab ? loginTab.url() : null;
  console.log(`open login -> ${report.openLogin}`);
  if (loginTab) await loginTab.close();

  // 2. The extension logs in (its popup) and plays a station.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.locator('#login-email')).toBeVisible({ timeout: 30_000 });
  await popup.fill('#login-email', tuner.user);
  await popup.fill('#login-password', tuner.password);
  await popup.click('#login-button');
  await expect(popup.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 60_000 });
  await popup.close();
  // The page follows without a reload: stations from the extension, the prompt gone.
  await expect.soft(page.locator('#remote-signin'), 'the page follows the extension\'s login').toBeHidden({ timeout: 5000 });
  await expect.soft(page.locator('#station-list button.station').first()).toBeVisible({ timeout: 1000 });
  const stations = (await bg()).stations;
  expect(stations.length).toBeGreaterThan(1);
  await send({ type: 'player', action: 'play', station: { token: stations[0].token, name: stations[0].name } });
  await expect.poll(async () => (await bg()).status, { timeout: 30_000 }).toBe('playing');
  report.steps.push('extension logged in and playing');

  // 3. The page shows the extension's track.
  const bgTitle = async () => ((await bg()).track || {}).title || '';
  await expect(page.locator('#np-title')).toHaveText(await bgTitle(), { timeout: 5000 });
  await page.screenshot({ path: resolve(ARTIFACTS, 'extension-real-playing.png') });

  // 4. Page controls drive the extension.
  await within('page pause -> extension', () => page.click('#btn-play'), async () => (await bg()).status === 'paused', EXT_MS);
  await within('page play -> extension', () => page.click('#btn-play'), async () => (await bg()).status === 'playing', EXT_MS);
  let before = await bgTitle();
  await within('page next -> extension', () => page.click('#btn-next'), async () => { const t = await bgTitle(); return t && t !== before; }, EXT_MS);
  const target = stations[1];
  await within('page station -> extension', () => page.locator('#station-list button.station', { hasText: target.name }).first().click(),
    async () => ((await bg()).station || {}).token === target.token, EXT_MS);
  await within('page volume -> extension', () => page.locator('#volume').evaluate((el) => { el.value = '37'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }),
    async () => Number((await bg()).volume) === 37, EXT_MS);

  // 5. Extension-side changes show on the page.
  await within('extension pause -> page', () => send({ type: 'player', action: 'pause' }), async () => (await page.locator('#btn-play').getAttribute('data-state')) === 'paused');
  await within('extension play -> page', () => send({ type: 'player', action: 'resume' }), async () => (await page.locator('#btn-play').getAttribute('data-state')) === 'playing');
  before = (await page.locator('#np-title').textContent()).trim();
  await within('extension next -> page', () => send({ type: 'player', action: 'next' }), async () => {
    const t = (await page.locator('#np-title').textContent()).trim();
    return t !== before && t === await bgTitle();
  });
  await within('extension station -> page', () => send({ type: 'player', action: 'play', station: { token: stations[0].token, name: stations[0].name } }),
    async () => (await page.locator('#station-list button.station[aria-current="true"], #station-list button.station.active').first().textContent().catch(() => '')).includes(stations[0].name));
  await within('extension volume -> page', () => send({ type: 'player', action: 'volume', value: 64 }), async () => (await page.locator('#volume').inputValue()) === '64');
  await page.screenshot({ path: resolve(ARTIFACTS, 'extension-real-synced.png') });

  // 6. The page itself plays nothing and talks to no relay.
  const audio = await page.evaluate(() => { const a = document.getElementById('audio'); return { src: a.getAttribute('src'), currentSrc: a.currentSrc, paused: a.paused }; });
  report.pageAudio = audio;
  expect(audio.src, 'no <audio> src on the page').toBeNull();
  expect(audio.currentSrc).toBe('');
  const tunerHost = new URL(tuner.https).host;
  report.pageRequests = appRequests.filter((u) => !u.startsWith(APP));
  expect(appRequests.filter((u) => u.includes(tunerHost) && /\/audio\//.test(u)), 'no audio fetched by the page').toEqual([]);
  expect(appRequests.filter((u) => u.includes('/melodica/api/') || u.includes('/services/json/')), 'no relay or Pandora request by the page').toEqual([]);
  expect(errors).toEqual([]);
  await info.attach('timings', { body: JSON.stringify(report.timings, null, 2), contentType: 'application/json' });
  await send({ type: 'player', action: 'stop' }).catch(() => {});
});
