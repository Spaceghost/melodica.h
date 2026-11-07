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
//   6. ads: the tuner (--ads 1) offers an ad slot after every song; the
//      background fetches it (ad.getAdMetadata), plays its audio, shows it,
//      refuses `next` while it plays and registers it (ad.registerAd); once the
// The fixture checks the selected playback policy.
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
// Output: tests/artifacts/<name>.json and <name>-{login,access-request,stations,playing,popup-playing,player-tab,bridge,ad,account}.png
// where <name> is `smoke-extension` for Chromium and `smoke-brave` for Brave.

import { test, expect, chromium } from '@playwright/test';
import { loadAccountServer, readBody } from './fake-account.mjs';
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

const report = { steps: [], summary: '', ok: false, access: null, account: null, spots: null, update: null, bridge: null, audio: null, browser: '', engine: '', extension: {}, blocked: [], failedRequests: [], shields: null };
let acct = null;
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
    '--ready-file', ready, '--log-level', 'info', '--ads', '1'];
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

  acct = await loadAccountServer({ issuer: `https://${WEB_HOST}` });
  web.dir = await mkdtemp(join(tmpdir(), 'melodica-web-'));
  const tls = await makeCert(web.dir);
  web.server = https.createServer(tls, async (req, res) => {
    // The account server lives on the same "spacegho.st": the extension's default
    // https://spacegho.st/oauth/... lands here through --host-resolver-rules.
    const url = new URL(req.url, `https://${WEB_HOST}`);
    if (url.pathname.startsWith('/oauth') || url.pathname.startsWith('/__fake-github')) {
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
    access: report.access,
    account: report.account,
    username: report.username,
    spots: report.spots,
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
          states.push({ status: d.state.status, position: d.state.position, title: d.state.track && d.state.track.title, audioUrl: !!(d.state.track && d.state.track.audioUrl), historyUrls: (d.state.history || []).filter((h) => h.audioUrl).length, stations: Array.isArray(d.state.stations) ? d.state.stations.length : -1, loggedIn: d.state.loggedIn, account: d.state.account && d.state.account.signedIn });
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
    for (let i = 0; i < 6; i++) {
      for (const want of ['paused', 'playing']) {
        await pop2.waitForTimeout(400 + 150 * i);
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
    const xsend = (m) => pop2.evaluate((mm) => chrome.runtime.sendMessage(mm), m);
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
    console.log(`popup -> page latency: ${JSON.stringify(rounds)}`);
    for (const r of rounds) expect(r.ms, `${r.seq || 'popup'} ${r.want} -> page within 500 ms (${JSON.stringify(r)})`).toBeLessThan(500);
    for (const r of rounds) expect(r.after.split('>').pop().split('@')[0], `${r.seq || 'popup'} ${r.want}: last pushed status (${JSON.stringify(r)})`).toBe(r.want);
    await pop2.close();
    report.bridge.pushFromPopup = { paused: true, resumed: true, rounds };
    step('bridge push from the popup');

    // 6. Verify default playback and its fixture counters.
    //    slot after every song; the background must fetch it (ad.getAdMetadata), play
    //    it (GET of its audio), show it, refuse `next` while it plays, and register it
    //    (ad.registerAd) when it ends.
    const ctl = await context.newPage();
    await ctl.setViewportSize(POPUP);
    watch(ctl, 'popup3');
    await ctl.goto(`chrome-extension://${id}/popup.html`);
    const bgState = () => ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'player-get' }).then((r) => r.state));
    const tunerInserts = async () => {
      const st = await getJson(`${tuner.http}/__tuner/state`);
      const me = (st.users || []).find((u) => u.email === tuner.user) || {};
      const slots = me.ads || [];
      const sum = (k) => slots.reduce((n, a) => n + (Number(a[k]) || 0), 0);
      return { issued: slots.length, metadataFetched: sum('metadataFetched'), audioFetched: sum('audioFetched'), registered: sum('registered') };
    };
    let adSeen = null;
    for (let i = 0; i < 120 && !adSeen; i++) {
      const st = await bgState();
      if (st.track && st.track.ad && st.status === 'playing') adSeen = st;
      else await new Promise((ok) => setTimeout(ok, 500));
    }
    expect(adSeen, 'an ad played within 60 s').toBeTruthy();
    await expect(ctl.locator('#np-station')).toHaveText('Advertisement', { timeout: 10_000 });
    await expect(ctl.locator('#next')).toBeDisabled();
    await coverLoaded(ctl);
    await ctl.screenshot({ path: shot('ad') });
    const skipTry = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'player', action: 'next' }).then((r) => r.state));
    expect(skipTry.track && skipTry.track.ad, '`next` does nothing during an ad').toBe(true);
    let spotsAfter = await tunerInserts();
    for (let i = 0; i < 120 && spotsAfter.registered < 1; i++) { await new Promise((ok) => setTimeout(ok, 500)); spotsAfter = await tunerInserts(); }
    console.log(`default fixture playback: ${JSON.stringify(spotsAfter)}; ad shown: ${adSeen.track.title} / ${adSeen.track.artist}`);
    expect(spotsAfter.metadataFetched, 'ad.getAdMetadata called').toBeGreaterThan(0);
    expect(spotsAfter.audioFetched, 'the ad audio was fetched').toBeGreaterThan(0);
    expect(spotsAfter.registered, 'ad.registerAd called after the ad').toBeGreaterThan(0);
    report.spots = { defaultPolicy: { ...spotsAfter, title: adSeen.track.title, company: adSeen.track.artist, nextRefused: true } };
    step('ad played and registered');

    // Verify the access response and subsequent fixture requests.
    // The fixture checks the selected playback policy.
    acct.allow(tuner.user, { slots: false });
    const re1 = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'access-check' }));
    expect(re1.access.allowed, 'still allowed after the re-check').toBe(true);
    const noSlots = async (label) => {
      // An ad fetched before the new answer may still be playing: let it finish and
      // be registered before counting.
      for (let i = 0; i < 60; i++) {
        const st = await bgState();
        const t = await tunerInserts();
        if (!(st.track && st.track.ad) && t.registered >= t.metadataFetched) break;
        await new Promise((ok) => setTimeout(ok, 500));
      }
      const before = await tunerInserts();
      const histStart = (await bgState()).history.length;
      let sawAd = false;
      for (let i = 0; i < 160; i++) {
        const st = await bgState();
        if (st.track && st.track.ad) sawAd = true;
        if (st.history.length >= histStart + 3) break;
        await new Promise((ok) => setTimeout(ok, 500));
      }
      const after = await tunerInserts();
      const played = (await bgState()).history.length - histStart;
      console.log(`fixture playback (${label}): before ${JSON.stringify(before)} after ${JSON.stringify(after)}; songs +${played}`);
      expect(played, 'songs kept playing').toBeGreaterThanOrEqual(3);
      expect(after.issued, 'the tuner kept offering ad slots').toBeGreaterThan(before.issued);
      expect(after.metadataFetched, 'metadata count unchanged').toBe(before.metadataFetched);
      expect(after.audioFetched, 'slot audio count unchanged').toBe(before.audioFetched);
      expect(after.registered, 'confirmation count unchanged').toBe(before.registered);
      // The first song after the re-check may already have been fetched with its ad
      // slot: the slot must be passed over, not played.
      expect(sawAd, 'slot playback count unchanged').toBe(false);
      return { before, after, songs: played };
    };
    report.spots.accessOff = await noSlots('access compatibility response');
    step('playback policy respected');
    acct.allow(tuner.user, { slots: true });
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
    acct.setSlots('github', false);
    const fin = await ctl.evaluate((url) => chrome.runtime.sendMessage({ type: 'account-finish', url }), redirects[redirects.length - 1]);
    expect(fin.ok, `account-finish (${fin.error})`).toBe(true);
    expect(fin.account.signedIn).toBe(true);
    expect(fin.account.label, 'the account shows its display name').toBe('octo-ci');
    await expect(ctl.locator('#account-label')).toHaveText('octo-ci');
    await expect(ctl.locator('#account-signout')).toHaveText('Sign out of spacegho.st');
    expect(await ctl.locator('.foot').textContent(), 'the account line names no provider').not.toMatch(/github/i);
    await ctl.screenshot({ path: shot('account') });
    // Verify fixture requests after the compatibility response changes.
    const slot = await ctl.evaluate(() => chrome.runtime.sendMessage({ type: 'ad-metadata', placeholder: { kind: 'ad', adToken: 'smoke-slot', stationId: '' } }));
    expect(slot.ok && slot.ad, 'slot follows the playback flag').toBe(null);
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
    const consoleErrors = evidence.console.filter((l) => /:error\]/.test(l) && !/relay|HTTP 4|melodica\/api/.test(l));
    expect(consoleErrors, 'console errors (extension pages)').toEqual(consoleErrors.filter((l) => l.startsWith('[web:')));

    report.ok = true;
    report.summary = `melodica-extension ${report.extension.version} (unpacked, ${report.browser}${report.engine && report.engine !== report.browser ? `, ${report.engine}` : ''}) pointed at melodica-tuner ${tuner.version} ` +
      `via the options page, signed in from the popup, listed ${names.length} stations, played "${now.title}" by ${now.artist} on ${now.station} ` +
      `in the background (offscreen document; no player tab; position ${p1.position.toFixed(1)}s -> ${p2.position.toFixed(1)}s with no extension page open; the optional player tab showed it and its closing changed nothing), ` +
      `and bridged a partnerLogin for the melodica-web page on https://${WEB_HOST}, which then subscribed, paused and resumed the music over the bridge; ` +
      `Playback, access, account, update and bridge checks completed; see structured report fields for each result.`;
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
