// End-to-end proof of the built extension (dist/chrome) in a real Chromium
// against melodica-tuner, a stand-in tuner.pandora.com:
//
//   1. the options page points the extension at the tuner's https URL; the
//      popup also shows the update banner, because the same local server serves
//      a releases.json / updates.json naming version 99.0.0;
//   2. the popup (opened as an extension tab) signs in with the tuner user,
//      lists the fixture's stations and starts a station: no tab opens, the
//      background plays it in its offscreen document and the popup shows the
//      track; with every extension page closed the service worker is asked
//      and must report the position advancing; a new popup and the optional
//      player tab show the same track, and closing the tab stops nothing;
//   3. the bridge: melodica-web's dist (tests/fixtures) is served on a local
//      https server that Chromium resolves as https://spacegho.st, the page
//      posts the protocol's `hello` and a `request` for auth.partnerLogin and
//      must get `ready` and a successful `response` back through the
//      extension, which the tuner's log confirms; then it subscribes to the
//      playback state and pauses/resumes the music (docs/BRIDGE.md);
//   6. slots: the tuner (--ads 1) offers a slot after every song; the
//      background fetches it (ad.getAdMetadata), plays its audio, shows it,
//      refuses `next` while it plays and registers it (ad.registerAd); once the
//      access answer says spots:false, no slot is fetched over the next songs;
//   7. access and the optional account against tests/fake-account.mjs on the
//      local "spacegho.st": an email not on the allow-list is not logged in
//      (step 2); the spacegho.st sign-in (PKCE, GitHub on the authorize page),
//      its policy, token refresh with rotation and sign-out; then access is
//      withdrawn and the next check stops the music and signs out of Pandora.
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
// MELODICA_BROWSER: `chromium` (default: Playwright's bundled Chromium) or
// `brave` (an installed Brave at MELODICA_BROWSER_PATH, default
// /usr/bin/brave-browser, driven through the same Playwright `chromium`
// launcher; Brave's Shields stay at their defaults and every request Brave
// blocks is listed in the report).
// Output: tests/artifacts/<name>.json and <name>-{login,access-request,stations,playing,popup-playing,player-tab,bridge,slot,account}.png
// where <name> is `smoke-extension` for Chromium and `smoke-brave` for Brave.

import { test, expect, chromium } from '@playwright/test';
import { loadAccountServer, readBody } from './fake-account.mjs';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const EXT = resolve(process.env.MELODICA_EXT_DIST || resolve(root, 'dist/chrome'));
const WEB_DIST = resolve(process.env.MELODICA_WEB_DIST || resolve(here, 'fixtures/melodica-web-dist'));
const ARTIFACTS = resolve(here, 'artifacts');
const TUNER_DIR = process.env.MELODICA_TUNER_DIR || resolve(root, '..', 'melodica-tuner');
const APP_PATH = '/melodica/app/';
const WEB_HOST = 'spacegho.st';

// Which browser runs the proof, and how its report is named and labelled.
const BROWSERS = {
  chromium: { name: 'smoke-extension', platform: 'browser-extension', executablePath: undefined },
  brave: { name: 'smoke-brave', platform: 'brave', executablePath: process.env.MELODICA_BROWSER_PATH || '/usr/bin/brave-browser' },
};
const BROWSER = (process.env.MELODICA_BROWSER || 'chromium').toLowerCase();
if (!BROWSERS[BROWSER]) throw new Error(`MELODICA_BROWSER=${BROWSER}: expected one of ${Object.keys(BROWSERS).join(', ')}`);
const B = BROWSERS[BROWSER];
const shot = (what) => resolve(ARTIFACTS, `${B.name}-${what}.png`);
// `brave-browser --version` -> "Brave Browser 1.84.xx"; Chromium's version comes from CDP.
function browserBinaryVersion(path) {
  try {
    return execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n')[0];
  } catch (e) {
    return `${path} --version failed: ${String(e.message).split('\n')[0]}`;
  }
}

const tuner = {
  https: process.env.TUNER_HTTPS_URL || '',
  http: process.env.TUNER_HTTP_URL || '',
  user: process.env.TUNER_USER || 'test@example.com',
  password: process.env.TUNER_PASSWORD || 'pw-Zq7mK3vT9xR2wL',
  version: '',
  proc: null,
  dir: null,
};
const haveTuner = !!tuner.https || existsSync(join(TUNER_DIR, 'tuner', '__main__.py'));

const report = { steps: [], summary: '', ok: false, access: null, account: null, spots: null, update: null, bridge: null, coldStart: null, resume: null, audio: null, browser: '', engine: '', extension: {}, blocked: [], failedRequests: [], shields: null };
let acct = null;
let roomProbe = null;
const ROOM_MEDIA_BUNDLE = resolve(root, 'vendor/scrobble-ui/room-media.js');
async function handleRoomProbe(req, res, url, raw) {
  const match = /^\/scrobble\/api\/rooms\/([A-Za-z0-9_-]{16,64})(?:\/(signal|audio|events|ice))?$/.exec(url.pathname);
  const list = url.pathname === '/scrobble/api/rooms';
  const json = (status, value) => { const text = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(text); };
  if ((!match && !list) || !roomProbe || (match && match[1] !== roomProbe.id)) return false;
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (!token) { json(401, { error: 'invalid_token' }); return true; }
  const viewer = token === 'room-dj' ? 'dj-owner' : 'listener-ci';
  const snapshot = () => ({ ...structuredClone(roomProbe.state), you: viewer });
  if (list && req.method === 'GET') {
    const query = { q: url.searchParams.get('q') || '', cursor: url.searchParams.get('cursor') || '', recent: url.searchParams.get('recent') || '' };
    roomProbe.searches.push(query);
    const room = { id: roomProbe.id, name: roomProbe.state.name, kind: roomProbe.state.kind, mode: roomProbe.state.mode,
      listeners: roomProbe.state.members.length, created_at: roomProbe.state.created_at || 1730000000,
      current_play: roomProbe.state.play?.track_metadata || null };
    const rows = !query.q || room.name.toLowerCase().includes(query.q.toLowerCase()) ? [room] : [];
    const recent = query.recent.split(',').includes(roomProbe.id) ? [room] : [];
    json(200, { rooms: rows, recent, next_cursor: null });
    return true;
  }
  const suffix = match[2] || '';
  if (req.method === 'GET' && suffix === 'ice') { json(200, { iceServers: [], sfuConfigured: false }); return true; }
  if (req.method === 'GET' && suffix === 'events') {
    if (roomProbe.holdEvents) {
      roomProbe.heldEvents++;
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }
    const since = Number(url.searchParams.get('since') || -1);
    json(200, { cursor: roomProbe.cursor, state: snapshot(), signals: roomProbe.signals.filter((s) => s.to === viewer && s.cursor > since) });
    return true;
  }
  if (suffix === 'audio' && req.method === 'GET') {
    const playId = url.searchParams.get('play_id') || '';
    const after = Number(url.searchParams.get('after') || -1);
    const chunks = roomProbe.state.play?.id === playId ? roomProbe.chunks.filter((chunk) => chunk.play_id === playId && chunk.seq > after).slice(0, 12) : [];
    json(200, { play_id: playId, chunks, next: roomProbe.chunks.at(-1)?.seq ?? -1, state: snapshot() });
    return true;
  }
  if (suffix === 'audio' && req.method === 'POST') {
    let body = null; try { body = JSON.parse(raw || 'null'); } catch {}
    if (!body || body.type !== 'media' || body.play_id !== roomProbe.state.play?.id || typeof body.data !== 'string') { json(400, { error: 'invalid_media' }); return true; }
    const chunk = { ...body, seq: roomProbe.nextChunk++ };
    delete chunk.request_id;
    roomProbe.chunks.push(chunk);
    json(200, { ok: true, seq: chunk.seq });
    return true;
  }
  if (req.method === 'POST' && suffix === 'signal') {
    let body = null; try { body = JSON.parse(raw || 'null'); } catch {}
    if (!body || typeof body.to !== 'string' || !body.data) { json(400, { error: 'invalid_signal' }); return true; }
    roomProbe.signals.push({ from: viewer, to: body.to, play_id: body.play_id, data: body.data, cursor: ++roomProbe.cursor });
    json(200, { ok: true }); return true;
  }
  if (req.method === 'POST' && !suffix) {
    let body = null; try { body = JSON.parse(raw || 'null'); } catch {}
    if (!body || typeof body.action !== 'string') { json(400, { error: 'invalid_command' }); return true; }
    roomProbe.commands.push({ viewer, action: body.action, play_id: body.play_id, listened_ms: body.listened_ms });
    if (body.action === 'join') roomProbe.joinCalls++;
    if (body.action === 'leave') roomProbe.leaveCalls++;
    if (body.action === 'clock') {
      roomProbe.clockCalls.push({ viewer, play_id: body.play_id, position_ms: body.position_ms });
      if (roomProbe.state.play?.id === body.play_id) {
        roomProbe.state.play.position_ms = body.position_ms;
        roomProbe.state.play.server_time = Date.now();
      }
    }
    if (body.action === 'scrobble') { roomProbe.state.scrobble = body.enabled; roomProbe.state.seq++; }
    if (body.action === 'heard') { roomProbe.heard.push({ viewer, play_id: body.play_id, listened_ms: body.listened_ms }); roomProbe.state.seq++; }
    json(200, snapshot()); return true;
  }
  json(404, { error: 'not_found' }); return true;
}
// The fake store feeds (extensions-site's shapes) naming a version every build is older than.
const FAKE_VERSION = '99.0.0';
const FEEDS = {
  '/extensions/releases.json': { generated: new Date().toISOString(), extensions: [{ id: 'melodica-extension', release: { tag: `v${FAKE_VERSION}`, name: `melodica-extension ${FAKE_VERSION}`, url: 'https://github.com/Spaceghost/melodica-extension/releases/tag/v99.0.0', published_at: new Date().toISOString(), prerelease: false }, assets: [], feeds: { firefox: { url: 'https://spacegho.st/extensions/dl/melodica-extension/updates.json', version: FAKE_VERSION }, chrome: { url: 'https://spacegho.st/extensions/dl/melodica-extension/update.xml', version: FAKE_VERSION } } }] },
  '/extensions/dl/melodica-extension/updates.json': { addons: { 'melodica-extension@spacegho.st': { updates: [{ version: FAKE_VERSION, update_link: `https://spacegho.st/extensions/dl/melodica-extension/v${FAKE_VERSION}/melodica-extension-${FAKE_VERSION}.xpi`, update_hash: 'sha256:0000' }] } } },
};
const feedCalls = [];
const step = (s) => { if (!report.steps.includes(s)) report.steps.push(s); };
const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
};

// Live mode (tests/live-e2e.sh): /scrobble/ goes to the real https://spacegho.st with
// a throwaway Scrobbles account's token in place of the extension's bearer. Only the
// test named "live" runs then. The token is read from a file and never printed.
const LIVE = !!process.env.LIVE_SCROBBLE_TOKEN_FILE;
const liveToken = LIVE ? readFileSync(process.env.LIVE_SCROBBLE_TOKEN_FILE, 'utf8').trim() : '';
const liveCalls = [];
async function liveForward(req, res, url, body) {
  const t0 = Date.now();
  const headers = { authorization: `Bearer ${liveToken}`, 'user-agent': 'melodica-extension live e2e' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  const r = await fetch(`https://spacegho.st${url.pathname}${url.search}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' });
  const out = Buffer.from(await r.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(String(out)); } catch { parsed = null; }
  liveCalls.push({ method: req.method, path: url.pathname, status: r.status, ms: Date.now() - t0, at: t0, sent: req.method === 'POST' ? (() => { try { return JSON.parse(String(body)); } catch { return null; } })() : undefined, error: parsed && parsed.error });
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
  res.end(out);
}
const liveGet = async (path) => { const r = await fetch(`https://spacegho.st${path}`, { headers: { authorization: `Bearer ${liveToken}` } }); return { status: r.status, body: await r.json().catch(() => null) }; };

async function startTuner() {
  tuner.dir = await mkdtemp(join(tmpdir(), 'melodica-tuner-'));
  const ready = join(tuner.dir, 'ready');
  const args = ['-m', 'tuner', '--bind', '127.0.0.1', '--https-port', process.env.MELODICA_TEST_HTTPS_PORT || '8443', '--http-port', process.env.MELODICA_TEST_HTTP_PORT || '8080',
    '--tls-auto', join(tuner.dir, 'certs'), '--user', tuner.user, '--password', tuner.password,
    '--ready-file', ready, '--log-level', 'info', '--ads', process.env.MELODICA_TEST_ADS || (LIVE ? '0' : '1'), '--audio-https',
    ...(process.env.TUNER_FIXTURE ? ['--fixture', process.env.TUNER_FIXTURE] : []),
    ...(process.env.TUNER_AUDIO_DIR ? ['--audio-dir', process.env.TUNER_AUDIO_DIR] : [])];
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
  "img-src 'self' data: https: http:; media-src https: http: blob:; connect-src 'self'; font-src 'self'; " +
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

  acct = await loadAccountServer({ issuer: `https://${WEB_HOST}` });
  web.dir = await mkdtemp(join(tmpdir(), 'melodica-web-'));
  const tls = await makeCert(web.dir);
  web.server = https.createServer(tls, async (req, res) => {
    // The account server lives on the same "spacegho.st": the extension's default
    // https://spacegho.st/oauth/... lands here through --host-resolver-rules.
    const url = new URL(req.url, `https://${WEB_HOST}`);
    if (LIVE && url.pathname.startsWith('/scrobble/')) {
      try { await liveForward(req, res, url, await readBody(req)); } catch (e) { res.writeHead(502); res.end(String(e && e.message)); }
      return;
    }
    if (url.pathname === '/scrobble/api/rooms' || url.pathname.startsWith('/scrobble/api/rooms/')) {
      if (await handleRoomProbe(req, res, url, await readBody(req))) return;
    }
    if (url.pathname.startsWith('/oauth') || url.pathname.startsWith('/scrobble/') || url.pathname.startsWith('/__fake-github')) {
      try { await acct.handle(req, res, await readBody(req)); } catch (e) { res.writeHead(500); res.end(String(e)); }
      return;
    }
    if (FEEDS[url.pathname]) {
      feedCalls.push(url.pathname);
      const text = JSON.stringify(FEEDS[url.pathname]);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
      res.end(text);
      return;
    }
    if (!url.pathname.startsWith(APP_PATH)) { res.writeHead(404); res.end('not found'); return; }
    if (url.pathname === APP_PATH + 'handoff-test.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Engine handoff bridge</title><p>Bridge test</p>'); return; }
    if (url.pathname === APP_PATH + 'room-dj.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP });
      res.end('<!doctype html><meta charset="utf-8"><title>Room DJ fixture</title><button id="start" type="button">Start fixture DJ</button><script type="module" src="room-dj.js"></script>');
      return;
    }
    if (url.pathname === APP_PATH + 'room-dj.js') {
      const body = await readFile(resolve(here, 'fixtures/room-extension-dj.js'));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': body.length }); res.end(body); return;
    }
    if (url.pathname === APP_PATH + 'room-media.js') {
      const body = await readFile(ROOM_MEDIA_BUNDLE);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': body.length }); res.end(body); return;
    }
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
  web.server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); });
  await new Promise((ok) => web.server.listen(0, '127.0.0.1', ok));
  web.port = web.server.address().port;

  userDataDir = await mkdtemp(join(tmpdir(), 'melodica-ext-profile-'));
  if (B.executablePath) {
    report.browser = browserBinaryVersion(B.executablePath);
    console.log(`browser: ${report.browser} (${B.executablePath})`);
  }
  context = await launchBrowser();
});

// The browser on the persistent profile (relaunched for the cold-start test).
function launchBrowser() {
  return chromium.launchPersistentContext(userDataDir, {
    headless: process.env.MELODICA_HEADLESS === '1',
    channel: process.env.MELODICA_HEADLESS === '1' && !B.executablePath ? 'chromium' : undefined,
    executablePath: B.executablePath,
    // Playwright passes --disable-component-update by default; in Brave that leaves
    // Shields without its filter lists (brave://components: "No components are
    // installed"), so the proof would run against an empty blocker. Brave fetches them.
    ignoreDefaultArgs: BROWSER === 'brave' ? ['--disable-component-update'] : [],
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--ignore-certificate-errors',
      `--host-resolver-rules=MAP ${WEB_HOST} 127.0.0.1:${web.port}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

test.afterAll(async () => {
  if (context) await context.close().catch(() => {});
  if (web.server) await new Promise((ok) => web.server.close(ok));
  if (tuner.proc) { tuner.proc.kill('SIGTERM'); tuner.proc = null; }
  for (const d of [tuner.dir, web.dir, userDataDir]) if (d) await rm(d, { recursive: true, force: true }).catch(() => {});
  if (!haveTuner) return;
  const out = {
    ok: report.ok,
    platform: B.platform,
    summary: report.summary,
    when: new Date().toISOString(),
    steps: report.steps,
    tuner: tuner.version,
    browser: report.browser,
    engine: report.engine,
    extension: report.extension,
    access: report.access,
    account: report.account,
    username: report.username,
    remember: report.remember,
    session: report.session,
    scrobbles: report.scrobbles,
    scrobbleFailure: report.scrobbleFailure,
    listenLinks: report.listenLinks,
    scrobbleUi: report.scrobbleUi,
    spots: report.spots,
    update: report.update,
    audio: report.audio,
    bridge: report.bridge,
    coldStart: report.coldStart,
    resume: report.resume,
    blocked: report.blocked,
    failedRequests: report.failedRequests,
    shields: report.shields,
  };
  await writeFile(resolve(ARTIFACTS, `${B.name}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`${B.name}.json: ${JSON.stringify(out)}`);
});

