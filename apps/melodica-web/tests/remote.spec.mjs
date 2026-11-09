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
// Also: an extension without a Pandora session (the page says to sign in there and
// offers to open its login), a slow first state (still remote, never local), an
// extension that appears only after the page started on its own (the page switches
// without a reload), and an extension before 0.3.0 (no remote: the page uses the relay).
//
// Artifacts: tests/artifacts/remote-player.png, remote-signed-out.png.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { makeScrobbles, serveNode } from './tools/fake-scrobble.mjs';

// Any bearer names the one listener here; seeded so the page has listens to show.
const scrobbles = makeScrobbles({ who: (t) => (t ? 'e:listener@example.com' : '') });
scrobbles.seedCount = 3;

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
  `style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src https: http: blob:; ` +
  `connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'`;

let server = null;
let base = '';
const apiHits = [];
const audioHits = [];
const SHELL_PATHS = new Set(['/melodica/', '/melodica/listens/', '/melodica/leaderboard/', '/melodica/map/', '/melodica/account/', '/melodica/extension/']);

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
    if (url.pathname.startsWith('/scrobble/')) { await serveNode(scrobbles.handle, req, res, 'http://localhost'); return; }
    if (url.pathname.startsWith('/melodica/api')) {
      apiHits.push(`${req.method} ${url.pathname}${url.search}`);
      res.writeHead(500); res.end('remote mode must not use the relay'); return;
    }
    // The shell's routes (site/src/worker.js): index.html with a base; small fragments.
    if (SHELL_PATHS.has(url.pathname)) {
      if (url.searchParams.has('fragment')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<main class="wrap"><h1>${url.pathname}</h1><p>fragment</p></main>`); return; }
      const page = (await readFile(resolve(DIST, 'index.html'), 'utf8')).replace(/<head>/i, `<head>\n<base href="${APP_PATH}">`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp(randomBytes(16).toString('base64')).replace("base-uri 'none'", "base-uri 'self'") });
      res.end(page);
      return;
    }
    // Audio from anywhere but the fake extension: remote mode must fetch none.
    if (/\.(mp3|m4a|aac|mp4)$/.test(url.pathname) || url.pathname.includes('/audio')) { audioHits.push(url.pathname); res.writeHead(404); res.end(); return; }
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
  scrobbles.attach(server);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}${APP_PATH}`;
});

test.afterAll(async () => {
  scrobbles.closeSockets();
  if (server) await new Promise((ok) => server.close(ok));
});

