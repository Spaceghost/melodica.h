// End-to-end proof of the built extension (dist/chrome) in a real Chromium
// against melodica-tuner, a stand-in tuner.pandora.com:
//
//   1. the options page points the extension at the tuner's https URL;
//   2. the popup (opened as an extension tab) signs in with the tuner user,
//      lists the fixture's stations and starts a station, which opens the
//      player tab; the player shows the song and the <audio> element plays;
//   3. the bridge: melodica-web's dist (tests/fixtures) is served on a local
//      https server that Chromium resolves as https://spacegho.st, the page
//      posts the protocol's `hello` and a `request` for auth.partnerLogin and
//      must get `ready` and a successful `response` back through the
//      extension, which the tuner's log confirms.
//
// Chromium is launched headed (CI wraps it in xvfb-run) with the unpacked
// extension; the new headless mode is also fine but headed is what the
// extension docs promise. --ignore-certificate-errors covers the tuner's and
// the local page server's throwaway certificates, including inside the
// extension's service worker, and --host-resolver-rules maps spacegho.st to
// the local server.
//
// Environment: TUNER_HTTPS_URL / TUNER_HTTP_URL / TUNER_USER / TUNER_PASSWORD
// (the Spaceghost/melodica-tuner action's outputs), or MELODICA_TUNER_DIR to
// start a checkout here. MELODICA_EXT_DIST (default dist/chrome).
// Output: tests/artifacts/smoke-extension.json, smoke-extension-login.png,
// smoke-extension-stations.png, smoke-extension-playing.png,
// smoke-extension-bridge.png.

import { test, expect, chromium } from '@playwright/test';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const EXT = resolve(process.env.MELODICA_EXT_DIST || resolve(root, 'dist/chrome'));
const WEB_DIST = resolve(here, 'fixtures/melodica-web-dist');
const ARTIFACTS = resolve(here, 'artifacts');
const TUNER_DIR = process.env.MELODICA_TUNER_DIR || resolve(root, '..', 'melodica-tuner');
const APP_PATH = '/melodica/app/';
const WEB_HOST = 'spacegho.st';

const tuner = {
  https: process.env.TUNER_HTTPS_URL || '',
  http: process.env.TUNER_HTTP_URL || '',
  user: process.env.TUNER_USER || 'test@example.com',
  password: process.env.TUNER_PASSWORD || 'test',
  version: '',
  proc: null,
  dir: null,
};
const haveTuner = !!tuner.https || existsSync(join(TUNER_DIR, 'tuner', '__main__.py'));

const report = { steps: [], summary: '', ok: false, bridge: null, audio: null, browser: '', extension: {} };
const step = (s) => { if (!report.steps.includes(s)) report.steps.push(s); };
const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
};

async function startTuner() {
  tuner.dir = await mkdtemp(join(tmpdir(), 'melodica-tuner-'));
  const ready = join(tuner.dir, 'ready');
  const args = ['-m', 'tuner', '--bind', '127.0.0.1', '--https-port', '8443', '--http-port', '8080',
    '--tls-auto', join(tuner.dir, 'certs'), '--user', tuner.user, '--password', tuner.password,
    '--ready-file', ready, '--log-level', 'info'];
  const out = [];
  tuner.proc = spawn('python3', args, { cwd: TUNER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  tuner.proc.stdout.on('data', (d) => out.push(String(d)));
  tuner.proc.stderr.on('data', (d) => out.push(String(d)));
  for (let i = 0; i < 120 && !existsSync(ready); i++) await new Promise((ok) => setTimeout(ok, 500));
  if (!existsSync(ready)) throw new Error(`tuner did not become ready:\n${out.join('')}`);
  const lines = (await readFile(ready, 'utf8')).trim().split('\n');
  tuner.https = lines[0].trim();
  tuner.http = lines[1].trim();
  console.log(`tuner started: ${tuner.https} ${tuner.http}`);
}

// A throwaway certificate for the local "spacegho.st" page server.
async function makeCert(dir) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '2', '-subj', `/CN=${WEB_HOST}`, '-addext', `subjectAltName=DNS:${WEB_HOST}`], { stdio: 'ignore' });
  return { key: await readFile(key), cert: await readFile(cert) };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8',
};
// The site worker's CSP for the page (its relay origin is irrelevant here).
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https: http:; media-src https: http:; connect-src 'self'; font-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'";