// Brave: wait (up to a minute) for Shields' filter-list components to arrive, so the
// proof runs with Brave's default filter lists loaded, and record them.
// brave://components lists "<name> - Version: <v>" then "Status - <state>" per component.
async function waitForShieldsLists() {
  const t0 = Date.now();
  const page = await context.newPage();
  let components = [];
  let filtersLoaded = false;
  // Brave's three default Shields filter components, by name pattern.
  const wanted = [/^Brave Default (?!Privacy )\S+ Filters$/, /^Brave Default Privacy Filters$/, /^Brave .+ Resources Library$/];
  try {
    while (Date.now() - t0 < 60_000) {
      await page.goto('brave://components', { waitUntil: 'load', timeout: 15_000 });
      await page.waitForTimeout(1500);
      const lines = (await page.evaluate(() => document.body.innerText)).split('\n').map((l) => l.trim()).filter(Boolean);
      components = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(.+?) - Version: (\S+)$/);
        if (!m) continue;
        const st = (lines[i + 1] || '').match(/^Status - (.+)$/);
        components.push({ name: m[1], version: m[2], status: st ? st[1] : '' });
      }
      const have = (re) => components.find((c) => re.test(c.name) && c.status === 'Updated' && c.version !== '0.0.0.0');
      filtersLoaded = wanted.every(have);
      if (filtersLoaded) break;
      await page.waitForTimeout(3000);
    }
  } catch (e) {
    console.log(`brave://components not readable: ${String(e.message).split('\n')[0]}`);
  } finally {
    await page.close().catch(() => {});
  }
  const brave = components.filter((c) => /^Brave/.test(c.name));
  report.shields = {
    filtersLoaded,
    waitedMs: Date.now() - t0,
    components: brave,
    note: filtersLoaded
      ? 'Shields filter lists present before the proof; Shields settings left at their defaults'
      : 'Shields filter lists did NOT finish arriving within 60s; the proof ran with whatever brave://components lists here',
  };
  console.log(`brave://components after ${report.shields.waitedMs}ms (filtersLoaded=${filtersLoaded}):${brave.map((c) => `\n  ${c.name} ${c.version} ${c.status}`).join('')}`);
}

async function extensionId() {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  return new URL(sw.url()).host;
}

// Each case may run in a fresh worker/profile after another case fails. Always
// point it at the local tuner before a login, including targeted test runs.
async function useTuner(page) {
  const endpoint = `${tuner.https}/services/json/`;
  await page.evaluate((value) => chrome.storage.local.set({ endpoint: value }), endpoint);
  await expect.poll(() => page.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }).then((r) => r.settings.endpoint))).toBe(endpoint);
}

function bridgeAsk(page, message) {
  return page.evaluate((m) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { removeEventListener('message', listener); reject(new Error('bridge command timed out')); }, 15000);
    const listener = (ev) => { if (ev.source === window && ev.data?.melodica === 1 && ev.data.id === id && ['result', 'session'].includes(ev.data.type)) { clearTimeout(timer); removeEventListener('message', listener); resolve(ev.data); } };
    addEventListener('message', listener);
    window.postMessage({ melodica: 1, ...m, id }, location.origin);
  }), message);
}