// The fake extension. `opts.loggedIn` false: no Pandora session yet. `opts.stateDelay`:
// the first state comes that many ms after the first subscribe (a slow service worker).
// `opts.lateReady`: the content script says nothing until then (ms), then announces
// itself. `opts.player` false: an extension before 0.3.0. `opts.openLogin`: it knows
// the open-login command. `opts.session`: it speaks the session layer (docs/BRIDGE.md 4,
// ready says session: 1), holding `opts.extSession` (or none), `opts.credential` and
// `opts.revoked`; window.__ext.logout() signs it out as its popup would.
function fakeExtension(opts) {
  const log = window.__remote = { sent: [], commands: [], pushes: 0, gets: 0, offers: [], logouts: [], accountSignouts: 0 };
  const tracks = [
    { title: 'Slow Light', artist: 'Aurora Fields', album: 'Northern', trackToken: 'T1', duration: 200, rating: 0, coverArt: '' },
    { title: 'Second Song', artist: 'Band Two', album: 'Album Two', trackToken: 'T2', duration: 180, rating: 0, coverArt: '' },
    { title: 'Third Song', artist: 'Band Three', album: 'Album Three', trackToken: 'T3', duration: 150, rating: 0, coverArt: '' },
  ];
  const st = {
    status: 'idle', station: null, track: null, position: 0, duration: 0, volume: 70, quality: 'high',
    queueLength: 0, error: '', history: [], changedAt: Date.now(), loggedIn: opts.loggedIn !== false,
    user: { username: 'moonlit', chosen: true, suggested: '', notice: '', prompt: false },
    last: opts.last || null,
    notice: '',
    stations: opts.loggedIn === false ? [] : [
      { token: 'QM', name: 'QuickMix', isQuickMix: true, allowDelete: false },
      { token: 'S1', name: 'Aurora Fields Radio', isQuickMix: false, allowDelete: true },
      { token: 'S2', name: 'Band Two Radio', isQuickMix: false, allowDelete: true },
    ],
  };
  let subscribed = false;
  let firstAsked = 0;
  let idx = 0;
  const born = Date.now();
  const ready = () => post({ type: 'ready', name: 'melodica-extension', version: opts.player === false ? '0.2.0' : opts.session ? '0.6.0' : '0.3.0',
    ...(opts.player === false ? {} : { player: true }), ...(opts.session ? { session: 1 } : {}) });
  let sess = opts.extSession || null;
  let credential = opts.credential || null;
  const revoked = [...(opts.revoked || [])];
  if (opts.session) st.loggedIn = !!sess;
  const sessionMsg = (id) => ({ type: 'session', ...(id ? { id } : {}), session: sess, credential, account: { signedIn: false, username: '', github: null }, revoked: [...revoked], access: sess ? (opts.access || null) : null });
  const signOut = (sid) => {
    if (sid && !revoked.includes(sid)) revoked.push(sid);
    if (sess && (!sid || sess.sid === sid)) { if (!revoked.includes(sess.sid)) revoked.push(sess.sid); sess = null; credential = null; st.loggedIn = false; st.status = 'idle'; st.track = null; }
  };
  window.__ext = { logout() { signOut(sess && sess.sid); post(sessionMsg()); push(); } };
  if (opts.lateReady) setTimeout(ready, opts.lateReady);
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
    if (opts.lateReady && Date.now() - born < opts.lateReady) return; // not injected yet
    if (d.type === 'hello') { ready(); return; }
    if (d.type === 'subscribe') {
      if (opts.player === false) return;
      if (!firstAsked) firstAsked = Date.now();
      const wait = (opts.stateDelay || 0) - (Date.now() - firstAsked);
      if (wait > 0) { setTimeout(() => { if (!subscribed) { subscribed = true; push(); } }, wait); return; }
      subscribed = true; push(); return;
    }
    if (d.type === 'unsubscribe') { subscribed = false; return; }
    if (opts.session && d.type === 'session-get') {
      log.gets += 1;
      post(sessionMsg(d.id));
      // docs/BRIDGE.md 4.6: a spacegho.st sign-out made while no page was there.
      if (opts.accountSignoutPending && log.gets === 1) post({ type: 'account-signout' });
      return;
    }
    if (opts.session && d.type === 'account-signout' && d.id) { log.accountSignouts += 1; post({ type: 'result', id: d.id, ok: true, error: '' }); return; }
    if (opts.session && d.type === 'session-offer') {
      log.offers.push({ sid: d.session && d.session.sid, email: d.session && d.session.email, password: d.credential && d.credential.password });
      let outcome = 'signed-in';
      if (revoked.includes(d.session.sid)) outcome = 'revoked';
      else if (sess) outcome = 'kept';
      else { sess = d.session; credential = d.credential || null; st.loggedIn = true; }
      post({ type: 'result', id: d.id, ok: outcome !== 'revoked', outcome, error: '' });
      if (outcome === 'signed-in') { post(sessionMsg()); push(); }
      return;
    }
    if (opts.session && d.type === 'session-logout') {
      log.logouts.push(d.sid);
      signOut(d.sid);
      post({ type: 'result', id: d.id, ok: true, error: '' });
      post(sessionMsg()); push();
      return;
    }
    if (d.type !== 'command') return;
    const { id, action } = d;
    log.commands.push(action === 'play' && d.station ? `play ${d.station.token}` : action === 'volume' || action === 'quality' ? `${action} ${d.value}` : action);
    let ok = true;
    let error = '';
    if (action === 'open-login') { ok = !!opts.openLogin; error = ok ? '' : `unknown action ${action}`; }
    else if (!st.loggedIn) { ok = false; error = 'Not signed in to Pandora in the extension.'; }
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
    else if (action === 'resume') {
      if (!st.last) { ok = false; error = 'nothing to resume'; } else {
        st.track = { ...st.last, quality: st.quality, audioFormat: 'aacplus' };
        delete st.track.position; delete st.track.savedAt; delete st.track.station;
        st.station = st.last.station; st.position = st.last.position; st.duration = st.last.duration; st.status = 'playing';
      }
    } else if (action === 'stations') st.stations = [...st.stations, { token: 'S3', name: 'New Station', isQuickMix: false, allowDelete: true }];
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
      await expect(page.locator('#search-form')).toBeHidden();
      // The extension's username in the account chip (0.5.4+ state.user), never an email.
      await expect(page.locator('#signed-in')).toHaveText('moonlit');
      await expect(page.locator('#signed-in-full')).toHaveText('Playing in the melodica extension as moonlit');
      await expect(page.locator('#username-change')).toBeHidden();
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
      // While visible the page asks for the current state about once a second.
      const subs = remote.sent.filter((t) => t === 'subscribe').length;
      await page.waitForTimeout(2500);
      const later = (await page.evaluate(() => window.__remote)).sent.filter((t) => t === 'subscribe').length;
      expect(later - subs, 'state refreshed every second').toBeGreaterThanOrEqual(2);
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

  test('an extension without a Pandora session: the page says to sign in there and opens its login', async ({ page }, info) => {
    const evidence = await open(page, { loggedIn: false, openLogin: true });
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote');
      await expect(page.locator('#view-login')).toBeHidden();
      await expect(page.locator('#remote-signin')).toBeVisible();
      await expect(page.locator('#remote-signin-text')).toHaveText('Sign in in the melodica extension');
      await page.screenshot({ path: resolve(ARTIFACTS, 'remote-signed-out.png') });
      await info.attach('remote-signed-out', { path: resolve(ARTIFACTS, 'remote-signed-out.png'), contentType: 'image/png' });
      await page.click('#remote-signin-open');
      await expect.poll(() => page.evaluate(() => window.__remote.commands.at(-1))).toBe('open-login');
      await expect(page.locator('#remote-signin-help')).toBeHidden();
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('an extension that cannot open its login: the page says where it is', async ({ page }, info) => {
    const evidence = await open(page, { loggedIn: false });
    try {
      await expect(page.locator('#remote-signin')).toBeVisible();
      await page.click('#remote-signin-open');
      await expect(page.locator('#remote-signin-help')).toHaveText("Click the melodica icon in the browser's toolbar to sign in.");
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('a slow first state (2.5 s): the page stays a remote, asks again, and never logs in itself', async ({ page }, info) => {
    const evidence = await open(page, { stateDelay: 2500 });
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote');
      await expect(page.locator('#player-message')).toHaveText('Connecting to the melodica extension…');
      await expect(page.locator('#station-list button.station')).toHaveText(['QuickMix', 'Aurora Fields Radio', 'Band Two Radio'], { timeout: 5000 });
      await expect(page.locator('#player-message')).toHaveText('');
      await expect(page.locator('#view-login')).toBeHidden();
      const remote = await page.evaluate(() => window.__remote);
      expect(remote.sent.filter((t) => t === 'subscribe').length, 'subscribe repeated').toBeGreaterThan(1);
      expect(apiHits, 'no relay requests').toEqual([]);
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('an extension that appears after the page started on its own: the page switches without a reload', async ({ page }, info) => {
    const evidence = await open(page, { lateReady: 4500 });
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
      expect(await page.locator('#app').getAttribute('data-mode')).toBeNull();
      await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote', { timeout: 8000 });
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'player');
      await expect(page.locator('#status')).toContainText('playing in melodica extension 0.3.0');
      await expect(page.locator('#station-list button.station')).toHaveCount(3);
      const audio = await page.evaluate(() => document.getElementById('audio').getAttribute('src'));
      expect(audio).toBeNull();
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('an extension before 0.3.0 (no remote): the page plays on its own through the relay', async ({ page }, info) => {
    const evidence = await open(page, { player: false });
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
      await page.waitForTimeout(3500);
      expect(await page.locator('#app').getAttribute('data-mode')).toBeNull();
      await expect(page.locator('#status')).toContainText('relay');
      await expect(page.locator('#status')).toContainText('melodica.h');
      const remote = await page.evaluate(() => window.__remote);
      expect(remote.sent.filter((t) => t !== 'hello'), 'nothing but hello is sent to it').toEqual([]);
    } finally {
      await finish(page, evidence, info);
    }
  });
});

// What the page's encrypted store holds (web/vault.js), read inside the page.
const vaultRead = (page) => page.evaluate(async () => { const { Vault } = await import('./vault.js'); return new Vault().read(); });
const SESSION = (sid, email = 'listener@example.com') => ({
  sid, email, partner: { authToken: `PAT-${sid}`, id: 42 }, user: { authToken: `UAT-${sid}`, id: '437598256' }, syncOffset: -3, createdAt: Date.now(),
});

test.describe.serial('sessions with the extension (docs/BRIDGE.md 4)', () => {
  test('signed out of spacegho.st here while the extension was away: it hears account-signout at the next start', async ({ page }, info) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('melodica.account.signout', '1'); } });
    const evidence = await open(page, { session: true });
    await expect.poll(() => page.evaluate(() => window.__remote.accountSignouts), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('melodica.account.signout')), { timeout: 5_000 }).toBeNull();
    await finish(page, evidence, info);
  });

  test('the extension signed out of spacegho.st: the page forgets its spacegho.st tokens', async ({ page }, info) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('melodica.account', JSON.stringify({ access: 'A', refresh: 'R', expiresAt: Date.now() + 3600_000 })); } });
    const evidence = await open(page, { session: true, accountSignoutPending: true });
    await expect.poll(() => page.evaluate(() => localStorage.getItem('melodica.account')), { timeout: 10_000 }).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('melodica.account.silent')), 'no silent sign-in after it').toBe('1');
    expect(await page.evaluate(() => window.__remote.accountSignouts), 'not echoed back').toBe(0);
    await finish(page, evidence, info);
  });

  test('page signed in, extension signed out: the page offers its session and the extension signs in', async ({ page }, info) => {
    const evidence = await open(page, { session: true });
    await page.evaluate(async (rec) => { const { Vault } = await import('./vault.js'); await new Vault().write(rec); },
      { session: SESSION('S1'), credential: { email: 'listener@example.com', password: 'pw-S1-secret' }, relay: null });
    await page.reload({ waitUntil: 'load' });
    await expect.poll(() => page.evaluate(() => window.__remote.offers.length), { timeout: 10_000 }).toBe(1);
    const offer = (await page.evaluate(() => window.__remote.offers))[0];
    expect(offer).toEqual({ sid: 'S1', email: 'listener@example.com', password: 'pw-S1-secret' });
    await expect(page.locator('#remote-signin')).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote');
    expect(apiHits, 'no relay request').toEqual([]);
    await finish(page, evidence, info);
  });

  test('extension signed in: the page keeps its own encrypted copy, credential included', async ({ page }, info) => {
    const evidence = await open(page, { session: true, extSession: SESSION('S2'), credential: { email: 'listener@example.com', password: 'pw-S2-secret' },
      access: 'eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.sig' });
    await expect.poll(async () => (await vaultRead(page))?.session?.sid, { timeout: 10_000 }).toBe('S2');
    const rec = await vaultRead(page);
    expect(rec.credential).toEqual({ email: 'listener@example.com', password: 'pw-S2-secret' });
    expect(rec.relay && rec.relay.token, 'the extension\'s access token kept for the relay').toBe('eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.sig');
    expect(rec.session.user.authToken).toBe('UAT-S2');
    await page.click('#account summary');
    await expect(page.locator('#remember-menu')).toBeChecked();
    await expect(page.locator('#logout')).toBeVisible();
    expect(await page.evaluate(() => window.__remote.offers.length), 'nothing offered back').toBe(0);
    await finish(page, evidence, info);
  });

  test('scrobbling in remote mode: the page shows the listens and never submits (the extension does)', async ({ page }, info) => {
    scrobbles.posts.length = 0;
    const evidence = await open(page, { session: true, extSession: SESSION('S7'), credential: { email: 'listener@example.com', password: 'pw-S7-secret' },
      access: 'eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.sig' });
    await expect(page.locator('#listens-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#sui-listens li.hist')).toHaveCount(3);
    await expect(page.locator('#scrobble-notice')).toBeHidden();
    await page.locator('#station-list button.station', { hasText: 'Aurora Fields Radio' }).click();
    await expect(page.locator('#np-title')).toHaveText('Slow Light');
    await page.click('#btn-next');
    await expect(page.locator('#np-title')).toHaveText('Second Song');
    await page.click('#btn-next');
    await page.waitForTimeout(1500);
    await page.click('#account summary');
    await expect(page.locator('#scrobble-on')).toBeChecked();
    expect(scrobbles.posts.map((p) => p.body && p.body.listen_type), 'listens the page submitted').toEqual([]);
    await finish(page, evidence, info);
  });

  test('remote mode with only the spacegho.st account: the listens and leaderboard panels use its token', async ({ page }, info) => {
    scrobbles.requests.length = 0;
    scrobbles.auth.length = 0;
    scrobbles.posts.length = 0;
    await page.addInitScript(() => { if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('melodica.account', JSON.stringify({ access: 'ACCOUNT-TOKEN', refresh: 'R', expiresAt: Date.now() + 3600_000 })); } });
    const evidence = await open(page, { session: true, extSession: SESSION('S8'), credential: null });
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote');
    await expect(page.locator('#listens-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#sui-listens li.hist')).toHaveCount(3);
    await page.click('#tab-leaderboard');
    await expect(page.locator('#sui-leaderboard')).toContainText('Slow Light');
    expect(scrobbles.auth.filter((a) => a !== 'Bearer ACCOUNT-TOKEN'), 'every Scrobbles request carried the account token').toEqual([]);
    expect(scrobbles.posts, 'nothing submitted').toEqual([]);
    await finish(page, evidence, info);
  });

  test('signed out here while the extension was away: its session is signed out at the next start', async ({ page }, info) => {
    await page.addInitScript(() => localStorage.setItem('melodica.revoked', JSON.stringify(['S3'])));
    const evidence = await open(page, { session: true, extSession: SESSION('S3') });
    await expect.poll(() => page.evaluate(() => window.__remote.logouts), { timeout: 10_000 }).toEqual(['S3']);
    await expect(page.locator('#remote-signin')).toBeVisible();
    expect(await vaultRead(page), 'no copy of a revoked session').toBeNull();
    await finish(page, evidence, info);
  });

  test('the extension signs out: the page wipes its copy', async ({ page }, info) => {
    const evidence = await open(page, { session: true, extSession: SESSION('S4') });
    await expect.poll(async () => (await vaultRead(page))?.session?.sid, { timeout: 10_000 }).toBe('S4');
    await page.evaluate(() => window.__ext.logout());
    await expect.poll(() => vaultRead(page), { timeout: 5_000 }).toBeNull();
    await expect(page.locator('#remote-signin')).toBeVisible();
    await finish(page, evidence, info);
  });

  test('signing out on the page signs the extension out too', async ({ page }, info) => {
    const evidence = await open(page, { session: true, extSession: SESSION('S5') });
    await expect.poll(async () => (await vaultRead(page))?.session?.sid, { timeout: 10_000 }).toBe('S5');
    await page.click('#account summary');
    await page.click('#logout');
    await expect.poll(() => page.evaluate(() => window.__remote.logouts), { timeout: 5_000 }).toEqual(['S5']);
    await expect(page.locator('#remote-signin')).toBeVisible();
    expect(await vaultRead(page)).toBeNull();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('melodica.revoked') || '[]'))).toContain('S5');
    await finish(page, evidence, info);
  });

  test('a revoked session offered to the extension is wiped here, not signed back in', async ({ page }, info) => {
    const evidence = await open(page, { session: true, revoked: ['S6'] });
    await page.evaluate(async (rec) => { const { Vault } = await import('./vault.js'); await new Vault().write(rec); }, { session: SESSION('S6'), credential: null, relay: null });
    await page.reload({ waitUntil: 'load' });
    // The extension lists S6 as revoked in its answer: the page wipes without offering.
    await expect.poll(() => vaultRead(page), { timeout: 10_000 }).toBeNull();
    expect(await page.evaluate(() => window.__remote.offers.length)).toBe(0);
    await expect(page.locator('#remote-signin')).toBeVisible();
    await finish(page, evidence, info);
  });
});