let web = { server: null, port: 0, dir: null };
let context = null;
let userDataDir = null;

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (!haveTuner) return;
  if (!tuner.https) await startTuner();
  if (!tuner.http) throw new Error('TUNER_HTTP_URL is required alongside TUNER_HTTPS_URL');
  const health = await getJson(`${tuner.http}/__tuner/health`);
  tuner.version = String(health.version || '');
  await fetch(`${tuner.http}/__tuner/reset`, { method: 'POST' });

  web.dir = await mkdtemp(join(tmpdir(), 'melodica-web-'));
  const tls = await makeCert(web.dir);
  web.server = https.createServer(tls, async (req, res) => {
    const url = new URL(req.url, `https://${WEB_HOST}`);
    if (!url.pathname.startsWith(APP_PATH)) { res.writeHead(404); res.end('not found'); return; }
    let rel = url.pathname.slice(APP_PATH.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some((p) => !p || p === '.' || p === '..')) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(resolve(WEB_DIST, rel));
      const type = MIME[extname(rel)] || 'application/octet-stream';
      const headers = { 'content-type': type, 'content-length': body.length, 'x-content-type-options': 'nosniff' };
      if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise((ok) => web.server.listen(0, '127.0.0.1', ok));
  web.port = web.server.address().port;

  userDataDir = await mkdtemp(join(tmpdir(), 'melodica-ext-profile-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--ignore-certificate-errors',
      `--host-resolver-rules=MAP ${WEB_HOST} 127.0.0.1:${web.port}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
    ],
  });
});

test.afterAll(async () => {
  if (context) await context.close().catch(() => {});
  if (web.server) await new Promise((ok) => web.server.close(ok));
  if (tuner.proc) { tuner.proc.kill('SIGTERM'); tuner.proc = null; }
  for (const d of [tuner.dir, web.dir, userDataDir]) if (d) await rm(d, { recursive: true, force: true }).catch(() => {});
  if (!haveTuner) return;
  const out = {
    ok: report.ok,
    platform: 'browser-extension',
    summary: report.summary,
    when: new Date().toISOString(),
    steps: report.steps,
    tuner: tuner.version,
    browser: report.browser,
    extension: report.extension,
    audio: report.audio,
    bridge: report.bridge,
  };
  await writeFile(resolve(ARTIFACTS, 'smoke-extension.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`smoke-extension.json: ${JSON.stringify(out)}`);
});

async function extensionId() {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  return new URL(sw.url()).host;
}

test('signs in through the popup, plays a station in the player tab, bridges the web app', async ({}, info) => {
  test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
  const evidence = { console: [], errors: [], failed: [], api: [] };
  const t0 = Date.now();
  const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const onWorkerConsole = (msg) => { if (msg.page() === null) evidence.console.push(`${at()} [worker:${msg.type()}] ${msg.text()}`); };
  context.on('console', onWorkerConsole);
  const watch = (page, label) => {
    page.on('console', (msg) => evidence.console.push(`${at()} [${label}:${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => evidence.errors.push(`[${label}] ${String(err && err.stack || err)}`));
    page.on('requestfailed', (req) => evidence.failed.push(`[${label}] ${req.method()} ${req.url()} ${req.failure()?.errorText}`));
  };
  try {
    report.browser = `chromium ${context.browser()?.version() || ''}`.trim();
    const id = await extensionId();
    const manifest = JSON.parse(await readFile(resolve(EXT, 'manifest.json'), 'utf8'));
    report.extension = { id, version: manifest.version_name || manifest.version, name: manifest.name };
    console.log(`extension ${id} ${report.extension.version}`);
    step('extension loaded');

    // 1. Options: point at the tuner.
    const options = await context.newPage();
    watch(options, 'options');
    await options.goto(`chrome-extension://${id}/options.html`);
    await expect(options.locator('#endpoint')).toBeVisible();
    await options.fill('#endpoint', `${tuner.https}/services/json/`);
    await options.click('#save');
    await expect(options.locator('#options-message')).toContainText('Saved');
    step('endpoint set');
    await options.close();

    // 2. Popup as a tab: login, stations.
    const popup = await context.newPage();
    watch(popup, 'popup');
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
    await expect(popup.locator('#login-email')).toBeVisible();
    step('login screen');
    await popup.screenshot({ path: resolve(ARTIFACTS, 'smoke-extension-login.png') });

    await popup.fill('#login-email', tuner.user);
    await popup.fill('#login-password', tuner.password);
    await popup.click('#login-button');
    await popup.waitForFunction(() => document.getElementById('app').dataset.view === 'player' || /error/.test(document.getElementById('login-message')?.className || ''), null, { timeout: 60_000, polling: 500 }).catch(() => {});
    const outcome = await popup.evaluate(() => ({ view: document.getElementById('app').dataset.view, message: document.getElementById('login-message')?.textContent || '' }));
    console.log(`login outcome ${at()}: ${JSON.stringify(outcome)}`);
    expect(outcome.view, `login outcome (message: "${outcome.message}")`).toBe('player');
    step('logged in');

    const stations = popup.locator('#station-list button.station');
    await expect(stations.first()).toBeVisible();
    const names = await stations.allTextContents();
    console.log(`stations: ${names.join(' | ')}`);
    const state = await getJson(`${tuner.http}/__tuner/state`);
    const me = (state.users || []).find((u) => u.email === tuner.user) || {};
    const expected = (me.stations || []).map((s) => s.stationName).filter(Boolean);
    expect(expected.length, 'stations known to the tuner for this listener').toBeGreaterThan(0);
    for (const n of expected) expect(names, `station "${n}" from the tuner fixture`).toContain(n);
    expect(names, 'the fixture station').toContain('Aurora Fields Radio');
    step('stations listed');
    await popup.screenshot({ path: resolve(ARTIFACTS, 'smoke-extension-stations.png') });

    // 3. Start a station: the player tab opens and plays.
    const playerPromise = context.waitForEvent('page', { timeout: 30_000 });
    const chosen = (await stations.first().textContent()).trim();
    await stations.first().click();
    const player = await playerPromise;
    watch(player, 'player');
    await player.waitForLoadState('load');
    expect(player.url(), 'player tab url').toContain(`chrome-extension://${id}/player.html`);
    await expect(player.locator('#np-title')).not.toHaveText(/^(Pick a station)?$/, { timeout: 30_000 });
    await expect(player.locator('#np-artist')).not.toHaveText('');
    await expect(player.locator('#np-station')).toContainText(chosen);
    const now = {
      title: (await player.locator('#np-title').textContent()).trim(),
      artist: (await player.locator('#np-artist').textContent()).trim(),
      station: chosen,
    };
    console.log(`now playing: ${now.title} – ${now.artist} on ${now.station}`);
    await player.waitForFunction(() => {
      const a = document.getElementById('audio');
      return a && (a.readyState >= 2 || a.error);
    }, null, { timeout: 30_000 });
    await player.waitForFunction(() => {
      const a = document.getElementById('audio');
      return a && (a.currentTime > 0.5 || a.error);
    }, null, { timeout: 15_000 }).catch(() => {});
    const audio = await player.evaluate(() => {
      const a = document.getElementById('audio');
      return { src: a.src, readyState: a.readyState, paused: a.paused, currentTime: a.currentTime, duration: a.duration, error: a.error ? a.error.code : null };
    });
    report.audio = { ...audio, ...now };
    console.log(`audio: ${JSON.stringify(audio)}`);
    await player.screenshot({ path: resolve(ARTIFACTS, 'smoke-extension-playing.png') });
    expect(audio.error, 'audio element error').toBeNull();
    expect(audio.src, 'audio src from the tuner').toContain('/audio/');
    expect(audio.readyState, 'HTMLMediaElement.readyState').toBeGreaterThanOrEqual(2);
    expect(audio.paused, 'audio paused').toBe(false);
    step('playing');

    // The popup mirrors the player's state through the background.
    await expect(popup.locator('#np-title')).toHaveText(now.title, { timeout: 15_000 });
    step('popup mirrors now playing');

    // 4. The bridge: melodica-web's page on https://spacegho.st (local server).
    const page = await context.newPage();
    watch(page, 'web');
    await page.addInitScript(() => {
      window.__melodica = [];
      window.addEventListener('message', (ev) => {
        if (ev.source === window && ev.data && ev.data.melodica === 1) window.__melodica.push(ev.data);
      });
    });
    await page.goto(`https://${WEB_HOST}${APP_PATH}`, { waitUntil: 'load' });
    await expect(page).toHaveTitle(/melodica/);
    step('web app loaded');
    // The content script announces itself once on load.
    await page.waitForFunction(() => window.__melodica.some((m) => m.type === 'ready'), null, { timeout: 15_000 });
    const announced = await page.evaluate(() => window.__melodica.find((m) => m.type === 'ready'));
    expect(announced.name).toBe('melodica-extension');
    expect(announced.version).toBe(manifest.version);
    step('bridge announced');
    // hello -> ready
    const ready = await page.evaluate(() => new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('no ready within 10s')), 10_000);
      window.addEventListener('message', function h(ev) {
        if (ev.source !== window || !ev.data || ev.data.melodica !== 1 || ev.data.type !== 'ready') return;
        window.removeEventListener('message', h); clearTimeout(t); ok(ev.data);
      });
      window.postMessage({ melodica: 1, type: 'hello' }, location.origin);
    }));
    expect(ready.name).toBe('melodica-extension');
    step('bridge hello/ready');
    // request -> response: a real auth.partnerLogin through the extension to the tuner.
    const roundTrip = await page.evaluate(() => new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('no response within 20s')), 20_000);
      const id = 'smoke-' + Math.random().toString(36).slice(2);
      window.addEventListener('message', function h(ev) {
        if (ev.source !== window || !ev.data || ev.data.melodica !== 1 || ev.data.type !== 'response' || ev.data.id !== id) return;
        window.removeEventListener('message', h); clearTimeout(t);
        const d = ev.data;
        ok({ ok: d.ok, status: d.status, error: d.error, isBytes: d.body instanceof Uint8Array, text: new TextDecoder().decode(d.body) });
      });
      const body = new TextEncoder().encode(JSON.stringify({
        username: 'android', password: 'AC7IBG09A3DTSYM4R41UJWL07VLN8JI7', deviceModel: 'android-generic', version: '5', includeUrls: true,
      }));
      window.postMessage({ melodica: 1, type: 'request', id, search: '?method=auth.partnerLogin', body }, location.origin);
    }));
    console.log(`bridge round trip: ${JSON.stringify({ ...roundTrip, text: roundTrip.text.slice(0, 120) })}`);
    expect(roundTrip.ok, `bridge response ok (${roundTrip.error || ''})`).toBe(true);
    expect(roundTrip.status).toBe(200);
    expect(roundTrip.isBytes, 'response body is a Uint8Array').toBe(true);
    const answer = JSON.parse(roundTrip.text);
    expect(answer.stat).toBe('ok');
    expect(typeof answer.result.partnerAuthToken).toBe('string');
    expect(typeof answer.result.syncTime).toBe('string');
    // A disallowed method is refused without touching the network.
    const refused = await page.evaluate(() => new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('no response within 10s')), 10_000);
      const id = 'refused';
      window.addEventListener('message', function h(ev) {
        if (ev.source !== window || !ev.data || ev.data.melodica !== 1 || ev.data.type !== 'response' || ev.data.id !== id) return;
        window.removeEventListener('message', h); clearTimeout(t); ok({ ok: ev.data.ok, error: ev.data.error });
      });
      window.postMessage({ melodica: 1, type: 'request', id, search: '?method=../../admin', body: new Uint8Array(0) }, location.origin);
    }));
    expect(refused.ok).toBe(false);
    report.bridge = { announced, ready, roundTrip: { ok: roundTrip.ok, status: roundTrip.status, stat: answer.stat }, refused };
    await page.screenshot({ path: resolve(ARTIFACTS, 'smoke-extension-bridge.png') });
    step('bridge round trip');

    // 5. The tuner's own record.
    const log = await getJson(`${tuner.http}/__tuner/log`);
    const calls = log.map((e) => `${e.protocol} ${e.httpMethod} ${e.method || e.path} -> ${e.status}${e.code == null ? '' : ` code=${e.code}`}${e.secure ? ' (https)' : ''}`);
    console.log(`tuner log (${log.length}):\n  ${calls.join('\n  ')}`);
    await info.attach('tuner-log', { body: JSON.stringify(log, null, 2), contentType: 'application/json' });
    const okCalls = (m) => log.filter((e) => e.protocol === 'json' && e.method === m && e.code == null && e.status === 200).length;
    for (const m of ['auth.partnerLogin', 'auth.userLogin', 'user.getStationList', 'station.getPlaylist']) {
      expect(okCalls(m), `tuner log shows ${m} succeeding`).toBeGreaterThan(0);
      step(`${m} ok`);
    }
    expect(okCalls('auth.partnerLogin'), 'two partner logins: the extension and the bridged page').toBeGreaterThanOrEqual(2);
    const audioGet = log.find((e) => e.protocol === 'audio' && e.httpMethod === 'GET' && String(e.path).startsWith('/audio/'));
    expect(audioGet, 'tuner log shows a GET /audio/ fetch').toBeTruthy();
    step('audio fetched');

    expect(evidence.errors, 'uncaught page errors').toEqual([]);
    const consoleErrors = evidence.console.filter((l) => /:error\]/.test(l) && !/relay|HTTP 4|melodica\/api/.test(l));
    expect(consoleErrors, 'console errors (extension pages)').toEqual(consoleErrors.filter((l) => l.startsWith('[web:')));

    report.ok = true;
    report.summary = `melodica-extension ${report.extension.version} (unpacked, ${report.browser}) pointed at melodica-tuner ${tuner.version} ` +
      `via the options page, signed in from the popup, listed ${names.length} stations, played "${now.title}" by ${now.artist} on ${now.station} ` +
      `in the player tab (readyState ${audio.readyState}, ${audio.currentTime.toFixed(1)}s), and bridged a partnerLogin for the melodica-web page on https://${WEB_HOST}`;
  } catch (err) {
    report.summary = `failed after [${report.steps.join(', ')}]: ${String(err && err.message || err).split('\n')[0]}`;
    throw err;
  } finally {
    context.off('console', onWorkerConsole);
    const tunerLog = await getJson(`${tuner.http}/__tuner/log`).catch(() => []);
    const calls = tunerLog.map((e) => `${e.protocol} ${e.httpMethod} ${e.method || e.path} -> ${e.status}${e.code == null ? '' : ` code=${e.code} ${e.message || ''}`}`);
    const lines = [
      `tuner log (${calls.length}):`, ...calls.map((l) => `  ${l}`),
      `extension: ${JSON.stringify(report.extension)}`, `browser: ${report.browser}`,
      `console (${evidence.console.length}):`, ...evidence.console.map((l) => `  ${l}`),
      `page errors (${evidence.errors.length}):`, ...evidence.errors.map((l) => `  ${l}`),
      `failed requests (${evidence.failed.length}):`, ...evidence.failed.map((l) => `  ${l}`),
    ];
    console.log(lines.join('\n'));
    await info.attach('evidence', { body: lines.join('\n'), contentType: 'text/plain' });
  }
});