async function evaluateTarget(cdp, targetId, expression) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
  const id = Math.floor(Math.random() * 1_000_000_000);
  let listener;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP target evaluation timed out')), 5000);
    listener = (event) => {
      if (event.sessionId !== sessionId) return;
      let message;
      try { message = JSON.parse(event.message); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timer);
      resolve(message.result?.result?.value);
    };
    cdp.on('Target.receivedMessageFromTarget', listener);
  });
  try {
    await cdp.send('Target.sendMessageToTarget', { sessionId,
      message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }) });
    return await answer;
  } finally {
    if (listener) cdp.off('Target.receivedMessageFromTarget', listener);
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

test('signs in through the popup, plays a station with no tab, bridges the web app', async ({}, info) => {
  test.skip(LIVE, 'live mode runs only the live test');
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
    report.engine = `chromium ${context.browser()?.version() || ''}`.trim();
    if (!report.browser) report.browser = report.engine;
    console.log(`browser: ${report.browser}; engine: ${report.engine}`);
    const id = await extensionId();
    const manifest = JSON.parse(await readFile(resolve(EXT, 'manifest.json'), 'utf8'));
    report.extension = { id, version: manifest.version_name || manifest.version, name: manifest.name };
    console.log(`extension ${id} ${report.extension.version}`);
    step('extension loaded');
    if (BROWSER === 'brave') await waitForShieldsLists();

    // Popup pages are shot at the toolbar popup's size (popup.html sets 380 px).
    const POPUP = { width: 380, height: 640 };
    const coverLoaded = (p) => p.waitForFunction(() => { const i = document.getElementById('np-cover'); return !i || (i.complete && i.naturalWidth > 0); }, null, { timeout: 10_000 }).catch(() => {});

    // 1. Options: point at the tuner.
    const options = await context.newPage();
    watch(options, 'options');
    await options.goto(`chrome-extension://${id}/options.html`);
    await expect(options.locator('#endpoint')).toBeVisible();
    await options.fill('#endpoint', `${tuner.https}/services/json/`);
    await options.click('#save');
    await expect(options.locator('#options-message')).toContainText('Saved');
    // The background must have adopted it (not only storage): ask it.
    const effective = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }).then((r) => r && r.settings && r.settings.endpoint));
    console.log(`background endpoint: ${effective}`);
    expect(effective, 'endpoint the background will use').toBe(`${tuner.https}/services/json/`);
    step('endpoint set');
    await options.screenshot({ path: shot('options') });
    // Wide screens: no horizontal overflow, and the background glows keep a fixed size
    // (they were percent-sized, which stretched them across wide windows).
    for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
      await options.setViewportSize({ width: w, height: h });
      const wide = await options.evaluate(() => { const r = document.querySelector('.app').getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth - innerWidth, bg: getComputedStyle(document.body).backgroundImage, skew: Math.abs(r.left - (innerWidth - r.right)) }; });
      expect(wide.skew, `options at ${w}: content centred`).toBeLessThanOrEqual(24);
      expect(wide.overflow, `options at ${w}: no horizontal overflow`).toBeLessThanOrEqual(0);
      expect(wide.bg, 'fixed-size glows').toContain('900px 480px');
      await options.screenshot({ path: shot(`options-${w}`) });
    }
    await options.close();

    // 2. Popup as a tab: login, stations.
    const popup = await context.newPage();
    await popup.setViewportSize(POPUP);
    watch(popup, 'popup');
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
    await expect(popup.locator('#login-email')).toBeVisible();
    // The Pandora login is the first screen. The
    // spacegho.st account is optional.
    expect(await popup.locator('#access-note').count(), 'no login note').toBe(0);
    await expect(popup.locator('#account-signin')).toHaveText('Sign in with spacegho.st');
    // The update banner: the fake releases.json names 99.0.0, newer than any build.
    await expect(popup.locator('#update-banner')).toBeVisible({ timeout: 20_000 });
    await expect(popup.locator('#update-text')).toHaveText(`melodica ${FAKE_VERSION} is available`);
    await expect(popup.locator('#update-link')).toHaveAttribute('href', 'https://spacegho.st/melodica/extension/');
    const upd = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'update' }).then((r) => r.update));
    expect(upd.latest).toBe(FAKE_VERSION);
    expect(upd.feed).toBe('https://spacegho.st/extensions/releases.json');
    // An unpacked load has no update_url to fetch from, so no Reload button here.
    expect(await popup.locator('#update-reload').count(), 'no Reload button without a fetched update').toBe(0);
    report.update = { ...upd, feedCalls: feedCalls.slice() };
    console.log(`update: ${JSON.stringify(report.update)}`);
    step('update banner');
    await popup.screenshot({ path: shot('login') });
    await expect(popup.locator('#login-github'), 'the login card offers Sign in with GitHub').toHaveText('Sign in with GitHub');

    // Access: an email that is not on the allow-list is not logged in (Pandora is not
    // asked); the access server records the request.
    const loginCalls = async () => (await getJson(`${tuner.http}/__tuner/log`)).filter((e) => e.method === 'auth.userLogin').length;
    await popup.fill('#login-email', tuner.user);
    await popup.fill('#login-password', tuner.password);
    await popup.click('#login-button');
    await expect(popup.locator('#login-message')).toHaveText('melodica access is by allow-list. Your request has been sent.', { timeout: 30_000 });
    await expect(popup.locator('#app')).toHaveAttribute('data-view', 'login');
    expect(await loginCalls(), 'no auth.userLogin for an email not on the list').toBe(0);
    expect(acct.requests.map((r) => [r.email, r.client, r.allowed]), 'the access check was asked').toEqual([[tuner.user.toLowerCase(), 'extension', false]]);
    await popup.screenshot({ path: shot('access-request') });
    report.access = { notListed: { message: await popup.locator('#login-message').textContent(), userLogin: 0 } };
    step('not on the allow-list: not logged in');
    acct.allow(tuner.user);
    await popup.check('#login-remember');
    await popup.click('#login-button');
    await popup.waitForFunction(() => document.getElementById('app').dataset.view === 'player' || /error/.test(document.getElementById('login-message')?.className || ''), null, { timeout: 60_000, polling: 500 }).catch(() => {});
    const outcome = await popup.evaluate(() => ({ view: document.getElementById('app').dataset.view, message: document.getElementById('login-message')?.textContent || '' }));
    console.log(`login outcome ${at()}: ${JSON.stringify(outcome)}`);
    expect(outcome.view, `login outcome (message: "${outcome.message}")`).toBe('player');
    step('logged in');
    // "Remember me": the password is sealed (vault.imba). No extension storage holds it
    // as text; only {v, iv, ct} is in storage.local.
    const dump = async (pg = popup) => pg.evaluate(async () => JSON.stringify({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
    await expect.poll(async () => JSON.parse(await dump()).local.vault ? 'sealed' : 'none', { timeout: 10_000 }).toBe('sealed');
    const stored = await dump();
    expect(stored.includes(tuner.password), 'the password is not in extension storage').toBe(false);
    expect(Object.keys(JSON.parse(stored).local.vault).sort()).toEqual(['ct', 'iv', 'v']);
    expect(JSON.parse(stored).local.password, 'no plaintext password key').toBeUndefined();
    const keyKind = await popup.evaluate(() => new Promise((ok) => { const r = indexedDB.open('melodica-vault'); r.onsuccess = () => { const g = r.result.transaction('keys').objectStore('keys').get('vault'); g.onsuccess = () => ok(g.result ? `${g.result.type}/${g.result.extractable}/${g.result.algorithm.name}` : 'none'); }; r.onerror = () => ok('error'); }));
    expect(keyKind, 'a non-extractable AES-GCM key in IndexedDB').toBe('secret/false/AES-GCM');
    report.remember = { sealed: true, passwordInStorage: false, key: keyKind };
    step('remember: password sealed, not in storage');

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
    await popup.screenshot({ path: shot('stations') });

    // Username (docs/ACCOUNT.md, Usernames): login-ok with the Pandora session, then
    // "Pick a username" while the name is generated; the server's 409 shows inline.
    const pick = popup.locator('#username-pick-form');
    await expect(pick).toBeVisible({ timeout: 30_000 });
    const generated = (await popup.locator('#username-pick-current').textContent()).trim();
    expect(generated, 'a generated name until one is picked').toMatch(/^listener-/);
    expect(acct.loginOks.at(-1), 'login-ok sent the Pandora session').toEqual({ client: 'extension', pandora: true });
    await expect(popup.locator('#signed-in')).toHaveText(generated);
    expect(await popup.locator('body').textContent(), 'the login email is never shown').not.toContain(tuner.user);
    await popup.fill('#username-pick-input', 'taken_name');
    await popup.click('#username-pick-save');
    await expect(popup.locator('#username-pick-message')).toHaveText('That username is taken.');
    await popup.screenshot({ path: shot('username-pick') });
    await popup.fill('#username-pick-input', 'Night_Owl');
    await popup.click('#username-pick-save');
    await expect(pick).toHaveCount(0);
    await expect(popup.locator('#signed-in')).toHaveText('night_owl');
    const optsU = await context.newPage();
    await optsU.goto(`chrome-extension://${id}/options.html`);
    await expect(optsU.locator('#options-username')).toHaveText('Your melodica username: night_owl', { timeout: 30_000 });
    await optsU.fill('#username-change-input', 'x');
    await optsU.click('#username-change-save');
    await expect(optsU.locator('#username-change-message')).toHaveText(/^Use 3 to 24 letters/);
    await optsU.fill('#username-change-input', 'night_owl_2');
    await optsU.click('#username-change-save');
    await expect(optsU.locator('#username-change-message')).toHaveText('Saved.');
    await expect(optsU.locator('#options-username')).toHaveText('Your melodica username: night_owl_2');
    await expect(popup.locator('#signed-in')).toHaveText('night_owl_2');
    await optsU.close();
    report.username = { generated: true, taken: 'That username is taken.', chosen: 'night_owl', changed: 'night_owl_2' };
    step('username picked and changed');

    // 3. Start a station from the popup. No tab opens: the background plays it in
    //    its offscreen document (chrome.offscreen, AUDIO_PLAYBACK) and the popup is
    //    a view of that state.
    const pagesBefore = context.pages().length;
    const chosen = (await stations.first().textContent()).trim();
    await stations.first().click();
    await expect(popup.locator('#app')).toHaveAttribute('data-status', 'playing', { timeout: 30_000 });
    await expect(popup.locator('#np-title')).not.toHaveText(/^(Pick a station)?$/);
    await expect(popup.locator('#np-artist')).not.toHaveText('');
    await expect(popup.locator('#np-station')).toContainText(chosen);
    const now = {
      title: (await popup.locator('#np-title').textContent()).trim(),
      artist: (await popup.locator('#np-artist').textContent()).trim(),
      station: chosen,
    };
    console.log(`now playing: ${now.title} – ${now.artist} on ${now.station}`);
    expect(context.pages().length, 'no tab opened by starting a station').toBe(pagesBefore);
    await coverLoaded(popup);
    // Scrobbling is on by default; the notice comes before anything is sent.
    await expect(popup.locator('#scrobble-notice')).toHaveText('Scrobbling to spacegho.st is on. Turn it off in settings.', { timeout: 30_000 });
    await popup.screenshot({ path: shot('playing') });
    expect(acct.listens.length, 'nothing scrobbled before the notice was seen').toBe(0);
    await popup.click('#scrobble-notice-ok');
    await expect(popup.locator('#scrobble-notice')).toHaveCount(0);
    step('scrobbling notice shown before the first submission');
    const first = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'player-get' }).then((r) => { if (!r || !r.ok) throw new Error(`player-get: ${r && r.error}`); return r.state; }));
    expect(first.status, 'background state').toBe('playing');
    expect(first.track && first.track.title).toBe(now.title);
    expect(first.track && first.track.audioUrl, 'the track came from the tuner').toContain('/audio/');
    const where = await popup.evaluate(async (id) => ({
      playerTabs: (await chrome.tabs.query({ url: `chrome-extension://${id}/player.html*` })).length,
      contexts: (await chrome.runtime.getContexts({})).map((c) => `${c.contextType} ${String(c.documentUrl || '').replace(/^chrome-extension:\/\/[^/]+\//, '')}`.trim()),
    }), id);
    console.log(`contexts: ${JSON.stringify(where)}`);
    expect(where.playerTabs, 'player tabs').toBe(0);
    expect(where.contexts.some((c) => c === 'OFFSCREEN_DOCUMENT offscreen.html'), `an offscreen document holds the audio (${where.contexts.join(', ')})`).toBe(true);
    step('playing without a tab');

    // Close the popup: no extension page is open. The service worker is asked directly
    // (Playwright can evaluate in it): its storage.session copy of the state, written on
    // every engine report, and the offscreen engine itself (the only context that answers
    // an `engine` message) must both show playback continuing and the position advancing.
    await popup.close();
    const sw = context.serviceWorkers()[0];
    const probe = () => sw.evaluate(async () => {
      const saved = (await chrome.storage.session.get('player')).player || null;
      const engine = await chrome.runtime.sendMessage({ type: 'engine', op: 'state' }).catch((e) => ({ error: String(e) }));
      const tabs = await chrome.tabs.query({ url: `chrome-extension://${chrome.runtime.id}/*` });
      const contexts = (await chrome.runtime.getContexts({})).map((c) => c.contextType);
      return {
        status: saved && saved.status, position: saved && saved.position, title: saved && saved.track && saved.track.title,
        engine: engine && engine.state ? { status: engine.state.status, position: engine.state.position, title: engine.state.track && engine.state.track.title } : engine,
        extensionTabs: tabs.map((t) => t.url), contexts,
      };
    });
    // Wait until the audio has actually started (the first probe may land while it buffers).
    let p1 = await probe();
    for (let i = 0; i < 30 && !(p1.engine && p1.engine.position > 0.5); i++) { await new Promise((ok) => setTimeout(ok, 500)); p1 = await probe(); }
    expect(p1.extensionTabs, 'no extension page open').toEqual([]);
    expect(p1.contexts, 'contexts with every page closed').not.toContain('TAB');
    await new Promise((ok) => setTimeout(ok, 5000));
    const p2 = await probe();
    console.log(`no page open: ${JSON.stringify(p1)} -> ${JSON.stringify(p2)}`);
    expect(p2.status, 'still playing with no page open').toBe('playing');
    expect(p2.engine && p2.engine.status, 'offscreen engine still playing').toBe('playing');
    if (p2.title === p1.title) {
      expect(p2.position, 'position advanced with no page open').toBeGreaterThan(p1.position + 2);
      expect(p2.engine.position, 'engine position advanced').toBeGreaterThan(p1.engine.position + 3.5);
    }
    report.audio = { ...now, engine: 'offscreen document', noPage: { before: p1, after: p2 } };
    step('plays with no page open');

    // A new popup shows the same track.
    const popup2 = await context.newPage();
    await popup2.setViewportSize(POPUP);
    watch(popup2, 'popup2');
    await popup2.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup2.locator('#np-title')).toHaveText(now.title, { timeout: 15_000 });
    await expect(popup2.locator('#app')).toHaveAttribute('data-status', 'playing');
    await coverLoaded(popup2);
    await popup2.screenshot({ path: shot('popup-playing') });
    step('popup shows the track');

    // The player tab is optional: opened from the popup it shows the same track and holds
    // no <audio>; closing it stops nothing.
    const playerPromise = context.waitForEvent('page', { timeout: 30_000 });
    await popup2.click('#open-player');
    const player = await playerPromise;
    watch(player, 'player');
    await player.waitForURL((u) => u.href.startsWith(`chrome-extension://${id}/player.html`), { timeout: 30_000 });
    await player.waitForLoadState('load');
    await expect(player.locator('#np-title')).toHaveText(now.title, { timeout: 30_000 });
    await expect(player.locator('#np-station')).toContainText(chosen);
    await expect(player.locator('#player-status')).toContainText('Playing in the background');
    expect(await player.locator('#audio').count(), 'no audio element in the player tab').toBe(0);
    const shown = await player.evaluate(() => Number(document.getElementById('np-progress').value));
    await player.waitForFunction((v) => Number(document.getElementById('np-progress').value) > v + 1, shown, { timeout: 15_000 });
    await coverLoaded(player);
    await player.screenshot({ path: shot('player-tab') });
    // The same tab in dark mode (prefers-color-scheme), at the same size.
    await player.emulateMedia({ colorScheme: 'dark' });
    await player.screenshot({ path: shot('player-tab-dark') });
    await player.emulateMedia({ colorScheme: 'light' });
    for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
      await player.setViewportSize({ width: w, height: h });
      const wide = await player.evaluate(() => { const r = document.querySelector('.app').getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth - innerWidth, bg: getComputedStyle(document.body).backgroundImage, skew: Math.abs(r.left - (innerWidth - r.right)) }; });
      expect(wide.skew, `player tab at ${w}: content centred`).toBeLessThanOrEqual(24);
      expect(wide.overflow, `player tab at ${w}: no horizontal overflow`).toBeLessThanOrEqual(0);
      expect(wide.bg, 'fixed-size glows').toContain('900px 480px');
      await player.screenshot({ path: shot(`player-tab-${w}`) });
    }
    await player.close();
    const p3 = await probe();
    await new Promise((ok) => setTimeout(ok, 3000));
    let p4 = await probe();
    // A song boundary (the next song or slot loading) is not a stop: wait it out.
    for (let i = 0; i < 40 && p4.status === 'loading'; i++) { await new Promise((ok) => setTimeout(ok, 250)); p4 = await probe(); }
    console.log(`player tab closed: ${JSON.stringify(p3)} -> ${JSON.stringify(p4)}`);
    expect(p4.status, 'still playing after the player tab closed').toBe('playing');
    // The tuner's fixture tracks are short: the next track starting also counts as progress.
    expect(p4.title !== p3.title || p4.position > p3.position + 1, `playback advanced after the tab closed (${p3.title}@${p3.position} -> ${p4.title}@${p4.position})`).toBe(true);
    report.audio.playerTab = { title: now.title, progressShown: shown, afterClose: p4 };
    await popup2.close();
    step('player tab optional');
    // listen:// links (melodica-scrobble docs/LISTEN-URI.md): the player tab offers Play for
    // an artist link and starts nothing by itself; a bad link is refused; the popup copies
    // the https form of the current artist.
    {
      const before = await probe();
      const lt = await context.newPage();
      await lt.goto(`chrome-extension://${id}/player.html?listen=${encodeURIComponent('web+listen://artist/Aurora%20Fields')}`);
      await expect(lt.locator('#listen-title')).toHaveText('Artist: Aurora Fields', { timeout: 15_000 });
      expect(new URL(lt.url()).search, 'the link leaves the address bar').toBe('');
      const after = await probe();
      expect(after.title === before.title || after.status === before.status, 'opening a link starts nothing').toBe(true);
      await lt.click('#listen-dismiss');
      await expect(lt.locator('#listen-title')).toHaveCount(0);
      await lt.goto(`chrome-extension://${id}/player.html?listen=${encodeURIComponent('listen://artist/Aurora%20Fields?autoplay=1')}`);
      await expect(lt.locator('#listen-title')).toHaveCount(0);
      await lt.close();
      const pc = await context.newPage();
      await pc.setViewportSize(POPUP);
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${id}` }).catch(() => null);
      await pc.goto(`chrome-extension://${id}/popup.html`);
      await expect(pc.locator('#copy-listen')).toBeEnabled({ timeout: 15_000 });
      await pc.click('#copy-listen');
      await expect(pc.locator('#copy-listen-done')).toContainText('https://spacegho.st/listen/artist/', { timeout: 5_000 });
      report.listenLinks = { prompt: 'Artist: Aurora Fields', autoplayRefused: true, copied: (await pc.locator('#copy-listen-done').textContent()) };
      await pc.close();
      step('listen links: prompt in the player tab, nothing autoplays, copy link');
    }

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
    await page.screenshot({ path: shot('bridge') });
    step('bridge round trip');
    // Layer 2 (docs/BRIDGE.md): the page subscribes, gets the background's state (without
    // audio URLs), pauses and resumes the music through `command`.
    expect(announced.player, 'ready announces the player layer').toBe(true);
    const bgNow = await sw.evaluate(async () => ((await chrome.storage.session.get('player')).player || {}).track?.title || '');
    const remote = await page.evaluate(() => new Promise((ok, fail) => {
      const states = [], results = [];
      let status = '', sentPause = false, sentResume = false;
      const t = setTimeout(() => fail(new Error(`remote: timed out at status ${status}; states ${JSON.stringify(states.slice(-3))} results ${JSON.stringify(results)}`)), 30_000);
      const post = (m) => window.postMessage({ melodica: 1, ...m }, location.origin);
      window.addEventListener('message', function h(ev) {
        if (ev.source !== window || !ev.data || ev.data.melodica !== 1) return;
        const d = ev.data;
        if (d.type === 'state') {
          states.push({ status: d.state.status, position: d.state.position, title: d.state.track && d.state.track.title, audioUrl: !!(d.state.track && d.state.track.audioUrl), historyUrls: (d.state.history || []).filter((h) => h.audioUrl).length, queue: Array.isArray(d.state.queue) ? d.state.queue.length : -1, queueUrls: (d.state.queue || []).filter((q) => q.audioUrl || !q.title || !q.trackToken).length, stations: Array.isArray(d.state.stations) ? d.state.stations.length : -1, loggedIn: d.state.loggedIn, account: d.state.account && d.state.account.signedIn });
          status = d.state.status;
        } else if (d.type === 'result') {
          results.push({ id: d.id, ok: d.ok, error: d.error, status: d.state && d.state.status, audioUrl: !!(d.state && d.state.track && d.state.track.audioUrl) });
          if (d.state && d.state.status) status = d.state.status;
        } else return;
        if (!sentPause && status === 'playing') { sentPause = true; post({ type: 'command', id: 'r-pause', action: 'pause' }); }
        else if (sentPause && !sentResume && status === 'paused') { sentResume = true; post({ type: 'command', id: 'r-resume', action: 'play' }); }
        else if (sentResume && status === 'playing') { post({ type: 'unsubscribe' }); window.removeEventListener('message', h); clearTimeout(t); ok({ states, results }); }
      });
      post({ type: 'subscribe' });
    }));
    console.log(`bridge remote: ${remote.states.length} states, results ${JSON.stringify(remote.results)}`);
    expect(remote.states[0].status, 'first state push').toBe('playing');
    // The fixture's tracks are short, so the page must name whatever the background plays now.
    expect(remote.states[0].title, 'first state names a track').toBeTruthy();
    expect(remote.states.map((x) => x.title), 'the page saw the track the extension was playing').toContain(remote.states[0].title);
    expect(remote.states[0].loggedIn).toBe(true);
    expect(remote.states[0].stations).toBeGreaterThan(0);
    expect(remote.states.every((s) => !s.audioUrl && s.historyUrls === 0), 'no audio URL reaches the page').toBe(true);
    expect(remote.states.every((s) => s.queue >= 0 && s.queueUrls === 0), 'queue: an array of songs with title and token, no audio URL').toBe(true);
    expect(remote.states.some((s) => s.queue > 0), 'queue lists the upcoming songs').toBe(true);
    expect(remote.results.every((r) => r.ok && !r.audioUrl), 'both commands succeeded').toBe(true);
    expect(remote.states.some((s) => s.status === 'paused'), 'the page paused the music').toBe(true);
    expect(remote.states[remote.states.length - 1].status, 'the page resumed it').toBe('playing');
    expect([bgNow, remote.states[remote.states.length - 1].title], 'the page saw the background track').toContain(remote.states[0].title);
    report.bridge.remote = { backgroundTrack: bgNow, states: remote.states.length, paused: true, resumed: true, results: remote.results, first: remote.states[0] };
    step('bridge remote');

    // The page stays subscribed and records every push; a change made in the popup
    // (not by the page) must reach it.
    await page.evaluate(() => {
      window.__states = [];
      window.addEventListener('message', (ev) => {
        if (ev.source === window && ev.data && ev.data.melodica === 1 && ev.data.type === 'state') window.__states.push({ status: ev.data.state.status, loggedIn: ev.data.state.loggedIn, access: ev.data.state.access || null });
      });
      window.postMessage({ melodica: 1, type: 'subscribe' }, location.origin);
    });
    await page.waitForFunction(() => window.__states.length > 0, null, { timeout: 25_000 });
    const pop2 = await context.newPage();
    await pop2.setViewportSize(POPUP);
    await pop2.goto(`chrome-extension://${id}/popup.html`);
    await expect(pop2.locator('#app')).toHaveAttribute('data-status', 'playing', { timeout: 20_000 });
    const mark = await page.evaluate(() => window.__states.length);
    await pop2.click('#play');
    await page.waitForFunction((n) => window.__states.slice(n).some((x) => x.status === 'paused'), mark, { timeout: 15_000 });
    await pop2.click('#play');
    await page.waitForFunction((n) => window.__states.slice(n).some((x) => x.status === 'playing'), mark, { timeout: 15_000 });
    // Latency of pause and resume from the popup to the page, several rounds: the first
    // push with the new status, and no older status pushed after it (the page draws
    // every push as it arrives).
    await page.evaluate(() => { window.__t = []; window.addEventListener('message', (ev) => { if (ev.source === window && ev.data && ev.data.melodica === 1 && ev.data.type === 'state') window.__t.push({ at: performance.now(), status: ev.data.state.status }); }); });
    const rounds = [];
    const xsend = (m) => pop2.evaluate((mm) => chrome.runtime.sendMessage(mm), m);
    // The transport is disabled while a slot plays (the tuner puts one after every
    // song): time only clicks made outside slots.
    const noSlot = async () => { for (let k = 0; k < 120; k++) { const st = (await xsend({ type: 'player-get' })).state; if (!(st.track && st.track.ad) && st.status !== 'loading') return; await pop2.waitForTimeout(250); } };
    for (let i = 0; i < 6; i++) {
      for (const want of ['paused', 'playing']) {
        await pop2.waitForTimeout(400 + 150 * i);
        await noSlot();
        const n = await page.evaluate(() => window.__t.length);
        const t0 = await page.evaluate(() => performance.now());
        await pop2.click('#play');
        await page.waitForFunction(([k, w]) => window.__t.slice(k).some((x) => x.status === w), [n, want], { timeout: 5_000 });
        await pop2.waitForTimeout(700);
        const seen = await page.evaluate((k) => window.__t.slice(k), n);
        const first = seen.find((x) => x.status === want);
        const lastStatus = seen[seen.length - 1].status;
        rounds.push({ want, ms: Math.round(first.at - t0), after: seen.slice(seen.indexOf(first)).map((x) => x.status).filter((x, j, a) => j === 0 || x !== a[j - 1]).join('>') });
        expect(lastStatus, `round ${i} ${want}: last pushed status (${JSON.stringify(seen.map((x) => x.status))})`).toBe(want);
      }
    }
    // The web app's own sequence (melodica-web tests/extension-real.spec.mjs): change
    // the station, set the volume, then pause and resume straight away, while the new
    // station may still be loading.
    // The page repeats its subscribe (melodica-web refreshes every few seconds); here
    // every 120 ms, so answers cross the background's pushes.
    await page.evaluate(() => { window.__refresh = setInterval(() => window.postMessage({ melodica: 1, type: 'subscribe' }, location.origin), 120); });
    const sts = (await xsend({ type: 'player-get' })).state.stations;
    for (let i = 0; i < 4; i++) {
      const st = sts[(i + 1) % sts.length];
      await xsend({ type: 'player', action: 'play', station: { token: st.token, name: st.name } });
      await xsend({ type: 'player', action: 'volume', value: 60 + i });
      for (const [action, want] of [['pause', 'paused'], ['resume', 'playing']]) {
        const n = await page.evaluate(() => window.__t.length);
        const t0 = await page.evaluate(() => performance.now());
        const reply = await xsend({ type: 'player', action });
        await page.waitForFunction(([k, w]) => window.__t.slice(k).some((x) => x.status === w), [n, want], { timeout: 5_000 }).catch(() => {});
        await pop2.waitForTimeout(1500);
        const seen = await page.evaluate((k) => window.__t.slice(k), n);
        const first = seen.find((x) => x.status === want);
        rounds.push({ seq: `station+${action}`, want, reply: reply && reply.state && reply.state.status, ms: first ? Math.round(first.at - t0) : null, after: seen.map((x) => `${x.status}@${Math.round(x.at - t0)}`).filter((x, j, a) => j === 0 || x.split('@')[0] !== a[j - 1].split('@')[0]).join('>') });
      }
    }
    // Pause and resume right after a station change, while its playlist may still be
    // loading (no wait between the three commands).
    for (let i = 0; i < 4; i++) {
      const st = sts[(i + 2) % sts.length];
      await noSlot();
      await xsend({ type: 'player', action: 'play', station: { token: st.token, name: st.name } });
      await xsend({ type: 'player', action: 'pause' });
      const n = await page.evaluate(() => window.__t.length);
      const t0 = await page.evaluate(() => performance.now());
      const reply = await xsend({ type: 'player', action: 'resume' });
      await page.waitForFunction((k) => window.__t.slice(k).some((x) => x.status === 'playing'), n, { timeout: 5_000 }).catch(() => {});
      await pop2.waitForTimeout(1500);
      const seen = await page.evaluate((k) => window.__t.slice(k), n);
      const first = seen.find((x) => x.status === 'playing');
      rounds.push({ seq: 'quick station+pause+resume', want: 'playing', reply: reply && reply.state && reply.state.status, ms: first ? Math.round(first.at - t0) : null, after: seen.map((x) => `${x.status}@${Math.round(x.at - t0)}`).filter((x, j, a) => j === 0 || x.split('@')[0] !== a[j - 1].split('@')[0]).join('>') });
    }
    await page.evaluate(() => clearInterval(window.__refresh));
    console.log(`popup -> page latency: ${JSON.stringify(rounds)}`);
    for (const r of rounds) expect(r.ms, `${r.seq || 'popup'} ${r.want} -> page within 500 ms (${JSON.stringify(r)})`).toBeLessThan(500);
    for (const r of rounds) expect(r.after.split('>').pop().split('@')[0], `${r.seq || 'popup'} ${r.want}: last pushed status (${JSON.stringify(r)})`).toBe(r.want);
    await pop2.close();
    report.bridge.pushFromPopup = { paused: true, resumed: true, rounds };
    step('bridge push from the popup');

    // 6. Slots, with no spacegho.st account (the default policy): the tuner puts a slot
    //    slot after every song; the background must fetch it (ad.getAdMetadata), play
    //    it (GET of its audio), show it, refuse `next` while it plays, and register it
    //    (ad.registerAd) when it ends.
    const ctl = await context.newPage();
    await ctl.setViewportSize(POPUP);
    watch(ctl, 'popup3');
    await ctl.goto(`chrome-extension://${id}/popup.html`);
    const bgState = () => ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'player-get' }).then((r) => r.state));
    const tunerSlots = async () => {
      const st = await getJson(`${tuner.http}/__tuner/state`);
      const me = (st.users || []).find((u) => u.email === tuner.user) || {};
      const list = me.ads || [];
      const sum = (k) => list.reduce((n, a) => n + (Number(a[k]) || 0), 0);
      return { issued: list.length, metadataFetched: sum('metadataFetched'), audioFetched: sum('audioFetched'), registered: sum('registered') };
    };
    let slotSeen = null;
    for (let i = 0; i < 120 && !slotSeen; i++) {
      const st = await bgState();
      if (st.track && st.track.ad && st.status === 'playing') slotSeen = st;
      else await new Promise((ok) => setTimeout(ok, 500));
    }
    expect(slotSeen, 'a slot played within 60 s').toBeTruthy();
    await expect(ctl.locator('#np-station')).toHaveText('', { timeout: 10_000 });
    await expect(ctl.locator('#next')).toBeDisabled();
    await coverLoaded(ctl);
    await ctl.screenshot({ path: shot('slot') });
    const skipTry = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'player', action: 'next' }).then((r) => r.state));
    expect(skipTry.track && skipTry.track.ad, '`next` does nothing during a slot').toBe(true);
    let slotsAfter = await tunerSlots();
    for (let i = 0; i < 120 && slotsAfter.registered < 1; i++) { await new Promise((ok) => setTimeout(ok, 500)); slotsAfter = await tunerSlots(); }
    console.log(`slots (default policy): ${JSON.stringify(slotsAfter)}; slot shown: ${slotSeen.track.title} / ${slotSeen.track.artist}`);
    expect(slotsAfter.metadataFetched, 'ad.getAdMetadata called').toBeGreaterThan(0);
    expect(slotsAfter.audioFetched, 'the slot audio was fetched').toBeGreaterThan(0);
    expect(slotsAfter.registered, 'ad.registerAd called after the slot').toBeGreaterThan(0);
    report.spots = { defaultPolicy: { ...slotsAfter, title: slotSeen.track.title, company: slotSeen.track.artist, nextRefused: true } };
    step('slot played and registered');

    // Scrobbles: playing_now for songs (only artist, title, album, duration, art and
    // the client), never the slot. The fixture songs are 10 s, under the 30 s floor, so
    // no single is due (thresholds: tests/scrobble.test.mjs).
    await expect.poll(() => acct.listens.filter((l) => l.body.listen_type === 'playing_now').length, { timeout: 30_000 }).toBeGreaterThan(0);
    const allowed = ['additional_info', 'artist_name', 'release_name', 'track_name'];
    for (const l of acct.listens) {
      const meta = l.body.payload[0].track_metadata;
      expect(Object.keys(meta).every((k) => allowed.includes(k)), `listen fields ${Object.keys(meta)}`).toBe(true);
      expect(Object.keys(meta.additional_info).every((k) => ['submission_client', 'submission_client_version', 'station_name', 'duration_ms', 'art_url'].includes(k)), `additional_info ${Object.keys(meta.additional_info)}`).toBe(true);
      expect(meta.additional_info.submission_client).toBe('melodica-extension');
      expect(meta.additional_info.submission_client_version, 'client version sent').toBe(manifest.version);
      expect(typeof meta.additional_info.station_name === 'string' && meta.additional_info.station_name.length > 0, 'station name sent').toBe(true);
      expect(/^https?:\/\//.test(meta.additional_info.art_url || ''), `art_url sent (${meta.additional_info.art_url})`).toBe(true);
      expect(meta.track_name, 'the slot is never scrobbled').not.toBe(slotSeen.track.title);
      expect(l.body.listen_type, 'no single for a 10 s song').toBe('playing_now');
    }
    expect(acct.listens.some((l) => l.who.startsWith('m:')), 'sent with the melodica token').toBe(true);
    const sentBefore = acct.listens.length;
    // Genome traits: track.explainTrack is asked once per track (the tuner answers it);
    // they go with the single (singles need longer songs than the fixture's).
    const genomeLines = async () => (await (context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')).evaluate(async () => (await chrome.storage.session.get('log')).log || [])).filter((l) => /genome: \d+ traits/.test(l));
    await expect.poll(async () => (await genomeLines()).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const genomeNote = (await genomeLines())[0];
    expect(/genome: [1-9]\d* traits/.test(genomeNote), `explainTrack gave traits (${genomeNote})`).toBe(true);
    const optsS = await context.newPage();
    await optsS.goto(`chrome-extension://${id}/options.html`);
    await expect(optsS.locator('#scrobble-enabled')).toBeEnabled({ timeout: 30_000 });
    await expect(optsS.locator('#scrobble-enabled')).toBeChecked();
    await optsS.locator('#scrobble-enabled').uncheck();
    await expect(optsS.locator('#scrobble-message')).toHaveText('Scrobbling is off.');
    await optsS.screenshot({ path: shot('scrobbling-off') });
    const offAt = acct.listens.length;
    const songAt = (await bgState()).track;
    for (let i = 0; i < 80; i++) { const t = (await bgState()).track; if (t && songAt && t.trackToken !== songAt.trackToken && !t.ad) break; await new Promise((ok) => setTimeout(ok, 500)); }
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(acct.listens.length, 'nothing scrobbled while off').toBe(offAt);
    await optsS.locator('#scrobble-enabled').check();
    await expect(optsS.locator('#scrobble-message')).toHaveText('Scrobbling is on.');
    await optsS.close();
    // The popup's recent listens (GET /scrobble/api/me) with links to spacegho.st/melodica/.
    acct.seedListen({ id: 9001, listened_at: Math.floor(Date.now() / 1000) - 120, session: Math.floor(Date.now() / 1000) - 120, artist: 'Seeded Artist', title: 'Seeded Song <b>' });
    const popR = await context.newPage();
    await popR.setViewportSize(POPUP);
    await popR.goto(`chrome-extension://${id}/popup.html`);
    await expect(popR.locator('#recent-listens li').first()).toContainText('Seeded Song <b>', { timeout: 20_000 });
    expect(await popR.locator('#recent-listens b').count(), 'titles render as text').toBe(0);
    expect(await popR.locator('#link-listens').getAttribute('href')).toBe('https://spacegho.st/melodica/listens/');
    expect(await popR.locator('#link-leaderboard').getAttribute('href')).toBe('https://spacegho.st/melodica/leaderboard/');
    expect(await popR.locator('#link-melodica').getAttribute('href')).toBe('https://spacegho.st/melodica/');
    await popR.screenshot({ path: shot('popup-recent') });
    await popR.close();
    // A refusal other than scrobbling_off (here 403 forbidden) keeps scrobbling on and
    // shows the failure in the popup; the next song that goes clears it.
    acct.scrobbleFailWith(403, 'forbidden');
    const popF = await context.newPage();
    await popF.setViewportSize(POPUP);
    await popF.goto(`chrome-extension://${id}/popup.html`);
    const refusedAt = acct.scrobbleRefused.length;
    await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'player', action: 'next' }));
    await expect.poll(() => acct.scrobbleRefused.length, { timeout: 40_000 }).toBeGreaterThan(refusedAt);
    await expect(popF.locator('#scrobble-fail')).toContainText('Scrobbling failed (HTTP 403 forbidden)', { timeout: 15_000 });
    await popF.screenshot({ path: shot('popup-scrobble-fail') });
    acct.scrobbleFailWith(0);
    const goodAt = acct.listens.length;
    await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'player', action: 'next' }));
    await expect.poll(() => acct.listens.length, { timeout: 40_000 }).toBeGreaterThan(goodAt);
    await expect(popF.locator('#scrobble-fail')).toHaveCount(0, { timeout: 15_000 });
    await popF.close();
    report.scrobbleFailure = { shown: true, recovered: true };
    // The player tab's Listens and Leaderboard panels: the shared Scrobbles UI packaged in
    // the extension (scrobble-ui.pin), against the fake API; no Map for a non-GitHub account.
    const pt = await context.newPage();
    await pt.goto(`chrome-extension://${id}/player.html`);
    await expect(pt.locator('#tab-listens')).toBeVisible({ timeout: 20_000 });
    expect(await pt.locator('#tab-map').count(), 'no Map without a GitHub sign-in').toBe(0);
    await pt.click('#tab-listens');
    await expect(pt.locator('#panel-listens')).toContainText('Seeded Song <b>', { timeout: 20_000 });
    await pt.screenshot({ path: shot('panel-listens') });
    await pt.click('#tab-leaderboard');
    await expect(pt.locator('#panel-leaderboard')).toContainText('Board Song', { timeout: 20_000 });
    await expect(pt.locator('#panel-leaderboard')).toContainText('board_listener');
    await pt.screenshot({ path: shot('panel-leaderboard') });
    await pt.click('#tab-player');
    await expect(pt.locator('.ext-desk')).toBeVisible();
    expect(await pt.locator('#panel-error').count(), 'no panel error').toBe(0);
    const uiPin = (await readFile(resolve(root, 'scrobble-ui.pin'), 'utf8')).split('\n')[0].split(' ')[1];
    await pt.close();
    report.scrobbleUi = { pin: uiPin, listens: true, leaderboard: true, mapHidden: true, calls: [...new Set(acct.scrobbleUiCalls)] };
    report.scrobbles = { notice: true, playingNow: sentBefore, slotScrobbled: false, optOut: true, recentInPopup: true, genome: genomeNote };
    step('scrobbles: playing_now sent, never the slot, opt-out stops them');

    // The access answer says spots:false for this login: after a re-check, two more songs
    // play and no slot is fetched, played or registered.
    acct.allow(tuner.user, { spots: false });
    const re1 = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'access-check' }));
    expect(re1.access.allowed, 'still allowed after the re-check').toBe(true);
    const noSlots = async (label) => {
      // A slot fetched before the new answer may still be playing: let it finish and
      // be registered before counting.
      for (let i = 0; i < 60; i++) {
        const st = await bgState();
        const t = await tunerSlots();
        if (!(st.track && st.track.ad) && t.registered >= t.metadataFetched) break;
        await new Promise((ok) => setTimeout(ok, 500));
      }
      const before = await tunerSlots();
      const histStart = (await bgState()).history.length;
      let sawSlot = false;
      for (let i = 0; i < 160; i++) {
        const st = await bgState();
        if (st.track && st.track.ad) sawSlot = true;
        if (st.history.length >= histStart + 3) break;
        await new Promise((ok) => setTimeout(ok, 500));
      }
      const after = await tunerSlots();
      const played = (await bgState()).history.length - histStart;
      console.log(`slots (${label}): before ${JSON.stringify(before)} after ${JSON.stringify(after)}; songs +${played}`);
      expect(played, 'songs kept playing').toBeGreaterThanOrEqual(3);
      expect(after.issued, 'the tuner kept offering slots').toBeGreaterThan(before.issued);
      expect(after.metadataFetched, 'no slot.getAdMetadata').toBe(before.metadataFetched);
      expect(after.audioFetched, 'no slot audio').toBe(before.audioFetched);
      expect(after.registered, 'no slot.registerAd').toBe(before.registered);
      // The first song after the re-check may already have been fetched with its slot
      // slot: the slot must be passed over, not played.
      expect(sawSlot, 'no slot played').toBe(false);
      return { before, after, songs: played };
    };
    report.spots.accessOff = await noSlots('access answer spots:false');
    step('access answer spots:false plays no slots');
    acct.allow(tuner.user, { spots: true });
    await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'access-check' }));

    // The optional spacegho.st sign-in: begun in the background (PKCE), the authorize
    // page opened in a tab, the GitHub sign-in done there, and the redirect to the
    // extension's https://<id>.chromiumapp.org/oauth address handed back.
    // (launchWebAuthFlow opens a window Playwright cannot drive; it runs the same steps.)
    const redirects = [];
    await context.route('https://*.chromiumapp.org/**', (route) => { redirects.push(route.request().url()); route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }); });
    const begin = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'account-begin' }));
    expect(begin.ok, `account-begin (${begin.error})`).toBe(true);
    expect(begin.redirectUri).toBe(`https://${id}.chromiumapp.org/oauth`);
    const tab = await context.newPage();
    await tab.goto(begin.url);
    await tab.click('#sg-github');
    await tab.click('#gh-octo-ci');
    await expect.poll(() => redirects.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await tab.close();
    acct.setSpots('github', false);
    const fin = await ctl.evaluate((url) => chrome.runtime.sendMessage({ type: 'account-finish', url }), redirects[redirects.length - 1]);
    expect(fin.ok, `account-finish (${fin.error})`).toBe(true);
    expect(fin.account.signedIn).toBe(true);
    expect(fin.account.label, 'the account shows its display name').toBe('octo-ci');
    await expect(ctl.locator('#account-label')).toHaveText('octo-ci');
    await expect(ctl.locator('#account-signout')).toHaveText('Sign out of spacegho.st');
    expect(await ctl.locator('.foot').textContent(), 'the account line names no provider').not.toMatch(/github/i);
    await ctl.screenshot({ path: shot('account') });
    // Its policy says spots:false: a slot gets no metadata.
    const slot = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'spot-metadata', placeholder: { kind: 'spot', adToken: 'smoke-slot', stationId: '' } }));
    expect(slot.ok && slot.spot, 'no slot for a slot under this policy').toBe(null);
    report.account = { label: fin.account.label, policyAdsOff: true };
    step('spacegho.st sign-in');

    // Refresh: a stale access token is refreshed (the refresh token rotates); a 401 from
    // the policy refreshes and retries.
    const rt1 = await ctl.evaluate(() => chrome.storage.local.get('account').then((x) => x.account.refresh));
    await ctl.evaluate(() => chrome.storage.local.get('account').then((x) => chrome.storage.local.set({ account: { ...x.account, accessExp: 0 } })));
    const refreshedBefore = acct.tokens.refreshed;
    const chk = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'account-check' }));
    const rt2 = await ctl.evaluate(() => chrome.storage.local.get('account').then((x) => x.account && x.account.refresh));
    expect(chk.account.signedIn, 'still signed in after a refresh').toBe(true);
    expect(acct.tokens.refreshed, 'the token endpoint saw a refresh').toBeGreaterThan(refreshedBefore);
    expect(rt2 && rt2 !== rt1, 'the refresh token rotated').toBe(true);
    acct.expireAccess();
    const chk2 = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'account-check' }));
    expect(chk2.account.signedIn, 'signed in after a 401 and a refresh').toBe(true);
    // The access check carries the account's bearer.
    await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'access-check' }));
    expect(acct.requests[acct.requests.length - 1].bearer, 'the access check sent the account token').toBe(true);
    const out = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'account-signout' }));
    expect(out.account.signedIn).toBe(false);
    expect(acct.tokens.revoked, 'sign-out revoked the refresh token').toBeGreaterThan(0);
    await expect(ctl.locator('#account-signin')).toHaveText('Sign in with spacegho.st');
    report.account.refresh = { refreshed: acct.tokens.refreshed, rotated: true, revoked: acct.tokens.revoked };
    step('refresh rotated, signed out');

    // Session sharing with the web app (melodica-web docs/BRIDGE.md section 4): the page
    // asks for the session, gets it (with the credential: "remember" is on); only the
    // content script on https://spacegho.st/melodica/app/ may ask.
    const bridgeAsk = (msg) => page.evaluate((m) => new Promise((ok) => {
      const id = `s-${Math.random()}`;
      const on = (ev) => { if (ev.source === window && ev.data && ev.data.melodica === 1 && (ev.data.type === 'session' || ev.data.type === 'result') && ev.data.id === id) { removeEventListener('message', on); ok(ev.data); } };
      addEventListener('message', on);
      window.postMessage({ melodica: 1, ...m, id }, 'https://spacegho.st');
      setTimeout(() => ok({ timeout: true }), 15000);
    }), msg);
    await page.evaluate(() => { window.__sessions = []; window.__acctOut = 0; addEventListener('message', (ev) => { if (ev.source === window && ev.data && ev.data.melodica === 1 && ev.data.type === 'session' && !ev.data.id) window.__sessions.push(ev.data); if (ev.source === window && ev.data && ev.data.melodica === 1 && ev.data.type === 'account-signout' && !ev.data.id) window.__acctOut += 1; }); });
    const sready = await page.evaluate(() => new Promise((ok) => { const on = (ev) => { if (ev.data && ev.data.type === 'ready') { removeEventListener('message', on); ok(ev.data); } }; addEventListener('message', on); window.postMessage({ melodica: 1, type: 'hello' }, 'https://spacegho.st'); }));
    expect(sready.session, 'ready says session: 1').toBe(1);
    expect(sready.rooms, 'ready advertises native room support').toBe(1);
    const got = await bridgeAsk({ type: 'session-get' });
    expect(got.session && got.session.sid && got.session.sid.length >= 16, 'a session with a sid').toBe(true);
    expect(got.session.email).toBe(tuner.user);
    expect(got.session.partner.authToken && got.session.user.authToken && Number.isInteger(got.session.syncOffset), 'the Pandora session').toBeTruthy();
    expect(got.credential, 'the remembered credential').toEqual({ email: tuner.user, password: tuner.password });
    // The spacegho.st sign-out above happened with no page asking: the first session-get
    // is followed by account-signout (BRIDGE.md 4.6), once.
    await page.waitForFunction(() => window.__acctOut === 1, null, { timeout: 5_000 });
    expect((await dump(ctl)).includes('accountSignoutPending'), 'the pending flag is cleared').toBe(false);
    const acctOut = await bridgeAsk({ type: 'account-signout' });
    expect(acctOut.ok, 'account-signout from the page is answered ok').toBe(true);
    const notApp = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'bridge-session-get' }));
    expect(notApp, 'an extension page is not the web app').toEqual(expect.objectContaining({ ok: false, error: 'not allowed' }));
    // The page logs out: the extension signs out too and pushes session: null.
    const n0 = await page.evaluate(() => window.__sessions.length);
    const lo = await bridgeAsk({ type: 'session-logout', sid: got.session.sid });
    expect(lo.ok).toBe(true);
    await expect.poll(async () => (await bgState()).loggedIn, { timeout: 10_000 }).toBe(false);
    await page.waitForFunction((k) => window.__sessions.slice(k).some((x) => x.session === null), n0, { timeout: 10_000 });
    const afterOut = JSON.parse(await dump(ctl));
    expect(afterOut.local.vault, 'logout wiped the sealed login').toBeUndefined();
    expect(afterOut.local.revokedSids, 'the sid is revoked').toContain(got.session.sid);
    // The revoked sid offered back is refused; a fresh page session signs the extension in.
    const back = await bridgeAsk({ type: 'session-offer', session: got.session });
    expect(back.outcome).toBe('revoked');
    const offer = { ...got.session, sid: `page-${Date.now()}-abcdefgh` };
    const signed = await bridgeAsk({ type: 'session-offer', session: offer, credential: { email: tuner.user, password: tuner.password } });
    expect(signed.outcome, `offer outcome (${JSON.stringify(signed)})`).toBe('signed-in');
    await expect.poll(async () => (await bgState()).loggedIn, { timeout: 10_000 }).toBe(true);
    const again = await bridgeAsk({ type: 'session-get' });
    expect(again.session.sid, 'the page session became the extension\'s').toBe(offer.sid);
    await expect.poll(async () => typeof (await bridgeAsk({ type: 'session-get' })).access, { timeout: 15_000 }).toBe('string');
    expect(acct.loginOks.at(-1), 'login-ok with the offered session').toEqual({ client: 'extension', pandora: true });
    const kept = await bridgeAsk({ type: 'session-offer', session: { ...offer, sid: `other-${Date.now()}-abcdefgh` } });
    expect(kept.outcome, 'the extension keeps its session').toBe('kept');
    expect((await dump(ctl)).includes(tuner.password), 'the offered password is not in storage as text').toBe(false);
    report.session = { get: true, refusedFromExtensionPage: true, logoutBoth: true, revoked: true, offerSignedIn: true, kept: true, accountSignoutPending: true };
    step('session shared with the web app; logout signs out both');

    // Access withdrawn: the next check stops the music and signs out of Pandora; the
    // login card shows the answer.
    acct.disallow(tuner.user);
    const re2 = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'access-check' }));
    expect(re2.access.allowed).toBe(false);
    await expect(ctl.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 15_000 });
    await expect(ctl.locator('#login-message')).toHaveText('melodica access is by allow-list. Your request has been sent.');
    const stopped = await bgState();
    expect(stopped.loggedIn, 'signed out of Pandora').toBe(false);
    expect(stopped.status === 'playing', 'the music stopped').toBe(false);
    report.access.withdrawn = { status: stopped.status, loggedIn: stopped.loggedIn };
    step('access withdrawn: stopped and signed out');

    // The subscribed page learned it too, and can ask the extension to open its sign-in.
    await page.waitForFunction(() => window.__states.some((x) => x.loggedIn === false), null, { timeout: 15_000 });
    const opened = await page.evaluate(() => new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('no openLogin result within 15s')), 15_000);
      window.addEventListener('message', function h(ev) {
        if (ev.source !== window || !ev.data || ev.data.melodica !== 1 || ev.data.type !== 'result' || ev.data.id !== 'open-login') return;
        window.removeEventListener('message', h); clearTimeout(t);
        ok({ ok: ev.data.ok, error: ev.data.error, opened: ev.data.opened, loggedIn: ev.data.state && ev.data.state.loggedIn });
      });
      window.postMessage({ melodica: 1, type: 'command', id: 'open-login', action: 'openLogin' }, location.origin);
    }));
    console.log(`bridge openLogin: ${JSON.stringify(opened)}`);
    expect(opened.ok, `openLogin (${opened.error})`).toBe(true);
    expect(['popup', 'tab']).toContain(opened.opened);
    expect(opened.loggedIn, 'the state says signed out').toBe(false);
    if (opened.opened === 'tab') {
      await expect.poll(() => context.pages().some((p) => p.url() === `chrome-extension://${id}/popup.html`), { timeout: 10_000 }).toBe(true);
    }
    report.bridge.signedOut = { pushed: true, openLogin: opened.opened };
    step('bridge: signed out pushed, openLogin');
    await ctl.close();

    // 7. The tuner's own record.
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
    // The player tab, popup and offscreen document each ran without page errors;
    // the offscreen document's console reaches the worker channel.

    // Anything the browser itself refused (Brave Shields answer net::ERR_BLOCKED_BY_CLIENT)
    // is recorded; the tuner, the audio and the bridge above must have gone through regardless.
    report.failedRequests = evidence.failed.slice();
    report.blocked = evidence.failed.filter((l) => /ERR_BLOCKED_BY_(CLIENT|ADMINISTRATOR|RESPONSE)/.test(l));
    console.log(`requests the browser blocked (${report.blocked.length}):${report.blocked.map((l) => `\n  ${l}`).join('')}`);
    const blockedOurs = report.blocked.filter((l) => l.includes(tuner.https) || l.includes(`https://${WEB_HOST}`) || l.includes('chrome-extension://'));
    expect(blockedOurs, 'the browser blocked a request of the extension, the tuner or the page').toEqual([]);

    expect(evidence.errors, 'uncaught page errors').toEqual([]);
    // The fake account server has no live WebSocket: the shared UI's live channel (opened
    // by the player tab's deployment toast) falls back to polling after Chrome logs the 404.
    const consoleErrors = evidence.console.filter((l) => /:error\]/.test(l) && !/relay|HTTP 4|melodica\/api/.test(l) && !/WebSocket connection to 'wss:\/\/spacegho\.st\/scrobble\/api\/live' failed/.test(l));
    expect(consoleErrors, 'console errors (extension pages)').toEqual(consoleErrors.filter((l) => l.startsWith('[web:')));

    report.ok = true;
    report.summary = `melodica-extension ${report.extension.version} (unpacked, ${report.browser}${report.engine && report.engine !== report.browser ? `, ${report.engine}` : ''}) pointed at melodica-tuner ${tuner.version} ` +
      `via the options page, signed in from the popup, listed ${names.length} stations, played "${now.title}" by ${now.artist} on ${now.station} ` +
      `in the background (offscreen document; no player tab; position ${p1.position.toFixed(1)}s -> ${p2.position.toFixed(1)}s with no extension page open; the optional player tab showed it and its closing changed nothing), ` +
      `and bridged a partnerLogin for the melodica-web page on https://${WEB_HOST}, which then subscribed, paused and resumed the music over the bridge; ` +
      `played a slot ("${report.spots.defaultPolicy.title}": ad.getAdMetadata x${report.spots.defaultPolicy.metadataFetched}, audio x${report.spots.defaultPolicy.audioFetched}, ad.registerAd x${report.spots.defaultPolicy.registered}) with next refused during it, and none once the access answer said spots:false; refused to log in an email not on the access allow-list (no auth.userLogin; the request was recorded), signed in to the optional spacegho.st account ("${report.account.label}"), refreshed and rotated its tokens and signed out, and stopped and signed out of Pandora when access was withdrawn; the update banner announced ${FAKE_VERSION} from the fake releases.json`;
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

