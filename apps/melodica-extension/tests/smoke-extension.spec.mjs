// End-to-end proof of the built extension (dist/chrome) in a real Chromium
// against melodica-tuner, a stand-in tuner.pandora.com:
//
//   0. the GitHub gate: with the endpoint at Pandora's default the popup shows the
//      gate screen, and tokens placed in storage.local (allowed, denied, an
//      "auth not configured" 503, a 401, an expired one) drive it through every
//      state against a fake /melodica/auth/me on the local https "spacegho.st"
//      server (tests/fake-auth.mjs; the real GitHub round trip needs GitHub);
//   1. the options page points the extension at the tuner's https URL, which
//      turns the gate off ("GitHub gate off: endpoint is …"); the popup also
//      shows the update banner, because the same local server serves a
//      releases.json / updates.json naming version 99.0.0;
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
//      playback state and pauses/resumes the music (docs/BRIDGE.md).
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
// Output: tests/artifacts/<name>.json and <name>-{gate,gate-denied,login,stations,playing,popup-playing,player-tab,bridge}.png
// where <name> is `smoke-extension` for Chromium and `smoke-brave` for Brave.

import { test, expect, chromium } from '@playwright/test';
import { handleAuth, makeToken, parseClaims } from './fake-auth.mjs';
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
  password: process.env.TUNER_PASSWORD || 'test',
  version: '',
  proc: null,
  dir: null,
};
const haveTuner = !!tuner.https || existsSync(join(TUNER_DIR, 'tuner', '__main__.py'));

