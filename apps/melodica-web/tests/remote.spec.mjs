// Remote mode in a real browser: the melodica extension (0.3.0+) plays in the
// background and the page is a view of it (melodica-extension docs/BRIDGE.md).
//
// A page-world script injected before app.js plays the extension: hello -> ready
// (player: true), subscribe -> state, then a small fake background player that
// changes its state on commands (play, toggle, next, love, ban, tired, volume,
// quality, stations) and pushes a state on every change and every 200 ms while
// "playing". window.__remote records what the page sent. No network: the local
// server serves dist/ with the site's CSP and answers /melodica/auth/me with 503;
// any /melodica/api/ request is recorded (remote mode must make none).
//
// Also: an extension that answers ready with player: true but ignores subscribe
// leaves the page in local mode (the Pandora login), after the 1 s probe.
//
// Artifacts: tests/artifacts/remote-player.png, remote-signed-out.png.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const ARTIFACTS = resolve(here, 'artifacts');
const APP_PATH = '/melodica/app/';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8',
};
// The site worker's APP_CSP, unchanged: remote mode needs nothing new.
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; ` +
  `style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src https: http:; ` +
  `connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'`;

let server = null;
let base = '';
const apiHits = [];

// Chromium logs "Failed to load resource" for the expected 503 from /auth/me.
function expectedResourceError(msg) {
  if (msg.type() !== 'error' || !/Failed to load resource/.test(msg.text())) return false;
  return /\/melodica\/auth\//.test((msg.location() && msg.location().url) || '');
}

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/melodica/auth/me') {
      res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"auth not configured"}'); return;
    }
    if (url.pathname.startsWith('/melodica/api')) {
      apiHits.push(`${req.method} ${url.pathname}${url.search}`);
      res.writeHead(500); res.end('remote mode must not use the relay'); return;
    }
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
  base = `http://127.0.0.1:${server.address().port}${APP_PATH}`;
});

test.afterAll(async () => {
  if (server) await new Promise((ok) => server.close(ok));
});

// The fake extension. `opts.subscribe` false plays an extension that ignores
// subscribe; `opts.loggedIn` false one that has no Pandora session yet.
function fakeExtension(opts) {
  const log = window.__remote = { sent: [], commands: [], pushes: 0 };
  const tracks = [
    { title: 'Slow Light', artist: 'Aurora Fields', album: 'Northern', trackToken: 'T1', duration: 200, rating: 0, coverArt: '' },
    { title: 'Second Song', artist: 'Band Two', album: 'Album Two', trackToken: 'T2', duration: 180, rating: 0, coverArt: '' },
    { title: 'Third Song', artist: 'Band Three', album: 'Album Three', trackToken: 'T3', duration: 150, rating: 0, coverArt: '' },
  ];
  const st = {
    status: 'idle', station: null, track: null, position: 0, duration: 0, volume: 70, quality: 'high',
    queueLength: 0, error: '', history: [], changedAt: Date.now(), loggedIn: opts.loggedIn !== false,
    gate: { mode: 'allowed', login: 'alice' },
    stations: opts.loggedIn === false ? [] : [
      { token: 'QM', name: 'QuickMix', isQuickMix: true, allowDelete: false },
      { token: 'S1', name: 'Aurora Fields Radio', isQuickMix: false, allowDelete: true },
      { token: 'S2', name: 'Band Two Radio', isQuickMix: false, allowDelete: true },
    ],
  };
  let subscribed = false;
  let idx = 0;
  const post = (m) => window.postMessage({ melodica: 1, ...m }, location.origin);
  const push = () => {
    if (!subscribed) return;
    st.changedAt = Date.now();
    log.pushes += 1;
    post({ type: 'state', state: JSON.parse(JSON.stringify(st)) });
  };
  const startTrack = () => {
    st.track = { ...tracks[idx % tracks.length], quality: st.quality, audioFormat: 'aacplus' };
    st.position = 0;
    st.duration = st.track.duration;
    st.status = 'playing';
    st.queueLength = 3;
  };
  setInterval(() => { if (st.status === 'playing') { st.position += 0.2; push(); } }, 200);
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.melodica !== 1) return;
    if (['hello', 'subscribe', 'unsubscribe', 'command', 'request'].includes(d.type)) log.sent.push(d.type);
    if (d.type === 'hello') { post({ type: 'ready', name: 'melodica-extension', version: '0.3.0', player: true }); return; }
    if (d.type === 'subscribe') { if (opts.subscribe === false) return; subscribed = true; push(); return; }
    if (d.type === 'unsubscribe') { subscribed = false; return; }
    if (d.type !== 'command') return;
    const { id, action } = d;
    log.commands.push(action === 'play' && d.station ? `play ${d.station.token}` : action === 'volume' || action === 'quality' ? `${action} ${d.value}` : action);
    let ok = true;
    let error = '';
    if (!st.loggedIn) { ok = false; error = 'Not signed in to Pandora in the extension.'; }
    else if (action === 'play') {
      if (d.station) { st.station = { token: d.station.token, name: d.station.name }; idx = 0; startTrack(); } else st.status = 'playing';
    } else if (action === 'pause') st.status = 'paused';
    else if (action === 'toggle') st.status = st.status === 'playing' ? 'paused' : 'playing';
    else if (action === 'next' || action === 'tired' || action === 'ban') {
      if (action === 'ban') st.track.rating = 2;
      idx += 1; startTrack();
    } else if (action === 'love') st.track.rating = 1;
    else if (action === 'volume') st.volume = d.value;
    else if (action === 'quality') st.quality = d.value;
    else if (action === 'stations') st.stations = [...st.stations, { token: 'S3', name: 'New Station', isQuickMix: false, allowDelete: true }];
    else { ok = false; error = `unknown action ${action}`; }
    post({ type: 'result', id, ok, error, state: JSON.parse(JSON.stringify(st)) });
    push();
  });
}