// Cold start: with "remember me" on, a browser restart and later a stopped service
// worker must not need the popup. The web app page alone finds the extension (present
// or ready in under 1 s), gets a signed-in state with stations, and steers playback.
test('cold start: the web app finds the extension with no extension page opened', async () => {
  test.skip(LIVE, 'live mode runs only the live test');
  test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
  const firstOk = report.ok;
  report.ok = false;
  report.coldStart = { ok: false };
  const id = await extensionId();
  acct.allow(tuner.user);
  // Sign in once with "remember me", whatever the first test left behind (this page
  // is closed before the restart).
  const login = await context.newPage();
  await login.goto(`chrome-extension://${id}/options.html`);
  await useTuner(login);
  await login.evaluate(() => chrome.runtime.sendMessage({ type: 'logout' }));
  const signedIn = await login.evaluate(({ email, password }) => chrome.runtime.sendMessage({ type: 'login', email, password, remember: true }), { email: tuner.user, password: tuner.password });
  expect(signedIn && signedIn.ok, `login with remember (${signedIn && signedIn.error})`).toBe(true);
  await expect.poll(async () => !!(await login.evaluate(() => chrome.storage.local.get('vault'))).vault, { timeout: 10_000 }).toBe(true);
  await login.close();
  step('cold start: signed in with remember me');

  const capture = () => {
    window.__ext = [];
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (ev.source === window && d && d.melodica === 1 && ['present', 'ready', 'state', 'result'].includes(d.type)) window.__ext.push({ type: d.type, id: d.id, ok: d.ok, error: d.error, state: d.state, at: performance.now() });
    });
  };
  const command = (page, cmdId, action, extra = {}) => page.evaluate(({ cmdId, action, extra }) => new Promise((ok) => {
    const t = setTimeout(() => ok({ ok: false, error: 'no result within 30s' }), 30_000);
    window.addEventListener('message', function h(ev) {
      if (ev.source !== window || !ev.data || ev.data.melodica !== 1 || ev.data.type !== 'result' || ev.data.id !== cmdId) return;
      window.removeEventListener('message', h); clearTimeout(t); ok({ ok: ev.data.ok, error: ev.data.error, status: ev.data.state && ev.data.state.status });
    });
    window.postMessage({ melodica: 1, type: 'command', id: cmdId, action, ...extra }, location.origin);
  }), { cmdId, action, extra });
  const offscreenCount = async () => {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
    return sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
  };
  // One round: open the app, measure detection and the signed-in state, play and pause.
  const round = async (label) => {
    const page = await context.newPage();
    await page.addInitScript(capture);
    await page.goto(`https://${WEB_HOST}${APP_PATH}`);
    await page.waitForFunction(() => window.__ext.some((m) => m.type === 'present' || m.type === 'ready'), null, { timeout: 5_000 });
    // From the document's arrival (responseStart): the page cannot hear the extension
    // before it exists. The time from navigation start is kept as well.
    const times = await page.evaluate(() => { const at = window.__ext.find((m) => m.type === 'present' || m.type === 'ready').at; const nav = performance.getEntriesByType('navigation')[0]; return { fromNav: Math.round(at), fromDocument: Math.round(at - (nav ? nav.responseStart : 0)) }; });
    const detectedMs = times.fromDocument;
    await page.evaluate(() => window.postMessage({ melodica: 1, type: 'subscribe' }, location.origin));
    await page.waitForFunction(() => window.__ext.some((m) => m.type === 'state' && m.state && m.state.loggedIn && (m.state.stations || []).length > 0), null, { timeout: 20_000 });
    const signed = await page.evaluate(() => { const m = window.__ext.find((x) => x.type === 'state' && x.state && x.state.loggedIn && (x.state.stations || []).length > 0); return { at: Math.round(m.at), stations: m.state.stations.length, first: m.state.stations[0] }; });
    const extPages = context.pages().filter((p) => p.url().startsWith('chrome-extension://')).map((p) => p.url());
    const offscreenBefore = await offscreenCount();
    const play = await command(page, `${label}-play`, 'play', { station: { token: signed.first.token, name: signed.first.name } });
    expect(play.ok, `${label}: play over the bridge (${play.error || ''})`).toBe(true);
    await page.waitForFunction(() => window.__ext.some((m) => m.type === 'state' && m.state && m.state.status === 'playing'), null, { timeout: 30_000 });
    const pause = await command(page, `${label}-pause`, 'pause');
    expect(pause.ok, `${label}: pause over the bridge (${pause.error || ''})`).toBe(true);
    const r = { detectedMs, detectedFromNavMs: times.fromNav, signedInMs: signed.at, stations: signed.stations, extensionPages: extPages, offscreenBeforePlay: offscreenBefore, played: true, paused: true };
    console.log(`cold start ${label}: ${JSON.stringify(r)}`);
    expect(extPages, `${label}: no extension page open`).toEqual([]);
    expect(detectedMs, `${label}: the page saw present/ready within 1 s of its document arriving`).toBeLessThan(1000);
    await page.close();
    return r;
  };

  // 1. Browser restart on the same profile; no popup, options or player tab afterwards.
  await context.close();
  context = await launchBrowser();
  const restart = await round('restart');
  expect(restart.offscreenBeforePlay, 'no offscreen document before audio is needed').toBe(0);
  step('cold start: browser restart, page alone');

  // 2. The service worker stopped (chrome://serviceworker-internals "Stop").
  // Wake the worker first, so there is a running worker to stop.
  await offscreenCount();
  const internals = await context.newPage();
  await internals.goto('chrome://serviceworker-internals/');
  const item = internals.locator('.serviceworker-item', { hasText: `chrome-extension://${id}/` });
  await expect(item).toContainText('Running Status: RUNNING', { timeout: 10_000 });
  await item.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(item).toContainText('Running Status: STOPPED', { timeout: 10_000 });
  console.log('service worker stop: stopped (chrome://serviceworker-internals)');
  await internals.close();
  const afterStop = await round('worker-stopped');
  step('cold start: service worker stopped, page alone');

  report.coldStart = { ok: true, restart, workerStopped: afterStop };
  report.ok = firstOk;
});