const report = { steps: [], summary: '', ok: false, gate: null, update: null, bridge: null, audio: null, browser: '', engine: '', extension: {}, blocked: [], failedRequests: [], shields: null };
const authCalls = [];
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
    // The fake auth server lives on the same "spacegho.st": the extension's default
    // https://spacegho.st/melodica/auth/me lands here through --host-resolver-rules.
    if (handleAuth(req, res, authCalls)) return;
    const url = new URL(req.url, `https://${WEB_HOST}`);
    if (FEEDS[url.pathname]) {
      feedCalls.push(url.pathname);
      const text = JSON.stringify(FEEDS[url.pathname]);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
      res.end(text);
      return;
    }
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
  if (B.executablePath) {
    report.browser = browserBinaryVersion(B.executablePath);
    console.log(`browser: ${report.browser} (${B.executablePath})`);
  }
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
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
});

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
    gate: report.gate,
    update: report.update,
    audio: report.audio,
    bridge: report.bridge,
    blocked: report.blocked,
    failedRequests: report.failedRequests,
    shields: report.shields,
  };
  await writeFile(resolve(ARTIFACTS, `${B.name}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`${B.name}.json: ${JSON.stringify(out)}`);
});

// Brave: wait (up to a minute) for Shields' filter-list components to arrive, so the
// proof runs with Brave's default ad-block and privacy lists loaded, and record them.
// brave://components lists "<name> - Version: <v>" then "Status - <state>" per component.
async function waitForShieldsLists() {
  const t0 = Date.now();
  const page = await context.newPage();
  let components = [];
  let filtersLoaded = false;
  const wanted = ['Brave Default Adblock Filters', 'Brave Default Privacy Filters', 'Brave Ad Block Resources Library'];
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
      const have = (n) => components.find((c) => c.name === n && c.status === 'Updated' && c.version !== '0.0.0.0');
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

test('signs in through the popup, plays a station with no tab, bridges the web app', async ({}, info) => {
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

    // 0. The GitHub gate, while the endpoint is still Pandora's default. The popup must
    // show the gate screen, not the Pandora login; tokens are placed where the sign-in
    // flow puts them (storage.local "github") and the background is asked to re-check.
    // Popup pages are shot at the toolbar popup's size (popup.html sets 380 px).
    const POPUP = { width: 380, height: 640 };
    const coverLoaded = (p) => p.waitForFunction(() => { const i = document.getElementById('np-cover'); return !i || (i.complete && i.naturalWidth > 0); }, null, { timeout: 10_000 }).catch(() => {});
    const gatePage = await context.newPage();
    await gatePage.setViewportSize(POPUP);
    watch(gatePage, 'gate');
    await gatePage.goto(`chrome-extension://${id}/popup.html`);
    await expect(gatePage.locator('#app')).toHaveAttribute('data-view', 'gate', { timeout: 30_000 });
    await expect(gatePage.locator('#github-signin')).toBeVisible();
    await expect(gatePage.locator('#gate-note')).toContainText('GitHub sign-in is used for identity only; nothing is stored.');
    await gatePage.screenshot({ path: shot('gate') });
    const gateWith = async (claims) => gatePage.evaluate(async (token) => {
      if (token) await chrome.storage.local.set({ github: { token } }); else await chrome.storage.local.remove('github');
      const r = await chrome.runtime.sendMessage({ type: 'gate-check' });
      if (!r || !r.ok) throw new Error(`gate-check: ${r && r.error}`);
      const stored = await chrome.storage.local.get('github');
      return { gate: r.gate, storedToken: stored.github ? stored.github.token : null };
    }, claims ? makeToken(claims) : null);
    const viewNow = () => gatePage.evaluate(() => ({ view: document.getElementById('app').dataset.view, status: document.getElementById('gate-status')?.textContent || '', message: document.getElementById('gate-message')?.textContent || '' }));
    const gateReport = { anon: await viewNow() };
    expect(gateReport.anon.view).toBe('gate');

    const allowed = await gateWith({ sub: 'allowed-ci', id: 101, friend: true });
    expect(allowed.gate.mode, 'allowed token').toBe('allowed');
    expect(allowed.gate.login).toBe('allowed-ci');
    await expect(gatePage.locator('#app')).toHaveAttribute('data-view', 'login');
    await expect(gatePage.locator('#gate-status')).toContainText('allowed-ci');
    expect(parseClaims(allowed.storedToken)?.refreshed, 'the refreshed token from /auth/me replaced the stored one').toBe(true);
    gateReport.allowed = { ...allowed.gate, ...(await viewNow()), refreshed: true };

    const denied = await gateWith({ sub: 'denied-ci', id: 102, friend: false });
    expect(denied.gate.mode, 'denied token').toBe('denied');
    await expect(gatePage.locator('#app')).toHaveAttribute('data-view', 'gate');
    await expect(gatePage.locator('#gate-message')).toContainText('melodica is not available for your GitHub account (denied-ci).');
    await expect(gatePage.locator('#github-signout')).toBeVisible();
    await gatePage.screenshot({ path: shot('gate-denied') });
    gateReport.denied = { ...denied.gate, ...(await viewNow()) };
    // Pandora is refused while the gate is closed.
    const refusedLogin = await gatePage.evaluate(() => chrome.runtime.sendMessage({ type: 'stations' }));
    expect(refusedLogin.ok, 'stations refused for a denied account').toBe(false);
    expect(refusedLogin.kind).toBe('gate');
    gateReport.deniedRefused = refusedLogin;

    const unconfigured = await gateWith({ sub: 'unconfigured', friend: true });
    expect(unconfigured.gate.mode, '503 auth not configured -> gate off').toBe('off');
    expect(unconfigured.gate.reason).toContain('auth not configured');
    await expect(gatePage.locator('#app')).toHaveAttribute('data-view', 'login');
    await expect(gatePage.locator('#gate-status')).toContainText('GitHub gate off: auth not configured');
    gateReport.unconfigured = { ...unconfigured.gate, ...(await viewNow()) };

    const revoked = await gateWith({ sub: 'revoked', friend: true });
    expect(revoked.gate.mode, '401 -> signed out').toBe('anon');
    expect(revoked.storedToken, 'a 401 drops the token').toBeNull();
    await expect(gatePage.locator('#app')).toHaveAttribute('data-view', 'gate');
    gateReport.revoked = { ...revoked.gate, ...(await viewNow()) };

    const expired = await gateWith({ sub: 'allowed-ci', friend: true, exp: Math.floor(Date.now() / 1000) - 60 });
    expect(expired.gate.mode, 'expired token -> signed out').toBe('anon');
    expect(expired.gate.reason).toMatch(/expired/);
    expect(expired.storedToken).toBeNull();
    gateReport.expired = { ...expired.gate, ...(await viewNow()) };

    // The Sign out button on the gate screen.
    await gateWith({ sub: 'denied-ci', friend: false });
    await expect(gatePage.locator('#github-signout')).toBeVisible();
    await gatePage.click('#github-signout');
    await expect(gatePage.locator('#github-signin')).toBeVisible();
    const afterSignout = await gatePage.evaluate(() => chrome.storage.local.get('github'));
    expect(afterSignout.github, 'sign out removes the token').toBeUndefined();
    gateReport.signout = await viewNow();
    gateReport.authCalls = authCalls.slice();
    console.log(`gate: ${JSON.stringify(gateReport)}`);
    expect(authCalls.filter((c) => c.path === '/melodica/auth/me').length, 'the fake /auth/me was asked').toBeGreaterThanOrEqual(6);
    report.gate = gateReport;
    step('github gate');
    await gatePage.close();

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
    await options.close();

    // 2. Popup as a tab: login, stations.
    const popup = await context.newPage();
    await popup.setViewportSize(POPUP);
    watch(popup, 'popup');
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
    await expect(popup.locator('#login-email')).toBeVisible();
    // A non-default endpoint turns the gate off, and the popup says so.
    await expect(popup.locator('#gate-status')).toContainText('GitHub gate off: endpoint is');
    report.gate.off = await popup.evaluate(() => document.getElementById('gate-status').textContent);
    // The update banner: the fake releases.json names 99.0.0, newer than any build.
    await expect(popup.locator('#update-banner')).toBeVisible({ timeout: 20_000 });
    await expect(popup.locator('#update-text')).toHaveText(`melodica ${FAKE_VERSION} is available`);
    await expect(popup.locator('#update-link')).toHaveAttribute('href', 'https://spacegho.st/extensions/#melodica-extension');
    const upd = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'update' }).then((r) => r.update));
    expect(upd.latest).toBe(FAKE_VERSION);
    expect(upd.feed).toBe('https://spacegho.st/extensions/releases.json');
    // An unpacked load has no update_url to fetch from, so no Reload button here.
    expect(await popup.locator('#update-reload').count(), 'no Reload button without a fetched update').toBe(0);
    report.update = { ...upd, feedCalls: feedCalls.slice() };
    console.log(`update: ${JSON.stringify(report.update)}`);
    step('update banner');
    await popup.screenshot({ path: shot('login') });

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
    await popup.screenshot({ path: shot('stations') });

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
    await popup.screenshot({ path: shot('playing') });
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
    await player.close();
    const p3 = await probe();
    await new Promise((ok) => setTimeout(ok, 3000));
    const p4 = await probe();
    console.log(`player tab closed: ${JSON.stringify(p3)} -> ${JSON.stringify(p4)}`);
    expect(p4.status, 'still playing after the player tab closed').toBe('playing');
    // The tuner's fixture tracks are short: the next track starting also counts as progress.
    expect(p4.title !== p3.title || p4.position > p3.position + 1, `playback advanced after the tab closed (${p3.title}@${p3.position} -> ${p4.title}@${p4.position})`).toBe(true);
    report.audio.playerTab = { title: now.title, progressShown: shown, afterClose: p4 };
    await popup2.close();
    step('player tab optional');

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
          states.push({ status: d.state.status, position: d.state.position, title: d.state.track && d.state.track.title, audioUrl: !!(d.state.track && d.state.track.audioUrl), historyUrls: (d.state.history || []).filter((h) => h.audioUrl).length, stations: Array.isArray(d.state.stations) ? d.state.stations.length : -1, loggedIn: d.state.loggedIn, gate: d.state.gate && d.state.gate.mode });
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
    expect(remote.results.every((r) => r.ok && !r.audioUrl), 'both commands succeeded').toBe(true);
    expect(remote.states.some((s) => s.status === 'paused'), 'the page paused the music').toBe(true);
    expect(remote.states[remote.states.length - 1].status, 'the page resumed it').toBe('playing');
    expect([bgNow, remote.states[remote.states.length - 1].title], 'the page saw the background track').toContain(remote.states[0].title);
    report.bridge.remote = { backgroundTrack: bgNow, states: remote.states.length, paused: true, resumed: true, results: remote.results, first: remote.states[0] };
    step('bridge remote');

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
    const consoleErrors = evidence.console.filter((l) => /:error\]/.test(l) && !/relay|HTTP 4|melodica\/api/.test(l));
    expect(consoleErrors, 'console errors (extension pages)').toEqual(consoleErrors.filter((l) => l.startsWith('[web:')));

    report.ok = true;
    report.summary = `melodica-extension ${report.extension.version} (unpacked, ${report.browser}${report.engine && report.engine !== report.browser ? `, ${report.engine}` : ''}) pointed at melodica-tuner ${tuner.version} ` +
      `via the options page, signed in from the popup, listed ${names.length} stations, played "${now.title}" by ${now.artist} on ${now.station} ` +
      `in the background (offscreen document; no player tab; position ${p1.position.toFixed(1)}s -> ${p2.position.toFixed(1)}s with no extension page open; the optional player tab showed it and its closing changed nothing), ` +
      `and bridged a partnerLogin for the melodica-web page on https://${WEB_HOST}, which then subscribed, paused and resumed the music over the bridge; ` +
      `the GitHub gate showed its screen with Pandora's endpoint, let an allowed token through, refused a denied token, went off on a 503, signed out on a 401 and on expiry (fake /auth/me); the update banner announced ${FAKE_VERSION} from the fake releases.json`;
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
