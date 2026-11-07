// End-to-end proof against melodica-tuner (a stand-in tuner.pandora.com):
// the built client logs in, lists the fixture's stations, picks one and
// plays audio, all in a headless browser.
//
// The tuner comes from either
//   TUNER_HTTPS_URL / TUNER_HTTP_URL / TUNER_USER / TUNER_PASSWORD
//     (the Spaceghost/melodica-tuner action's outputs; CI), or
//   MELODICA_TUNER_DIR (a checkout; default ../../melodica-tuner when present):
//     the test starts `python3 -m tuner --tls-auto` itself on 8443/8080.
// Without either the test is skipped as "no tuner".
//
// The tuner runs strict by default, which (like Pandora) refuses
// auth.userLogin and station.getPlaylist over plain http, so the client is
// pointed at the https listener with its throwaway CA and the browser
// context ignores the certificate error. Audio and art come back as http
// URLs on the http listener, exactly like Pandora's CDN.
//
// Pandora (and the tuner) serve AAC-LC in .m4a to the android partner the
// client uses; Playwright's Chromium decoded it in rehearsal (readyState 4,
// "playing"). MELODICA_BROWSER_CHANNEL=chrome switches to Google Chrome if a
// Chromium build ever lacks the decoder.
//
// Artifacts in tests/artifacts/: smoke-web-login.png, smoke-web-stations.png,
// smoke-web-playing.png and smoke-web.json (the minisite's smoke report shape;
// ok:false with the failure in "summary" when a step did not happen).

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const ARTIFACTS = resolve(here, 'artifacts');
const APP_PATH = '/melodica/app/';
const TUNER_DIR = process.env.MELODICA_TUNER_DIR || resolve(here, '..', '..', 'melodica-tuner');
const CHANNEL = process.env.MELODICA_BROWSER_CHANNEL || '';

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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8',
};
// The site worker's APP_CSP with the tuner's two origins in connect-src and
// its plain-http audio/art allowed (Pandora's CDN is http too).
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; ` +
  `style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; media-src https: http:; ` +
  `connect-src 'self' ${new URL(tuner.https).origin} ${new URL(tuner.http).origin}; font-src 'self'; ` +
  `base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'`;

const report = { steps: [], summary: '', ok: false };
const step = (s) => { if (!report.steps.includes(s)) report.steps.push(s); };

test.use({
  ignoreHTTPSErrors: true,
  ...(CHANNEL ? { channel: CHANNEL } : {}),
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
});

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

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

let server = null;
let appUrl = '';

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (!haveTuner) return;
  if (!tuner.https) await startTuner();
  if (!tuner.http) throw new Error('TUNER_HTTP_URL is required alongside TUNER_HTTPS_URL');
  const health = await getJson(`${tuner.http}/__tuner/health`);
  tuner.version = String(health.version || '');
  await fetch(`${tuner.http}/__tuner/reset`, { method: 'POST' });

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(APP_PATH)) { res.writeHead(404); res.end('not found'); return; }
    let rel = url.pathname.slice(APP_PATH.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some((p) => !p || p === '.' || p === '..')) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(resolve(DIST, rel));
      const type = MIME[extname(rel)] || 'application/octet-stream';
      const headers = { 'content-type': type, 'content-length': body.length, 'x-content-type-options': 'nosniff' };
      if (type.startsWith('text/html')) headers['content-security-policy'] = csp(randomBytes(16).toString('base64'));
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  appUrl = `http://127.0.0.1:${port}${APP_PATH}?api=${encodeURIComponent(`${tuner.https}/services/json/`)}`;
});