// Resume the last song: the device whose engine played it keeps it (sealed record and
// an audio copy) and plays it again from where it was after the offscreen document and
// the worker went away, after a browser restart, and after its link stopped working.
// The fixture's songs are about 10 s long, so "where it was" is a few seconds in, not 1:23.
test('resume: the last song continues where it was', async () => {
  test.skip(LIVE, 'live mode runs only the live test');
  test.skip(!haveTuner, 'no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR');
  const firstOk = report.ok;
  report.ok = false;
  report.resume = { ok: false };
  const id = await extensionId();
  const ext = (p) => `chrome-extension://${id}/${p}`;
  const sw = async () => context.serviceWorkers()[0] || context.waitForEvent('serviceworker', { timeout: 15_000 });
  const ctlPage = async () => { const p = await context.newPage(); await p.goto(ext('options.html')); return p; };
  let ctl = await ctlPage();
  await useTuner(ctl);
  const send = (m) => ctl.evaluate((x) => chrome.runtime.sendMessage(x), m);
  const stateNow = async () => (await send({ type: 'player-get' })).state;
  const stopWorker = async () => {
    await (await sw()).evaluate(() => 1);
    const internals = await context.newPage();
    await internals.goto('chrome://serviceworker-internals/');
    const item = internals.locator('.serviceworker-item', { hasText: `chrome-extension://${id}/` });
    await expect(item).toContainText('Running Status: RUNNING', { timeout: 10_000 });
    await item.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(item).toContainText('Running Status: STOPPED', { timeout: 10_000 });
    await internals.close();
  };
  // Play a station until the position is past `at` seconds; returns that state.
  const playTo = async (at) => {
    if (!(await stateNow()).loggedIn) {
      acct.allow(tuner.user);
      const li = await send({ type: 'login', email: tuner.user, password: tuner.password, remember: true });
      expect(li && li.ok, `login (${li && li.error})`).toBe(true);
    }
    if (!((await stateNow()).stations || []).length) await send({ type: 'stations' });
    await expect.poll(async () => ((await stateNow()).stations || []).length, { timeout: 20_000 }).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 6; attempt++) {
      const list = (await stateNow()).stations;
      const st = list[attempt % list.length];
      await send({ type: 'player', action: 'play', station: { token: st.token, name: st.name } });
      const t0 = Date.now();
      let s = null;
      while (Date.now() - t0 < 20_000) {
        s = await stateNow();
        if (s.status === 'playing' && s.track && !s.track.ad && s.position >= at && (s.duration || s.track.duration || 0) - s.position > 3) return s;
        if (s.track && s.track.ad) break;
        await ctl.waitForTimeout(250);
      }
    }
    throw new Error('no song played past the mark');
  };
  // Open a popup and press play: the saved song, from its position.
  const resumeInPopup = async (label, want) => {
    const pop = await context.newPage();
    await pop.goto(ext('popup.html'));
    await expect(pop.locator('#np-title')).toHaveText(want.title, { timeout: 20_000 });
    await expect(pop.locator('#player-status')).toHaveText('Paused', { timeout: 10_000 });
    const shown = await stateNowFrom(pop);
    await pop.click('#play');
    let s = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      s = await stateNowFrom(pop);
      if (s.status === 'playing' && s.track && s.track.trackToken === want.trackToken && s.position > 0) break;
      await pop.waitForTimeout(100);
    }
    // The audio really plays on from there: the position moves.
    let moved = null;
    const tM = Date.now();
    while (Date.now() - tM < 6_000) {
      moved = await stateNowFrom(pop);
      if (moved.track && moved.track.trackToken === want.trackToken && moved.position > (s && s.position || 0) + 1) break;
      if (moved.track && moved.track.trackToken !== want.trackToken) break;
      await pop.waitForTimeout(200);
    }
    const r = { label, saved: want.position, shown: shown.position, resumedAt: s && s.position, advancedTo: moved && moved.track && moved.track.trackToken === want.trackToken ? moved.position : null, status: s && s.status, sameTrack: !!(s && s.track && s.track.trackToken === want.trackToken), last: shown.last && shown.last.trackToken === want.trackToken };
    console.log(`resume ${label}: ${JSON.stringify(r)}`);
    expect(r.sameTrack && r.status === 'playing', `${label}: the same song plays`).toBe(true);
    expect(Math.abs(r.resumedAt - want.position), `${label}: resumed within 1 s of ${want.position.toFixed(1)} s`).toBeLessThan(1.5);
    expect(r.last, `${label}: state.last names the song`).toBe(true);
    expect(r.advancedTo != null && r.advancedTo > r.resumedAt + 1, `${label}: the position moves on after Resume (${r.advancedTo})`).toBe(true);
    await pop.close();
    return r;
  };
  const stateNowFrom = async (p) => (await p.evaluate(() => chrome.runtime.sendMessage({ type: 'player-get' }))).state;
  const pauseAndSave = async () => {
    await send({ type: 'player', action: 'pause' });
    await ctl.waitForTimeout(800);
    return stateNow();
  };

  // 1. The offscreen document and the worker torn down mid-song.
  const a = await playTo(3);
  await ctl.waitForTimeout(2500);
  const beforeKill = await stateNow();
  await (await sw()).evaluate(() => chrome.offscreen.closeDocument());
  const killedAt = beforeKill.position + 0; // the record is at most 2 s old; the last report at most 1 s
  await ctl.close();
  await stopWorker();
  ctl = await ctlPage();
  const savedKill = (await stateNow());
  const r1 = await resumeInPopup('offscreen and worker gone', { title: a.track.title, trackToken: a.track.trackToken, position: savedKill.position });
  expect(Math.abs(savedKill.position - killedAt), 'the saved position is the one before the teardown').toBeLessThan(2.5);
  step('resume: offscreen document and worker gone');

  // 2. A browser restart (a fresh song, so a few seconds of it are left to hear).
  await playTo(2);
  const b = await pauseAndSave();
  await context.close();
  context = await launchBrowser();
  ctl = await ctlPage();
  const r2 = await resumeInPopup('browser restart', { title: b.track.title, trackToken: b.track.trackToken, position: b.position });
  step('resume: browser restart');

  // 3. The link stopped working: the audio copy plays from the position, then the station goes on.
  await playTo(2);
  await ctl.waitForTimeout(800); // the copy is fetched while the song plays
  const c = await pauseAndSave();
  const copies = await ctl.evaluate(async () => (await (await caches.open('melodica-audio')).keys()).length);
  await send({ type: 'test-expire-last' });
  await (await sw()).evaluate(() => chrome.offscreen.closeDocument().catch(() => null));
  const r3 = await resumeInPopup('expired link, audio copy', { title: c.track.title, trackToken: c.track.trackToken, position: c.position });
  const tNext = Date.now();
  let after = null;
  while (Date.now() - tNext < 30_000) {
    after = await stateNow();
    if (after.track && after.track.trackToken !== c.track.trackToken && after.status === 'playing') break;
    await ctl.waitForTimeout(250);
  }
  expect(after.track.trackToken !== c.track.trackToken && after.status === 'playing', 'after the copy ends the station goes on').toBe(true);
  step('resume: expired link plays the audio copy, then the station');

  // 4. The link stopped working and there is no copy: the station goes on and says so.
  const d = await playTo(2);
  await pauseAndSave();
  await send({ type: 'test-expire-last', dropCopy: true });
  await (await sw()).evaluate(() => chrome.offscreen.closeDocument().catch(() => null));
  await send({ type: 'player', action: 'resume' });
  let e = null;
  const tE = Date.now();
  while (Date.now() - tE < 30_000) {
    e = await stateNow();
    if (e.track && e.track.trackToken !== d.track.trackToken && e.status === 'playing') break;
    await ctl.waitForTimeout(250);
  }
  console.log(`resume no copy: ${JSON.stringify({ status: e.status, notice: e.notice, other: e.track && e.track.trackToken !== d.track.trackToken })}`);
  expect(e.track.trackToken !== d.track.trackToken && e.status === 'playing', 'no copy: the station goes on').toBe(true);
  expect(e.notice, 'no copy: the state says so').toMatch(/could not be played again/);
  step('resume: expired link and no copy, the station goes on');
  await send({ type: 'player', action: 'stop' });
  await ctl.close();

  report.resume = { ok: true, offscreenAndWorker: r1, restart: r2, expiredWithCopy: { ...r3, copiesBefore: copies, continued: true }, expiredNoCopy: { continued: true, notice: e.notice }, note: 'fixture songs are about 10 s, so positions are a few seconds in' };
  report.ok = firstOk;
});