async function open(page, opts = {}) {
  const evidence = { console: [], errors: [] };
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (ev) => window.__cspViolations.push({ directive: ev.violatedDirective, blocked: ev.blockedURI }));
  });
  await page.addInitScript(fakeExtension, opts);
  page.on('console', (msg) => { if (!expectedResourceError(msg)) evidence.console.push(`[${msg.type()}] ${msg.text()}`); });
  page.on('pageerror', (err) => evidence.errors.push(String(err && err.stack || err)));
  apiHits.length = 0;
  await page.goto(base, { waitUntil: 'load' });
  await expect(page.locator('#app')).not.toHaveAttribute('data-view', 'loading', { timeout: 30_000 });
  return evidence;
}

async function finish(page, evidence, info) {
  const remote = await page.evaluate(() => window.__remote);
  const violations = await page.evaluate(() => window.__cspViolations);
  const lines = [
    `view: ${await page.locator('#app').getAttribute('data-view')} mode: ${await page.locator('#app').getAttribute('data-mode')}`,
    `status: ${await page.locator('#status').textContent()}`,
    `page -> extension: ${remote.sent.join(', ')}`,
    `commands: ${remote.commands.join(', ')}`,
    `state pushes: ${remote.pushes}`,
    `relay requests: ${apiHits.length}`,
    `console (${evidence.console.length}):`, ...evidence.console.map((l) => `  ${l}`),
    `page errors (${evidence.errors.length}):`, ...evidence.errors.map((l) => `  ${l}`),
    `csp violations (${violations.length}):`, ...violations.map((v) => `  ${JSON.stringify(v)}`),
  ];
  console.log(lines.join('\n'));
  await info.attach('evidence', { body: lines.join('\n'), contentType: 'text/plain' });
  expect(evidence.errors, 'uncaught page errors').toEqual([]);
  expect(evidence.console.filter((l) => l.startsWith('[error]')), 'console errors').toEqual([]);
  expect(violations, 'CSP violations').toEqual([]);
}