test.afterAll(async () => {
  if (server) await new Promise((ok) => server.close(ok));
  if (tuner.proc) { tuner.proc.kill('SIGTERM'); tuner.proc = null; }
  if (tuner.dir) await rm(tuner.dir, { recursive: true, force: true });
  if (!haveTuner) return;
  const out = {
    ok: report.ok,
    platform: 'web',
    summary: report.summary,
    when: new Date().toISOString(),
    steps: report.steps,
    tuner: tuner.version,
    browser: report.browser || '',
    audio: report.audio || null,
  };
  await writeFile(resolve(ARTIFACTS, 'smoke-web.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`smoke-web.json: ${JSON.stringify(out)}`);
});

test('logs in to melodica-tuner, lists its stations and plays a track', async ({ page, browserName }, info) => {
  test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
  const evidence = { console: [], errors: [], failed: [], api: [], violations: [] };
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (ev) => {
      window.__cspViolations.push({ directive: ev.violatedDirective, blocked: ev.blockedURI, sample: ev.sample });
    });
    window.__audioEvents = [];
    document.addEventListener('DOMContentLoaded', () => {
      const a = document.getElementById('audio');
      for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing', 'timeupdate', 'error', 'pause', 'ended']) {
        a.addEventListener(name, () => {
          if (name === 'timeupdate' && window.__audioEvents.includes('timeupdate')) return;
          window.__audioEvents.push(name);
        });
      }
    });
  });
  page.on('console', (msg) => evidence.console.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => evidence.errors.push(String(err && err.stack || err)));
  page.on('requestfailed', (req) => evidence.failed.push(`${req.method()} ${req.url()} ${req.failure()?.errorText}`));
  page.on('response', (res) => {
    const u = res.url();
    if (u.startsWith(tuner.https) || u.startsWith(tuner.http)) {
      evidence.api.push(`${res.request().method()} ${u.replace(/auth_token=[^&]+/, 'auth_token=…')} -> ${res.status()}`);
    }
  });

  try {
    report.browser = `${browserName}${CHANNEL ? ` (${CHANNEL})` : ''} ${page.context().browser()?.version() || ''}`.trim();
    await page.goto(appUrl, { waitUntil: 'load' });
    await expect(page).toHaveTitle(/melodica/);
    step('loaded');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.locator('#status')).toContainText('melodica.h');
    step('login screen');
    await page.screenshot({ path: resolve(ARTIFACTS, 'smoke-web-login.png') });

    await page.fill('#login-email', tuner.user);
    await page.fill('#login-password', tuner.password);
    await page.click('#login-button');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 30_000 });
    await expect(page.locator('#login-message')).toHaveText('');
    step('logged in');

    const stations = page.locator('#station-list button.station');
    await expect(stations.first()).toBeVisible();
    const names = await stations.allTextContents();
    console.log(`stations: ${names.join(' | ')}`);
    const state = await getJson(`${tuner.http}/__tuner/state`);
    const me = (state.users || []).find((u) => u.email === tuner.user) || {};
    const expected = (me.stations || []).map((s) => s.stationName).filter(Boolean);
    expect(expected.length, 'stations known to the tuner for this listener').toBeGreaterThan(0);
    expect(names.length, 'station count').toBeGreaterThan(1);
    for (const n of expected) expect(names, `station "${n}" from the tuner fixture`).toContain(n);
    expect(names, 'the fixture station').toContain('Aurora Fields Radio');
    step('stations listed');
    await page.screenshot({ path: resolve(ARTIFACTS, 'smoke-web-stations.png') });

    const first = stations.first();
    const chosen = (await first.textContent()).trim();
    await first.click();
    await expect(page.locator('#np-title')).not.toHaveText(/^(Pick a station)?$/, { timeout: 30_000 });
    await expect(page.locator('#np-artist')).not.toHaveText('');
    await expect(page.locator('#np-station')).toContainText(chosen);
    const now = {
      title: (await page.locator('#np-title').textContent()).trim(),
      artist: (await page.locator('#np-artist').textContent()).trim(),
      station: chosen,
    };
    console.log(`now playing: ${now.title} – ${now.artist} on ${now.station}`);

    // Actual decoding: HAVE_CURRENT_DATA or better, or the element reported
    // playing/timeupdate. 'error' means the browser could not decode it.
    await page.waitForFunction(() => {
      const a = document.getElementById('audio');
      return a.readyState >= 2 || window.__audioEvents.includes('playing') || window.__audioEvents.includes('error');
    }, null, { timeout: 30_000 });
    // Give it a moment to advance so currentTime is evidence too.
    await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.5
      || window.__audioEvents.includes('error'), null, { timeout: 10_000 }).catch(() => {});
    const audio = await page.evaluate(() => {
      const a = document.getElementById('audio');
      return {
        src: a.src, readyState: a.readyState, networkState: a.networkState, paused: a.paused,
        currentTime: a.currentTime, duration: a.duration, error: a.error ? a.error.code : null,
        events: window.__audioEvents.slice(), playerMessage: document.getElementById('player-message').textContent,
      };
    });
    report.audio = { ...audio, ...now };
    console.log(`audio: ${JSON.stringify(audio)}`);
    await page.screenshot({ path: resolve(ARTIFACTS, 'smoke-web-playing.png') });
    expect(audio.error, `audio element error (${audio.playerMessage})`).toBeNull();
    expect(audio.src, 'audio src from the tuner').toContain('/audio/');
    expect(audio.readyState, 'HTMLMediaElement.readyState').toBeGreaterThanOrEqual(2);
    expect(audio.events, 'audio events').toContain('playing');
    expect(audio.paused, 'audio paused').toBe(false);
    step('playing');

    // The tuner's own record of what the client did.
    const log = await getJson(`${tuner.http}/__tuner/log`);
    const calls = log.map((e) => `${e.protocol} ${e.httpMethod} ${e.method || e.path} -> ${e.status}${e.code == null ? '' : ` code=${e.code}`}${e.secure ? ' (https)' : ''}`);
    console.log(`tuner log (${log.length}):\n  ${calls.join('\n  ')}`);
    await info.attach('tuner-log', { body: JSON.stringify(log, null, 2), contentType: 'application/json' });
    const okCall = (m) => log.some((e) => e.protocol === 'json' && e.method === m && e.code == null && e.status === 200);
    for (const m of ['auth.partnerLogin', 'auth.userLogin', 'user.getStationList', 'station.getPlaylist']) {
      expect(okCall(m), `tuner log shows ${m} succeeding`).toBe(true);
      step(`${m} ok`);
    }
    const audioGet = log.find((e) => e.protocol === 'audio' && e.httpMethod === 'GET' && String(e.path).startsWith('/audio/'));
    expect(audioGet, 'tuner log shows a GET /audio/ fetch').toBeTruthy();
    step('audio fetched');

    evidence.violations = await page.evaluate(() => window.__cspViolations);
    expect(evidence.violations, 'CSP violations').toEqual([]);
    expect(evidence.errors, 'uncaught page errors').toEqual([]);
    expect(evidence.console.filter((l) => l.startsWith('[error]')), 'console errors').toEqual([]);

    report.ok = true;
    report.summary = `melodica-web ${await readFile(resolve(DIST, 'VERSION'), 'utf8').then((s) => s.trim()).catch(() => '')} ` +
      `in headless ${report.browser} logged in to melodica-tuner ${tuner.version}, listed ${names.length} stations, ` +
      `played "${now.title}" by ${now.artist} on ${now.station} (readyState ${audio.readyState}, ${audio.currentTime.toFixed(1)}s, events: ${audio.events.join(',')})`;
  } catch (err) {
    report.summary = `failed after [${report.steps.join(', ')}]: ${String(err && err.message || err).split('\n')[0]}`;
    throw err;
  } finally {
    const lines = [
      `url: ${appUrl}`, `browser: ${report.browser}`,
      `console (${evidence.console.length}):`, ...evidence.console.map((l) => `  ${l}`),
      `page errors (${evidence.errors.length}):`, ...evidence.errors.map((l) => `  ${l}`),
      `failed requests (${evidence.failed.length}):`, ...evidence.failed.map((l) => `  ${l}`),
      `csp violations (${evidence.violations.length}):`, ...evidence.violations.map((v) => `  ${JSON.stringify(v)}`),
      `tuner requests seen by the browser (${evidence.api.length}):`, ...evidence.api.map((l) => `  ${l}`),
    ];
    console.log(lines.join('\n'));
    await info.attach('evidence', { body: lines.join('\n'), contentType: 'text/plain' });
  }
});