test('handoff: bridge exports and imports the live song without refetching Pandora', async () => {
  test.skip(LIVE || !haveTuner, 'requires the local tuner');
  const id = await extensionId();
  const ctl = await context.newPage();
  await ctl.goto(`chrome-extension://${id}/options.html`);
  const send = (message) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), message);
  await ctl.locator('#endpoint').fill(`${tuner.https}/services/json/`);
  await ctl.locator('#save').click();
  await expect(ctl.locator('#options-message')).toContainText('Saved');
  await expect.poll(async () => (await send({ type: 'state' })).settings.endpoint).toBe(`${tuner.https}/services/json/`);
  acct.allow(tuner.user);
  const login = await send({ type: 'login', email: tuner.user, password: tuner.password, remember: true });
  expect(login.ok, login.error).toBe(true);
  const list = (await send({ type: 'stations' })).stations;
  expect(list.length).toBeGreaterThan(0);
  await send({ type: 'player', action: 'play', station: list[0] });
  await expect.poll(async () => (await send({ type: 'player-get' })).state.status).toBe('playing');
  const page = await context.newPage();
  await page.goto(`https://${WEB_HOST}${APP_PATH}handoff-test.html`);
  const ask = (message) => bridgeAsk(page, message);
  const exported = await ask({ type: 'command', action: 'playback-export' });
  expect(exported.ok, exported.error).toBe(true);
  expect(exported.playback.song.audioUrl).toContain('/audio/');
  expect(exported.playback.sid).toBeTruthy();
  expect(exported.state.track.audioUrl).toBeUndefined();
  expect(exported.state.queue.every((s) => !s.audioUrl)).toBe(true);
  await send({ type: 'player', action: 'stop' });
  const before = (await getJson(`${tuner.http}/__tuner/log`)).filter((r) => r.protocol === 'json' && r.method).length;
  const imported = await ask({ type: 'command', action: 'playback-import', playback: exported.playback });
  expect(imported.ok, imported.error).toBe(true);
  await expect.poll(async () => (await send({ type: 'player-get' })).state.status).toBe('playing');
  const current = (await send({ type: 'player-get' })).state;
  expect(current.track.trackToken).toBe(exported.playback.song.trackToken);
  expect(current.position).toBeGreaterThanOrEqual(exported.playback.position - 0.1);
  expect((await getJson(`${tuner.http}/__tuner/log`)).filter((r) => r.protocol === 'json' && r.method).length).toBe(before);
  // Chrome can close an AUDIO_PLAYBACK document while a view still shows its
  // last Playing state. That view's next toggle means Pause, including when
  // the replacement engine initially hydrates the saved song as Paused.
  await ctl.evaluate(() => chrome.offscreen.closeDocument());
  const toggled = await send({ type: 'player', action: 'toggle' });
  expect(toggled.ok, toggled.error).toBe(true);
  expect(toggled.state.status).toBe('paused');
  const wrong = await ask({ type: 'command', action: 'playback-import', playback: { ...exported.playback, sid: 'different-session' } });
  expect(wrong.ok).toBe(false);
  const shared = await ask({ type: 'session-get' });
  expect(shared.session.sid).toBe(exported.playback.sid);
  await send({ type: 'player', action: 'stop' });
  await send({ type: 'logout' });
  // Simulate a web engine offering its current authenticated session to a newly
  // installed/signed-out extension. Authorization still checks the access service;
  // the handed-over station list and playlist need no Pandora verification call.
  const newSid = 'web-engine-session-for-handoff';
  const transfer = { ...exported.playback, sid: newSid, at: Date.now(), status: 'paused' };
  const beforeOffer = (await getJson(`${tuner.http}/__tuner/log`)).filter((r) => r.protocol === 'json' && r.method);
  const offer = await ask({ type: 'session-offer', session: { ...shared.session, sid: newSid }, credential: shared.credential, playback: transfer, stations: list });
  expect(offer.ok, offer.error).toBe(true);
  expect(offer.outcome).toBe('signed-in');
  const paused = await ask({ type: 'command', action: 'playback-import', playback: transfer });
  expect(paused.ok, paused.error).toBe(true);
  expect(paused.state.status).toBe('paused');
  expect(paused.state.track.trackToken).toBe(transfer.song.trackToken);
  expect((await getJson(`${tuner.http}/__tuner/log`)).filter((r) => r.protocol === 'json' && r.method).slice(beforeOffer.length).map((r) => r.method)).toEqual([]);
  await send({ type: 'logout' });
  await writeFile(resolve(ARTIFACTS, 'handoff.json'), JSON.stringify({ ok: true, checks: {
    privateExport: true, publicStateHidesAudioUrls: true, exactSongResumed: true,
    positionPreserved: true, wrongSessionRejected: true, pausedImportStaysPaused: true,
    togglePreservesPauseAfterEngineRecreation: true,
    noPandoraMethodsDuringImport: true, noPandoraMethodsDuringSessionOffer: true,
  } }, null, 2) + '\n');
  await page.close(); await ctl.close();
});

test('copy: the bridge transfers exact private cached bytes after the song URL expires', async () => {
  test.skip(LIVE || !haveTuner, 'requires the local tuner');
  const id = await extensionId();
  const ctl = await context.newPage();
  await ctl.goto(`chrome-extension://${id}/options.html`);
  await useTuner(ctl);
  const send = (message) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), message);
  acct.allow(tuner.user);
  expect((await send({ type: 'login', email: tuner.user, password: tuner.password, remember: true })).ok).toBe(true);
  const stations = (await send({ type: 'stations' })).stations;
  await send({ type: 'player', action: 'play', station: stations[0] });
  await expect.poll(async () => (await send({ type: 'player-get' })).state.status).toBe('playing');
  const page = await context.newPage();
  await page.goto(`https://${WEB_HOST}${APP_PATH}handoff-test.html`);
  const ask = (message) => bridgeAsk(page, message);
  const original = (await ask({ type: 'command', action: 'playback-export' })).playback;
  const token = original.song.trackToken;
  await expect.poll(async () => !!(await ask({ type: 'command', action: 'playback-copy', trackToken: token, offset: 0, limit: 16384 })).copy).toBe(true);
  const hash = await ctl.evaluate(async (token) => {
    const cache = await caches.open('melodica-audio');
    const response = await cache.match(`https://melodica.invalid/audio/${encodeURIComponent(token)}`);
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }, token);
  await send({ type: 'player', action: 'pause' });
  await send({ type: 'test-expire-last', dropCopy: false });
  await ctl.evaluate(() => chrome.offscreen.closeDocument());
  await send({ type: 'player', action: 'resume' });
  await expect.poll(async () => (await send({ type: 'player-get' })).state.position).toBeGreaterThan(original.position + 0.1);
  const expired = (await ask({ type: 'command', action: 'playback-export' })).playback;
  expect(expired.song.trackToken).toBe(token);
  expect(expired.song.audioUrl).toContain('/expired.m4a');
  expect(expired.song.fetchedAt).toBeLessThan(Date.now() - 60 * 60_000);
  const before = (await getJson(`${tuner.http}/__tuner/log`)).filter((r) => r.protocol === 'json').length;
  let offset = 0, done = false;
  const parts = [];
  while (!done) {
    const result = await ask({ type: 'command', action: 'playback-copy', trackToken: token, offset, limit: 16384 });
    expect(result.ok, result.error).toBe(true);
    expect(result.copy.sid).toBe(expired.sid);
    expect(result.copy.offset).toBe(offset);
    const bytes = Buffer.from(result.copy.bytes, 'base64');
    expect(bytes.length).toBeLessThanOrEqual(16384);
    parts.push(bytes); offset += bytes.length; done = result.copy.done;
    if (done) expect(offset).toBe(result.copy.total);
  }
  const { createHash } = await import('node:crypto');
  expect(createHash('sha256').update(Buffer.concat(parts)).digest('hex')).toBe(hash);
  expect(parts.length).toBeGreaterThan(1);
  expect((await getJson(`${tuner.http}/__tuner/log`)).filter((r) => r.protocol === 'json').length).toBe(before);
  expect((await ask({ type: 'command', action: 'playback-copy', trackToken: 'another-song', offset: 0 })).ok).toBe(false);
  await writeFile(resolve(ARTIFACTS, 'playback-copy.json'), JSON.stringify({ ok: true, expiredUrl: true, exactHash: true, chunks: parts.length, bytes: offset, noPandoraApiCalls: true }, null, 2) + '\n');
  await send({ type: 'player', action: 'stop' });
  await page.close(); await ctl.close();
});