test.describe.serial('remote mode (the extension plays, the page is a view)', () => {
  test('subscribe -> state: the player view, driven by pushed state; controls send commands', async ({ page }, info) => {
    const evidence = await open(page);
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'player');
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote');
      await expect(page.locator('#status')).toContainText('playing in melodica extension 0.3.0');
      await expect(page.locator('#view-login')).toBeHidden();
      await expect(page.locator('#view-github')).toBeHidden();
      await expect(page.locator('#search-form')).toBeHidden();
      // The station list comes from the extension's state; no delete buttons (no such command).
      const stations = page.locator('#station-list button.station');
      await expect(stations).toHaveText(['QuickMix', 'Aurora Fields Radio', 'Band Two Radio']);
      await expect(page.locator('#station-list button.delete')).toHaveCount(0);
      await expect(page.locator('#volume')).toHaveValue('70');

      // Pick a station: a play command with its token; the pushed state fills now playing.
      await page.locator('#station-list button.station', { hasText: 'Aurora Fields Radio' }).click();
      await expect(page.locator('#np-title')).toHaveText('Slow Light');
      await expect(page.locator('#np-artist')).toHaveText('Aurora Fields');
      await expect(page.locator('#np-station')).toContainText('Aurora Fields Radio');
      await expect(page.locator('#station-list li.active')).toContainText('Aurora Fields Radio');
      await expect(page.locator('#btn-play')).toHaveAttribute('data-state', 'playing');
      await expect(page.locator('#up-next-empty')).toHaveText('3 songs queued in the extension.');
      // Position follows the pushes.
      await expect(page.locator('#time-cur')).not.toHaveText('0:00', { timeout: 5_000 });
      await expect(page.locator('#time-len')).toHaveText('3:20');
      await page.screenshot({ path: resolve(ARTIFACTS, 'remote-player.png') });
      await info.attach('remote-player', { path: resolve(ARTIFACTS, 'remote-player.png'), contentType: 'image/png' });

      // Transport controls.
      await page.click('#btn-play');
      await expect(page.locator('#btn-play')).toHaveAttribute('data-state', 'paused');
      await page.click('#btn-play');
      await expect(page.locator('#btn-play')).toHaveAttribute('data-state', 'playing');
      await page.click('#btn-love');
      await expect(page.locator('#btn-love')).toHaveAttribute('aria-pressed', 'true');
      await page.click('#btn-next');
      await expect(page.locator('#np-title')).toHaveText('Second Song');
      await page.click('#btn-tired');
      await expect(page.locator('#np-title')).toHaveText('Third Song');
      // Keyboard shortcuts drive the remote too.
      await page.locator('#btn-play').focus();
      await page.keyboard.press('n');
      await expect(page.locator('#np-title')).toHaveText('Slow Light');
      // Volume and quality.
      await page.locator('#volume').fill('35');
      await expect.poll(() => page.evaluate(() => window.__remote.commands.at(-1))).toBe('volume 35');
      await page.selectOption('#quality', 'low');
      await expect.poll(() => page.evaluate(() => window.__remote.commands.at(-1))).toBe('quality low');
      await page.click('#refresh-stations');
      await expect(stations).toHaveText(['QuickMix', 'Aurora Fields Radio', 'Band Two Radio', 'New Station']);
      // Play log collects what the extension played.
      await expect(page.locator('#history li')).toHaveCount(3);

      const remote = await page.evaluate(() => window.__remote);
      expect(remote.sent.slice(0, 2), 'hello, then subscribe').toEqual(['hello', 'subscribe']);
      expect(remote.sent, 'no relay requests through the bridge').not.toContain('request');
      expect(remote.commands).toEqual(['play S1', 'toggle', 'toggle', 'love', 'next', 'tired', 'next', 'volume 35', 'quality low', 'stations']);
      expect(apiHits, 'no relay requests').toEqual([]);
      // No local playback at all.
      const audio = await page.evaluate(() => ({ src: document.getElementById('audio').getAttribute('src'), paused: document.getElementById('audio').paused }));
      expect(audio).toEqual({ src: null, paused: true });
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('an extension without a Pandora session: remote view says where to sign in; failed commands are reported', async ({ page }, info) => {
    const evidence = await open(page, { loggedIn: false });
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote');
      await expect(page.locator('#np-hint')).toHaveText('Sign in to Pandora in the melodica extension, then come back.');
      await page.screenshot({ path: resolve(ARTIFACTS, 'remote-signed-out.png') });
      await info.attach('remote-signed-out', { path: resolve(ARTIFACTS, 'remote-signed-out.png'), contentType: 'image/png' });
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('an extension that ignores subscribe leaves the page in local mode', async ({ page }, info) => {
    const evidence = await open(page, { subscribe: false });
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
      expect(await page.locator('#app').getAttribute('data-mode')).toBeNull();
      await expect(page.locator('#status')).toContainText('direct via melodica-extension 0.3.0');
      await expect(page.locator('#status')).toContainText('melodica.h');
      const remote = await page.evaluate(() => window.__remote);
      expect(remote.sent).toEqual(['hello', 'subscribe', 'unsubscribe']);
    } finally {
      await finish(page, evidence, info);
    }
  });
});