// ---------------------------------------------------------------- the shell and Resume (0.11.0)
test.describe.serial('remote mode in the app shell', () => {
  test('every route at 1280 and 390 as a remote: the bar pinned to the bottom, driving the extension; the page fetches no audio and keeps no copy', async ({ page }, info) => {
    const requests = [];
    page.on('request', (r) => { if (r.resourceType() === 'media' || /\.(mp3|m4a|aac|mp4)(\?|$)/.test(r.url()) || r.url().includes('/audio')) requests.push(r.url()); });
    const evidence = await open(page);
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote', { timeout: 10_000 });
    await page.locator('#station-list button.station', { hasText: 'Aurora Fields Radio' }).click();
    await expect(page.locator('#mini-title')).toHaveText('Slow Light');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width > 760 ? 800 : 844 });
      // No Map link: this listener is not a crew viewer.
      await expect(page.locator('#site-nav a[data-k="map"]')).toBeHidden();
      for (const k of ['home', 'listens', 'leaderboard', 'account', 'extension', 'app']) {
        await page.click(`#site-nav a[data-k="${k}"]`);
        await expect(page.locator('#app')).toHaveAttribute('data-route', k);
        for (const where of ['top', 'middle', 'bottom']) {
          await page.evaluate((w) => { const max = document.documentElement.scrollHeight - innerHeight; scrollTo(0, w === 'top' ? 0 : w === 'middle' ? Math.round(max / 2) : max); }, where);
          const b = await page.evaluate(() => { const r = document.getElementById('bar').getBoundingClientRect(); return { bottom: r.bottom, vh: innerHeight }; });
          expect(Math.abs(b.bottom - b.vh), `${k} ${width} ${where}`).toBeLessThanOrEqual(0.5);
        }
        await expect(page.locator('#bar')).toHaveAttribute('data-state', 'player');
        await expect(page.locator('#mini-title')).not.toHaveText('');
      }
      await page.screenshot({ path: resolve(ARTIFACTS, `shell-remote-${width}.png`) });
    }
    // The bar drives the extension from any route.
    await page.click('#site-nav a[data-k="leaderboard"]');
    const n = (await page.evaluate(() => window.__remote.commands)).length;
    await page.click('#btn-next');
    await expect.poll(() => page.evaluate(() => window.__remote.commands.slice(-1)[0])).toBe('next');
    expect((await page.evaluate(() => window.__remote.commands)).length).toBe(n + 1);
    await expect(page.locator('#mini-title')).toHaveText('Second Song');
    expect(requests, 'audio requests from the page').toEqual([]);
    expect(audioHits, 'audio served to the page').toEqual([]);
    expect(await page.evaluate(async () => (await caches.keys()).length), 'Cache API stores').toBe(0);
    expect(apiHits, 'relay requests').toEqual([]);
    await finish(page, evidence, info);
  });

  test("the extension's last song: shown paused with Resume; Resume sends resume and plays it at its position", async ({ page }, info) => {
    const requests = [];
    page.on('request', (r) => { if (r.resourceType() === 'media') requests.push(r.url()); });
    const last = { title: 'Slow Light', artist: 'Aurora Fields', album: 'Northern', coverArt: '', trackToken: 'T1', station: { token: 'S1', name: 'Aurora Fields Radio' }, position: 83, duration: 200, savedAt: Date.now() - 60_000 };
    const evidence = await open(page, { last });
    await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote', { timeout: 10_000 });
    await expect(page.locator('#mini-title')).toHaveText('Slow Light');
    await expect(page.locator('#bar-resume')).toBeVisible();
    await expect(page.locator('#bar-resume')).toHaveText('Resume at 1:23');
    await expect(page.locator('#time-cur')).toHaveText('1:23');
    await page.screenshot({ path: resolve(ARTIFACTS, 'resume-remote.png') });
    await page.click('#bar-resume');
    await expect.poll(() => page.evaluate(() => window.__remote.commands.slice(-1)[0])).toBe('resume');
    await expect(page.locator('#bar-resume')).toBeHidden();
    await expect(page.locator('#btn-play')).toHaveAttribute('data-state', 'playing');
    expect(requests, 'media requests from the page').toEqual([]);
    expect(await page.evaluate(async () => (await caches.keys()).length), 'Cache API stores').toBe(0);
    await finish(page, evidence, info);
  });
});