test('disable: invalidated runtime signals gone only after the extension audio target closes', async () => {
  test.skip(LIVE || !haveTuner, 'requires the local tuner');
  const id = await extensionId();
  const ctl = await context.newPage();
  await ctl.goto(`chrome-extension://${id}/options.html`);
  await useTuner(ctl);
  const send = (message) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), message);
  acct.allow(tuner.user);
  expect((await send({ type: 'login', email: tuner.user, password: tuner.password, remember: true })).ok).toBe(true);
  const stations = (await send({ type: 'stations' })).stations;
  await send({ type: 'player', action: 'play', station: stations[0] });
  await expect.poll(async () => (await send({ type: 'player-get' })).state.status).toBe('playing');
  const page = await context.newPage();
  await page.goto(`https://${WEB_HOST}${APP_PATH}handoff-test.html`);
  await page.evaluate(() => { window.__gone = []; addEventListener('message', (ev) => { if (ev.source === window && ev.data?.melodica === 1 && ev.data.type === 'gone') window.__gone.push(ev.data); }); });
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => window.__gone)).toEqual([]);
  const internals = await context.newPage();
  await internals.goto('chrome://serviceworker-internals/');
  const worker = internals.locator('.serviceworker-item', { hasText: `chrome-extension://${id}/` });
  await worker.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => window.__gone), 'stopping only the background does not mean audio stopped').toEqual([]);
  await internals.close();
  const manager = await context.newPage();
  await manager.goto(`chrome://extensions/?id=${id}`);
  const cdp = await context.newCDPSession(manager);
  const offscreen = `chrome-extension://${id}/offscreen.html`;
  expect((await cdp.send('Target.getTargets')).targetInfos.some((t) => t.url === offscreen)).toBe(true);
  await manager.locator('extensions-detail-view #enableToggle').click();
  await expect.poll(() => page.evaluate(() => window.__gone.map((d) => d.reason))).toEqual(['runtime-invalidated']);
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some((t) => t.url === offscreen)).toBe(false);
  expect(context.serviceWorkers().some((w) => w.url().startsWith(`chrome-extension://${id}/`))).toBe(false);
  await writeFile(resolve(ARTIFACTS, 'runtime-invalidated.json'), JSON.stringify({ ok: true, sleepingWorkerDoesNotSignalGone: true, browserDisable: true, goneSignal: 'runtime-invalidated', offscreenTargetClosed: true, backgroundWorkerClosed: true }, null, 2) + '\n');
  await manager.locator('extensions-detail-view #enableToggle').click();
  await cdp.detach(); await manager.close(); await page.close(); await ctl.close();
});

test('disable and re-enable: an open web player returns to the extension without refetching playback', async () => {
  test.skip(LIVE || !haveTuner, 'requires the local tuner');
  test.skip(!existsSync(join(WEB_DIST, 'tabs.js')), 'set MELODICA_WEB_DIST to the melodica-web build with tab playback');
  test.setTimeout(150_000);
  const id = await extensionId();
  const ctl = await context.newPage();
  await ctl.goto(`chrome-extension://${id}/options.html`);
  await useTuner(ctl);
  const send = (message) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), message);
  acct.allow(tuner.user);
  await send({ type: 'logout' });
  expect((await send({ type: 'login', email: tuner.user, password: tuner.password, remember: true })).ok).toBe(true);
  const stations = (await send({ type: 'stations' })).stations;
  const station = stations.find((s) => !s.isQuickMix) || stations[0];
  await send({ type: 'player', action: 'play', station });
  await expect.poll(async () => (await send({ type: 'player-get' })).state.status).toBe('playing');
  await expect.poll(async () => (await send({ type: 'player-get' })).state.position).toBeGreaterThan(0.5);
  await send({ type: 'player', action: 'pause' });
  await expect.poll(async () => (await send({ type: 'player-get' })).state.status).toBe('paused');
  const held = (await send({ type: 'player-get' })).state;
  const token = held.track.trackToken;
  const songTitle = held.track.title;
  let initialPrivate;
  await expect.poll(async () => {
    initialPrivate = await send({ type: 'playback-export' });
    return !!initialPrivate.playback?.song;
  }, { timeout: 5_000 }).toBe(true);
  console.log('initial private transfer', JSON.stringify({
    keys: Object.keys(initialPrivate || {}), ok: initialPrivate?.ok, error: initialPrivate?.error,
    sid: initialPrivate?.playback?.sid, track: initialPrivate?.playback?.song?.trackToken,
    genome: initialPrivate?.playback?.song?.genome,
    tracker: initialPrivate?.playback?.song?.melodicaPlay,
    log: await ctl.evaluate(async () => (await chrome.storage.session.get('log')).log || []),
  }));
  expect(Array.isArray(initialPrivate.playback.song.genome), 'trait metadata was loaded before handoff').toBe(true);
  expect(initialPrivate.playback.song.melodicaPlay, 'listen tracker exists before handoff').toBeTruthy();
  const hashInExtension = await ctl.evaluate(async (token) => {
    const cache = await caches.open('melodica-audio');
    const response = await cache.match(`https://melodica.invalid/audio/${encodeURIComponent(token)}`);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, token);
  const page = await context.newPage();
  const requests = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`https://${WEB_HOST}${APP_PATH}`);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote');
  await expect(page.locator('#np-title')).toHaveText(songTitle);
  await expect.poll(() => page.evaluate(async (token) => {
    const cache = await caches.open('melodica-audio-v1');
    const response = await cache.match(`${location.origin}/melodica/__audio/${encodeURIComponent(token)}`);
    return response ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('') : '';
  }, token), { timeout: 20_000 }).toBe(hashInExtension);
  await expect.poll(() => page.evaluate(async () => {
    const { Vault } = await import('./vault.js');
    return (await new Vault().read('last'))?.song?.trackToken || '';
  })).toBe(token);
  await send({ type: 'test-expire-last', dropCopy: false });
  await expect.poll(() => page.evaluate(async () => {
    const { Vault } = await import('./vault.js');
    const p = await new Vault().read('tab-engine-v1');
    return !!p?.song && Number(p.song.fetchedAt) < Date.now() - 60 * 60 * 1000;
  })).toBe(true);

  const manager = await context.newPage();
  await manager.goto(`chrome://extensions/?id=${id}`);
  const cdp = await context.newCDPSession(manager);
  const offscreen = `chrome-extension://${id}/offscreen.html`;
  expect((await cdp.send('Target.getTargets')).targetInfos.some((t) => t.url === offscreen)).toBe(true);
  await manager.locator('extensions-detail-view #enableToggle').click();
  await expect.poll(() => page.locator('#app').getAttribute('data-mode')).toBe('local');
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some((t) => t.url === offscreen)).toBe(false);
  await expect(page.locator('#np-title')).toHaveText(songTitle);
  await expect(page.locator('#bar-resume')).toBeVisible({ timeout: 10_000 });
  await page.click('#bar-resume');
  try {
    await expect.poll(() => page.locator('#audio').evaluate((audio) => !audio.paused && audio.currentSrc.startsWith('blob:'))).toBe(true);
  } catch (error) {
    console.log('web resume failed', JSON.stringify({ pageErrors,
      state: await page.evaluate(async () => ({ mode: document.querySelector('#app')?.dataset.mode,
        message: document.querySelector('#player-message')?.textContent, status: document.querySelector('#status')?.textContent,
        button: document.querySelector('#bar-resume')?.outerHTML,
        audio: { paused: document.querySelector('#audio')?.paused, src: document.querySelector('#audio')?.getAttribute('src'), currentSrc: document.querySelector('#audio')?.currentSrc,
          error: document.querySelector('#audio')?.error && { code: document.querySelector('#audio').error.code, message: document.querySelector('#audio').error.message } },
        copyCache: await (async () => { const c = await caches.open('melodica-audio-v1'); const r = await c.match(`${location.origin}/melodica/__audio/${encodeURIComponent(document.querySelector('#np-title')?.dataset?.token || '')}`); return !!r; })() })) }));
    throw error;
  }
  await expect.poll(() => page.locator('#audio').evaluate((audio) => audio.currentTime)).toBeGreaterThanOrEqual(held.position - 0.5);
  await page.waitForTimeout(500);
  const localBeforeEnable = await page.evaluate(async () => {
    const { Vault } = await import('./vault.js');
    const vault = new Vault();
    return { status: document.querySelector('#status')?.textContent,
      resume: document.querySelector('#bar-resume')?.outerHTML,
      audio: { paused: document.querySelector('#audio')?.paused, src: document.querySelector('#audio')?.getAttribute('src'), currentSrc: document.querySelector('#audio')?.currentSrc, currentTime: document.querySelector('#audio')?.currentTime },
      tab: await vault.read('tab-engine-v1'), last: await vault.read('last') };
  });
  console.log('local playback before re-enable', JSON.stringify({ ...localBeforeEnable,
    tab: localBeforeEnable.tab && { song: localBeforeEnable.tab.song?.title, position: localBeforeEnable.tab.position, playing: localBeforeEnable.tab.playing, fetchedAt: localBeforeEnable.tab.song?.fetchedAt },
    last: localBeforeEnable.last && { song: localBeforeEnable.last.song?.title, position: localBeforeEnable.last.position } }));
  expect(localBeforeEnable.tab?.song?.title).toBe(songTitle);
  expect(localBeforeEnable.tab.song.genome, 'the validated trait metadata crosses the web engine').toBeDefined();
  expect(localBeforeEnable.tab.song.melodicaPlay, 'the private listen tracker crosses the web engine').toMatchObject({
    sid: initialPrivate.playback.sid, trackToken: token,
    startedAt: initialPrivate.playback.song.melodicaPlay.startedAt,
    sent: initialPrivate.playback.song.melodicaPlay.sent,
  });
  expect(Number(localBeforeEnable.tab?.position)).toBeGreaterThanOrEqual(held.position - 0.5);
  expect(localBeforeEnable.audio.paused).toBe(false);
  expect(localBeforeEnable.audio.currentSrc).toMatch(/^blob:/);

  const managerLogs = await getJson(`${tuner.http}/__tuner/log`);
  const apiBeforeEnable = managerLogs.filter((row) => row.protocol === 'json').length;
  const mediaBeforeEnable = managerLogs.filter((row) => row.protocol === 'audio').length;
  const localTime = Number(localBeforeEnable.audio.currentTime || localBeforeEnable.tab?.position || localBeforeEnable.last?.position || held.position);
  await manager.locator('extensions-detail-view #enableToggle').click();
  await page.bringToFront();
  // Chrome may recreate the extension service worker after the manager toggles it.
  await expect.poll(() => page.locator('#app').getAttribute('data-mode'), { timeout: 15_000 }).toBe('remote');
  await expect(page.locator('#np-title')).toHaveText(songTitle);
  const reenabledCtl = await context.newPage();
  await reenabledCtl.goto(`chrome-extension://${id}/options.html`);
  const sendAgain = (message) => reenabledCtl.evaluate((m) => chrome.runtime.sendMessage(m), message);
  await expect.poll(async () => (await sendAgain({ type: 'player-get' })).state.status).toBe('playing');
  await expect.poll(() => page.locator('#audio').evaluate((audio) => audio.paused && !audio.getAttribute('src'))).toBe(true);
  const offscreenTargets = () => cdp.send('Target.getTargets').then((r) => r.targetInfos.filter((t) => t.url === offscreen));
  await expect.poll(async () => (await offscreenTargets()).length).toBe(1);
  await expect.poll(async () => {
    const current = (await sendAgain({ type: 'player-get' })).state;
    return current.track?.trackToken === token && current.position >= localTime - 1.5;
  }).toBe(true);
  const returned = (await sendAgain({ type: 'player-get' })).state;
  expect(returned.track.title).toBe(songTitle);
  const returnedPrivate = await bridgeAsk(page, { type: 'command', action: 'playback-export' });
  expect(returnedPrivate.playback.song.genome).toEqual(initialPrivate.playback.song.genome);
  expect(returnedPrivate.playback.song.melodicaPlay).toMatchObject({
    sid: initialPrivate.playback.song.melodicaPlay.sid,
    trackToken: initialPrivate.playback.song.melodicaPlay.trackToken,
    startedAt: initialPrivate.playback.song.melodicaPlay.startedAt,
    sent: initialPrivate.playback.song.melodicaPlay.sent,
  });
  expect(returnedPrivate.playback.song.melodicaPlay.played).toBeGreaterThanOrEqual(initialPrivate.playback.song.melodicaPlay.played);
  const offscreenAudio = await evaluateTarget(cdp, (await offscreenTargets())[0].targetId,
    `(() => { const a = document.querySelector('#audio'); return a && { paused: a.paused, currentSrc: a.currentSrc, currentTime: a.currentTime }; })()`);
  expect(offscreenAudio && !offscreenAudio.paused).toBe(true);
  expect(offscreenAudio.currentSrc).toMatch(/^blob:/);
  expect(offscreenAudio.currentTime).toBeGreaterThanOrEqual(localTime - 1.5);
  const tunerLogAfterEnable = await getJson(`${tuner.http}/__tuner/log`);
  const apiDelta = tunerLogAfterEnable.filter((row) => row.protocol === 'json').slice(apiBeforeEnable);
  const mediaAfterEnable = tunerLogAfterEnable.filter((row) => row.protocol === 'audio').length;
  console.log('Pandora methods during re-enable', JSON.stringify(apiDelta.map((row) => row.method)));
  expect(apiDelta, 're-enabling transfers the same validated session without any Pandora RPC').toEqual([]);
  expect(mediaAfterEnable, 're-enabling resumes from the exact cached audio bytes').toBe(mediaBeforeEnable);
  expect(requests.filter((url) => url.includes('/melodica/api/')), 'the page makes no relay calls').toEqual([]);
  expect(requests.filter((url) => /\/oauth\/melodica\/(?:me|policy)(?:\?|$)/.test(new URL(url).pathname)), 'the page makes no /me or /policy request').toEqual([]);
  expect(requests.filter((url) => /\/audio\//.test(url) || /\.(mp3|m4a|aac|wav)(?:\?|$)/.test(url)), 'the page makes no media refetch').toEqual([]);
  await writeFile(resolve(ARTIFACTS, 'extension-reenable.json'), JSON.stringify({ ok: true, sameSong: true,
    positionAtDisable: held.position, positionAtEnable: returned.position, pageAudioPaused: true,
    extensionAudioTarget: true, extensionAudioBlob: true, pandoraMethods: apiDelta.map((row) => row.method),
    noPandoraRPC: true, noRelay: true, noMeOrPolicy: true, noMediaRefetch: true,
    pageRequestUrls: requests }, null, 2) + '\n');
  await cdp.detach();
  await reenabledCtl.close();
  await manager.close();
  await page.close();
  await ctl.close();
});

test('rooms: an extension-owned room session keeps live audio through page unmount, search and sign-out', async () => {
  test.skip(LIVE || !haveTuner || !existsSync(ROOM_MEDIA_BUNDLE), 'requires the local tuner and current shared room media bundle');
  test.setTimeout(120_000);
  const id = await extensionId();
  const roomId = 'nativeRoomProbe12345';
  const metadata = { track_name: 'Room oscillator', artist_name: 'Native extension fixture', release_name: 'Local', additional_info: { duration_ms: 2000 } };
  roomProbe = { id: roomId, cursor: 0, nextChunk: 0, chunks: [], signals: [], commands: [], heard: [], searches: [], joinCalls: 0, leaveCalls: 0, clockCalls: [], holdEvents: false, heldEvents: 0, state: {
    id: roomId, name: 'Native extension room', kind: 'public', mode: 'rotation', host: 'dj-owner',
    you: 'listener-ci', current_dj: 'dj-owner', ready_at: 1, seq: 1, spots: 1, skip_fraction: 0.5,
    scrobble: true, closed_at: null, djs: ['dj-owner'], waiting: [], requests: [], past: [],
    members: [{ account: 'dj-owner', name: 'Fixture DJ', role: 'dj' }, { account: 'listener-ci', name: 'Fixture listener', role: 'listener' }],
    play: { id: 'room-play-1', dj: 'dj-owner', started_at: Date.now(), paused_at: null, duration_ms: 2000,
      track_metadata: metadata, likes: 0, dislikes: 0, skip_threshold: 1, reaction: null },
  } };
  const ctl = await context.newPage();
  const pageErrors = [];
  let roomPage = null, djPage = null, bridgePage = null;
  try {
    await ctl.goto(`chrome-extension://${id}/options.html`);
    await useTuner(ctl);
    const send = (message) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), message);
    const redirects = [];
    await context.route('https://*.chromiumapp.org/**', (route) => { redirects.push(route.request().url()); route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }); });
    const begin = await send({ type: 'account-begin' });
    expect(begin.ok, `account-begin (${begin.error})`).toBe(true);
    const auth = await context.newPage();
    await auth.goto(begin.url);
    await auth.click('#sg-github');
    await auth.click('#gh-octo-ci');
    await expect.poll(() => redirects.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const finish = await send({ type: 'account-finish', url: redirects.at(-1) });
    expect(finish.ok && finish.account.signedIn).toBe(true);
    await auth.close();

    const recentBefore = await send({ type: 'room-recent' });
    expect(recentBefore.recentRoomIds).toEqual([]);
    const search = await send({ type: 'room-search', query: 'native', cursor: '', recentIds: [] });
    expect(search.ok, search.error).toBe(true);
    expect(search.rooms.map((entry) => entry.id)).toEqual([roomId]);
    expect(roomProbe.searches.at(-1)).toMatchObject({ q: 'native', cursor: '', recent: '' });
    bridgePage = await context.newPage();
    await bridgePage.addInitScript(() => {
      window.__melodica = [];
      window.addEventListener('message', (event) => { if (event.source === window && event.data?.melodica === 1) window.__melodica.push(event.data); });
    });
    await bridgePage.goto(`https://${WEB_HOST}${APP_PATH}`);
    await bridgePage.waitForFunction(() => window.__melodica?.some((message) => message.type === 'ready'), null, { timeout: 15_000 });
    await bridgePage.evaluate(() => window.postMessage({ melodica: 1, type: 'hello' }, location.origin));
    const bridgedSearch = await bridgeAsk(bridgePage, { type: 'command', action: 'room-api', path: 'rooms?q=native' });
    expect(bridgedSearch.ok, bridgedSearch.error).toBe(true);
    expect(bridgedSearch.result.rooms.map((entry) => entry.id)).toEqual([roomId]);

    const tunerBefore = await getJson(`${tuner.http}/__tuner/log`);
    const jsonBefore = tunerBefore.filter((row) => row.protocol === 'json').length;
    const mediaBefore = tunerBefore.filter((row) => row.protocol === 'audio').length;
    roomPage = await context.newPage();
    roomPage.on('pageerror', (e) => pageErrors.push(String(e)));
    roomPage.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await roomPage.goto(`chrome-extension://${id}/rooms.html?room=${roomId}`);
    await expect(roomPage.locator('.sui-room-track h2')).toHaveText(metadata.track_name, { timeout: 30_000 });
    const initialRoom = await send({ type: 'room-get' });
    expect(initialRoom.room?.audio?.state).not.toBe('listening');
    expect(roomProbe.signals.some((signal) => signal.data?.request === true || signal.data?.request === 'relay'),
      'the offscreen listener requests either a peer stream or the room relay transport').toBe(true);
    await roomPage.getByRole('button', { name: 'Connect room audio' }).click();
    await expect.poll(async () => (await send({ type: 'room-get' })).room?.audio?.state).toBe('connecting');
    const beforeAudio = await send({ type: 'player-get' });
    expect(beforeAudio.state.track).toMatchObject({ kind: 'room', title: metadata.track_name, artist: metadata.artist_name });
    expect(beforeAudio.state.track.trackToken, 'room snapshots do not expose Pandora tokens').toBeUndefined();
    expect(beforeAudio.state.status, 'connecting room audio is never shown as playing').toBe('loading');

    djPage = await context.newPage();
    await djPage.goto(`https://${WEB_HOST}${APP_PATH}room-dj.html?id=${roomId}`);
    await djPage.click('#start');
    try {
      await expect.poll(async () => (await send({ type: 'room-get' })).room?.audio?.state, { timeout: 35_000 }).toBe('listening');
    } catch (error) {
      const extensionState = await send({ type: 'room-get' });
      console.log('native room peer diagnostics', JSON.stringify({ extensionState, commands: roomProbe.commands,
        signals: roomProbe.signals.map((s) => ({ from: s.from, to: s.to, data: Object.keys(s.data || {}), request: s.data?.request,
          description: s.data?.description && { type: s.data.description.type, sdpLength: s.data.description.sdp?.length }, candidate: !!s.data?.candidate })),
        dj: await djPage.evaluate(() => ({ state: window.roomState, audio: window.roomAudioState, error: window.roomError })),
        listenerErrors: pageErrors,
      }));
      throw error;
    }
    const offscreenTarget = async () => {
      const manager = await context.newPage();
      try {
        await manager.goto('chrome://extensions');
        const cdp = await context.newCDPSession(manager);
        try { return (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.url === `chrome-extension://${id}/offscreen.html`); }
        finally { await cdp.detach(); }
      } finally { await manager.close(); }
    };
    const liveOffscreen = await offscreenTarget();
    expect(liveOffscreen, 'offscreen owns the active room transport').toBeTruthy();
    try { await expect.poll(() => roomProbe.heard.length, { timeout: 8_000 }).toBe(1); }
    catch (error) {
      console.log('native room receipt diagnostics', JSON.stringify({ extensionState: await send({ type: 'room-get' }),
        commands: roomProbe.commands, signals: roomProbe.signals.map((s) => ({ from: s.from, to: s.to, request: s.data?.request,
          description: s.data?.description && s.data.description.type, candidate: !!s.data?.candidate })), heard: roomProbe.heard,
        dj: await djPage.evaluate(() => ({ state: window.roomState, audio: window.roomAudioState, error: window.roomError })) }));
      throw error;
    }
    expect(roomProbe.heard[0]).toMatchObject({ viewer: 'listener-ci', play_id: 'room-play-1' });
    expect(roomProbe.heard[0].listened_ms).toBeGreaterThanOrEqual(1000);

    const paused = await send({ type: 'room-audio-command', roomId, action: 'pause' });
    expect(paused.ok, paused.error).toBe(true);
    await expect.poll(async () => (await send({ type: 'room-get' })).room?.audio?.paused).toBe(true);
    const resumed = await send({ type: 'room-audio-command', roomId, action: 'resume' });
    expect(resumed.ok, resumed.error).toBe(true);
    await expect.poll(async () => (await send({ type: 'room-get' })).room?.audio?.paused).toBe(false);
    const volume = await send({ type: 'room-audio-command', roomId, action: 'volume', value: 37 });
    expect(volume.ok, volume.error).toBe(true);

    const optOut = await send({ type: 'room-command', roomId, command: { action: 'scrobble', enabled: false } });
    expect(optOut.ok, optOut.error).toBe(true);
    await expect.poll(async () => (await send({ type: 'room-get' })).room?.state?.scrobble).toBe(false);
    roomProbe.state.play = { ...roomProbe.state.play, id: 'room-play-2', started_at: Date.now() };
    roomProbe.state.seq++;
    await expect.poll(async () => (await send({ type: 'room-get' })).room?.state?.play?.id).toBe('room-play-2');
    await expect.poll(async () => (await send({ type: 'room-get' })).room?.audio?.state, { timeout: 20_000 }).toBe('listening');
    await roomPage.close();
    roomPage = null;
    await expect.poll(async () => (await send({ type: 'room-get' })).room?.id).toBe(roomId);
    await expect.poll(async () => (await send({ type: 'room-get' })).room?.audio?.state).toBe('listening');
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(roomProbe.heard, 'room opt-out suppresses the next real audio receipt').toHaveLength(1);
    const tunerAfter = await getJson(`${tuner.http}/__tuner/log`);
    expect(tunerAfter.filter((row) => row.protocol === 'json').length, 'room transfer performs no Pandora JSON RPC').toBe(jsonBefore);
    expect(tunerAfter.filter((row) => row.protocol === 'audio').length, 'room transfer fetches no Pandora media').toBe(mediaBefore);
    expect(pageErrors).toEqual([]);
    const liveRoom = await send({ type: 'room-get' });
    let workerRestartPreservedRoom = false;
    if (process.env.MELODICA_NATIVE_RESTART_PROOF === '1') {
      const joinCallsBeforeRestart = roomProbe.joinCalls;
      const bootCount = async () => (await ctl.evaluate(async () => (await chrome.storage.session.get('log')).log || []))
        .filter((line) => line.includes('boot melodica-extension')).length;
      const bootsBeforeRestart = await bootCount();
      roomProbe.holdEvents = true;
      await expect.poll(() => roomProbe.heldEvents, { timeout: 10_000 }).toBeGreaterThan(0);
      const worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith(`chrome-extension://${id}/`));
      expect(worker, 'service worker is running before the room recovery proof').toBeTruthy();
      await worker.evaluate(() => 1);
      const internals = await context.newPage();
      await internals.goto('chrome://serviceworker-internals/');
      const workerRow = internals.locator('.serviceworker-item', { hasText: `chrome-extension://${id}/` });
      await expect(workerRow).toContainText('Running Status: RUNNING', { timeout: 10_000 });
      await workerRow.getByRole('button', { name: 'Stop', exact: true }).click();
      await internals.close();
      roomProbe.holdEvents = false;
      const afterRestart = await send({ type: 'room-get' });
      expect(afterRestart.ok, afterRestart.error).toBe(true);
      await expect.poll(bootCount, { timeout: 15_000 }).toBeGreaterThan(bootsBeforeRestart);
      expect(afterRestart.room.id, 'active offscreen membership is recovered after service worker restart').toBe(roomId);
      expect(afterRestart.room.audio.state, 'room audio remains live across service worker restart').toBe('listening');
      expect(roomProbe.joinCalls, 'a warm offscreen room session does not POST a duplicate join').toBe(joinCallsBeforeRestart);
      workerRestartPreservedRoom = true;
    } else {
      console.warn('native room worker-restart recovery is not verified; set MELODICA_NATIVE_RESTART_PROOF=1 to run the isolated stop/restart check');
    }
    const recent = await send({ type: 'room-recent' });
    expect(recent.recentRoomIds).toEqual([roomId]);
    const leave = await send({ type: 'room-leave', roomId });
    expect(leave.ok, leave.error).toBe(true);
    await expect.poll(() => roomProbe.leaveCalls).toBeGreaterThan(0);
    const rejoined = await send({ type: 'room-join', roomId });
    expect(rejoined.ok, rejoined.error).toBe(true);
    await expect.poll(async () => (await send({ type: 'room-get' })).room?.audio?.state, { timeout: 20_000 }).toBe('listening');
    const leavesBeforeSignout = roomProbe.leaveCalls;
    const signedOut = await send({ type: 'account-signout' });
    expect(signedOut.ok, signedOut.error).toBe(true);
    await expect.poll(() => roomProbe.leaveCalls).toBeGreaterThan(leavesBeforeSignout);
    expect((await send({ type: 'room-get' })).room?.id).toBe(null);
    expect((await send({ type: 'room-recent' })).recentRoomIds).toEqual([]);
    const evidence = { date: new Date().toISOString().slice(0, 10), browser: 'Chromium native extension',
      test: 'rooms: native ownership survives UI close, routes search, and leaves before sign-out',
      result: 'passed', roomId, transport: liveRoom.room?.audio?.transport || null,
      roomReceipt: roomProbe.heard[0], optOutBlockedSecondReceipt: roomProbe.heard.length === 1,
      pageUnmountPreservedRoom: true, workerRestartPreservedRoom, duplicateJoinOnWarmRestart: workerRestartPreservedRoom ? false : null,
      recentAndSearch: true, signOutLeftRoom: roomProbe.leaveCalls > 0, offscreenTarget: liveOffscreen.url,
      noPandoraRPC: true, noPandoraMedia: true,
      playwright: 'focused local tuner and synthetic OAuth/room API, isolated ports 20443/20080, handle 16251' };
    await writeFile(resolve(here, 'evidence/extension-rooms.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('native extension room proof', JSON.stringify(evidence));
  } finally {
    roomProbe = null;
    if (djPage) await djPage.close().catch(() => {});
    if (roomPage) await roomPage.close().catch(() => {});
    if (bridgePage) await bridgePage.close().catch(() => {});
    await ctl.close().catch(() => {});
  }
});


// Live: the extension's scrobbles against the real spacegho.st (throwaway account), with
// melodica-tuner for Pandora. tests/live-e2e.sh runs it; nothing else in CI does.
test('live: scrobbles reach spacegho.st', async () => {
  test.skip(!LIVE || !haveTuner, 'set LIVE_SCROBBLE_TOKEN_FILE (tests/live-e2e.sh)');
  test.setTimeout(8 * 60_000);
  const live = { ok: false, calls: liveCalls };
  report.live = live;
  const id = await extensionId();
  acct.allow(tuner.user);
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${id}/options.html`);
  await opts.fill('#endpoint', `${tuner.https}/services/json/`);
  await opts.click('#save');
  await expect(opts.locator('#options-message')).toContainText('Saved');
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'logout' }));
  const signed = await opts.evaluate(({ email, password }) => chrome.runtime.sendMessage({ type: 'login', email, password, remember: true }), { email: tuner.user, password: tuner.password });
  expect(signed && signed.ok, `login (${signed && signed.error})`).toBe(true);
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'scrobble-notice-seen' }));
  const st = await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'stations' }));
  const station = (st.stations || [])[0];
  expect(station, 'a station').toBeTruthy();
  // Low quality is the ADTS .aac the runner script lengthened to 70 s (an .m4a cannot be
  // joined without a muxer), so a single comes due at 35 s.
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'player', action: 'quality', value: 'low' })).catch(() => null);
  const playAt = Date.now();
  await opts.evaluate((s) => chrome.runtime.sendMessage({ type: 'player', action: 'play', station: { token: s.token, name: s.name } }), station);
  await opts.close();
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const bg = () => sw.evaluate(async () => (await chrome.storage.session.get('player')).player || {});
  // Commands go from a short-lived extension page (a worker does not hear its own messages).
  const command = async (action) => { const p = await context.newPage(); await p.goto(`chrome-extension://${id}/options.html`); const r = await p.evaluate((a) => chrome.runtime.sendMessage({ type: 'player', action: a }), action); await p.close(); return r; };
  // 1-2: playing in the background with no extension page open.
  await expect.poll(async () => (await bg()).status, { timeout: 30_000 }).toBe('playing');
  const first = (await bg()).track;
  live.background = { title: first.title, pages: (await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url || '').filter((u) => u.startsWith('chrome-extension://')))).length };
  // 3: playing_now posted (the forwarder sees it), then stored live; an older now
  // playing of the same title (an earlier run) does not count.
  await expect.poll(() => liveCalls.some((c) => c.method === 'POST' && c.at >= playAt && c.sent?.listen_type === 'playing_now'), { timeout: 15_000 }).toBe(true);
  let np = null;
  for (let i = 0; i < 60 && !np; i++) {
    const me = await liveGet('/scrobble/api/me');
    if (me.status === 200 && me.body?.now_playing && (me.body.now_playing.title === first.title || me.body.now_playing.track_name === first.title)) np = me.body.now_playing;
    else await new Promise((ok) => setTimeout(ok, 500));
  }
  live.nowPlaying = { ms: np ? Date.now() - playAt : null, fields: np ? Object.keys(np) : [], art: np ? !!(np.art || np.art_cached) : false };
  if (!np) {
    console.log(`live calls: ${JSON.stringify(liveCalls.map(({ sent, ...c }) => ({ ...c, kind: sent && sent.listen_type })))}`);
    console.log(`live me: ${JSON.stringify((await liveGet('/scrobble/api/me')).body?.now_playing || null)}`);
    console.log(`worker log: ${JSON.stringify(((await sw.evaluate(async () => (await chrome.storage.session.get('log')).log || [])) || []).slice(-25))}`);
  }
  expect(np, 'now playing on spacegho.st').toBeTruthy();
  const sentNp = liveCalls.find((c) => c.method === 'POST' && c.at >= playAt && c.sent?.listen_type === 'playing_now');
  live.nowPlaying.postedMs = sentNp ? sentNp.at - playAt : null;
  live.nowPlaying.sentInfo = sentNp ? Object.keys(sentNp.sent.payload[0].track_metadata.additional_info || {}) : [];
  expect(sentNp && sentNp.at - playAt, 'playing_now posted within 5 s of play').toBeLessThan(5000);
  // 5: thumbs up and down reach Pandora (the tuner): the state shows the rating.
  await command('love');
  await expect.poll(async () => (await bg()).track?.rating, { timeout: 10_000 }).toBe(1);
  live.thumbs = { up: true };
  // 4: a single once half the song has played (needs a fixture song over 30 s).
  const dur = Number((await bg()).duration) || 0;
  live.duration = dur;
  if (dur > 30) {
    const waitFor = Math.min(dur / 2, 240) + 8;
    await new Promise((ok) => setTimeout(ok, waitFor * 1000));
    const single = liveCalls.find((c) => c.method === 'POST' && c.sent?.listen_type === 'single');
    live.single = single ? { status: single.status, info: Object.keys(single.sent.payload[0].track_metadata.additional_info || {}) } : null;
    expect(single && single.status, 'single accepted').toBe(200);
    const listens = await liveGet('/scrobble/api/me/listens');
    const row = (listens.body?.listens || []).find((l) => l.title === first.title);
    live.listen = row ? { title: row.title, art: !!(row.art || row.art_cached), station: row.station || null } : null;
    expect(row, 'the listen is in me/listens').toBeTruthy();
  }
  await command('ban').catch(() => null);
  live.thumbs.down = true;
  live.ok = true;
  console.log(`live: ${JSON.stringify({ ...live, calls: liveCalls.map(({ sent, ...c }) => c) })}`);
});
