// Proof of the built Firefox extension (dist/firefox) in a real Mozilla Firefox,
// driven through geckodriver with selenium-webdriver (Playwright's Firefox build
// cannot load extensions). Two parts:
//
//   0. the spacegho.st account server is a local fake (tests/fake-account.mjs):
//      Firefox has no host-resolver flag, so the extension's `accountBase`
//      storage key points it there;
//   1. against melodica-tuner, like the Chromium and Brave smokes: the options
//      page points the extension at the tuner, the popup (opened as a tab)
//      signs in, lists the fixture's stations, starts one; no tab opens, the
//      background page plays it, and after 45 s with no extension page open
//      at all the state must still be playing with the position advanced; the
//      optional player tab shows the same track and closing it stops nothing;
//      the tuner (--ads 1) offers a slot after every song, and the
//      background must fetch, play and register one, refusing `next` during it;
//   2. against the real tuner.pandora.com, with no account: the endpoint is
//      reset to Pandora and bogus credentials are submitted. Pandora answers
//      auth.userLogin with code 1002 when the request framing (auth_token
//      query, Blowfish envelope, syncTime) is right; the popup must say so
//      ("Pandora rejected auth.userLogin (code 1002: invalid login). Wrong
//      email address or password."), not report 1001 "session expired".
//
// Along the way the report records what Firefox granted the temporary add-on
// (browser.permissions.getAll), whether storage.session exists, the manifest's
// background shape and the background log (the options page's diagnostics).
//
// Environment: TUNER_HTTPS_URL / TUNER_HTTP_URL / TUNER_USER / TUNER_PASSWORD
// (the Spaceghost/melodica-tuner action's outputs) or MELODICA_TUNER_DIR to
// start a checkout here; MELODICA_EXT_DIST (default dist/firefox);
// MELODICA_FIREFOX (binary, default: firefox on PATH); GECKODRIVER (default: geckodriver on PATH); MELODICA_HEADLESS=0 for
// a window; MELODICA_SKIP_REAL=1 skips part 2.
// Output: tests/artifacts/smoke-firefox.json and smoke-firefox-{login,access-request,stations,playing,popup-playing,player-tab,slot,account,real-pandora}.png
import { Builder, By, until } from 'selenium-webdriver';
import { startAccountServer } from './fake-account.mjs';
import firefox from 'selenium-webdriver/firefox.js';
import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import net from 'node:net';
import { readFile, mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const EXT = resolve(process.env.MELODICA_EXT_DIST || resolve(root, 'dist/firefox'));
const ARTIFACTS = resolve(here, 'artifacts');
const TUNER_DIR = process.env.MELODICA_TUNER_DIR || resolve(root, '..', 'melodica-tuner');
const NAME = 'smoke-firefox';
const UUID = '6d656c6f-6469-4361-8666-666f78000001'; // any UUID; pinned through extensions.webextensions.uuids
const GECKO_ID = 'melodica-extension@spacegho.st';
const BOGUS = { email: 'nobody@example.com', password: 'wrong-password' };
const shot = (what) => resolve(ARTIFACTS, `${NAME}-${what}.png`);

const tuner = {
  https: process.env.TUNER_HTTPS_URL || '',
  http: process.env.TUNER_HTTP_URL || '',
  user: process.env.TUNER_USER || 'test@example.com',
  password: process.env.TUNER_PASSWORD || 'test',
  version: '', proc: null, dir: null,
};
const haveTuner = !!tuner.https || existsSync(join(TUNER_DIR, 'tuner', '__main__.py'));
if (!haveTuner) { console.error('no tuner: set TUNER_HTTPS_URL/TUNER_HTTP_URL or MELODICA_TUNER_DIR'); process.exit(2); }

const report = {
  ok: false, platform: 'firefox', browser: '', engine: '', summary: '', when: '', steps: [], tuner: '',
  extension: {}, permissions: null, sessionStorage: null, background: null, access: null, account: null, spots: null, audio: null, coldStart: null,
  realPandora: null, log: [], errors: [],
};
const step = (s) => { if (!report.steps.includes(s)) report.steps.push(s); console.log(`step: ${s}`); };
const check = (cond, what) => { if (!cond) throw new Error(`check failed: ${what}`); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const getJson = async (url) => { const res = await fetch(url); if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`); return res.json(); };

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
  for (let i = 0; i < 120 && !existsSync(ready); i++) await sleep(500);
  if (!existsSync(ready)) throw new Error(`tuner did not become ready:\n${out.join('')}`);
  const lines = (await readFile(ready, 'utf8')).trim().split('\n');
  tuner.https = lines[0].trim();
  tuner.http = lines[1].trim();
  console.log(`tuner started: ${tuner.https} ${tuner.http}`);
}

function firefoxVersion(bin) {
  try { return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n')[0]; }
  catch (e) { return `${bin} --version failed: ${String(e.message).split('\n')[0]}`; }
}

// WebDriver refuses `driver.get` on moz-extension:// URLs ("not allowed in this
// context"), so extension pages are loaded from Firefox's chrome context into the
// selected tab with the system principal, then driven as content.
async function goExt(driver, url) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    await driver.executeScript((u) => {
      const win = Services.wm.getMostRecentWindow('navigator:browser') || window;
      win.gBrowser.selectedBrowser.loadURI(Services.io.newURI(u), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    }, url);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
  await waitFor(driver, async () => (await driver.getCurrentUrl()).startsWith(url) ? true : null, `navigation to ${url}`, 20_000, 200);
}

// Run `body` (an async function source taking a callback) inside an extension page.
async function inPage(driver, body) {
  return driver.executeAsyncScript(`const done = arguments[arguments.length - 1];
    (async () => { ${body} })().then((v) => done({ value: v }), (e) => done({ error: String(e && e.message || e) }));`);
}
async function ask(driver, message) {
  const r = await inPage(driver, `return await browser.runtime.sendMessage(${JSON.stringify(message)});`);
  if (r.error) throw new Error(`sendMessage ${message.type}: ${r.error}`);
  return r.value;
}
async function waitFor(driver, fn, what, timeout = 30_000, poll = 500) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(poll);
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${what} (last: ${JSON.stringify(last)})`);
}
const loginOutcome = (driver) => driver.executeScript(() => ({
  view: document.getElementById('app')?.dataset.view || '',
  message: document.getElementById('login-message')?.textContent || '',
  error: /error/.test(document.getElementById('login-message')?.className || ''),
}));
async function loginAndWait(driver, email, password) {
  await driver.wait(until.elementLocated(By.css('#login-email')), 30_000);
  await driver.findElement(By.css('#login-email')).clear();
  await driver.findElement(By.css('#login-email')).sendKeys(email);
  await driver.findElement(By.css('#login-password')).clear();
  await driver.findElement(By.css('#login-password')).sendKeys(password);
  await driver.findElement(By.css('#login-button')).click();
  return waitFor(driver, async () => { const o = await loginOutcome(driver); return o.view === 'player' || o.error ? o : null; }, 'login outcome', 90_000);
}
async function screenshot(driver, what) {
  await writeFile(shot(what), Buffer.from(await driver.takeScreenshot(), 'base64'));
}
async function diagnostics(driver, ext) {
  await goExt(driver, `${ext}/options.html`);
  await driver.wait(until.elementLocated(By.css('#copy-diagnostics')), 30_000);
  await driver.findElement(By.css('#copy-diagnostics')).click();
  await driver.wait(until.elementLocated(By.css('#diagnostics')), 30_000);
  const text = await driver.findElement(By.css('#diagnostics')).getAttribute('value');
  return text.split('\n');
}

// The web app's origin for the bridge checks: a local https server answers for
// https://spacegho.st/melodica/app/, reached through a CONNECT proxy that sends only
// spacegho.st:443 there (everything else, e.g. tuner.pandora.com, goes direct).
const WEB_HOST = 'spacegho.st';
const APP_PAGE = `<!doctype html><meta charset="utf-8"><title>melodica (smoke page)</title>
<script>window.__ext=[];addEventListener('message',function(ev){var d=ev.data;if(ev.source===window&&d&&d.melodica===1&&['present','ready','state','result'].indexOf(d.type)>=0)window.__ext.push({type:d.type,id:d.id,ok:d.ok,error:d.error,rooms:d.rooms,state:d.state,at:performance.now()});});</script>
<p>smoke page</p>`;
const web = { server: null, proxy: null, port: 0, proxyPort: 0, dir: null };
async function startWeb() {
  web.dir = await mkdtemp(join(tmpdir(), 'melodica-web-'));
  const key = join(web.dir, 'key.pem'); const cert = join(web.dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '2', '-subj', `/CN=${WEB_HOST}`, '-addext', `subjectAltName=DNS:${WEB_HOST}`], { stdio: 'ignore' });
  web.server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    if (!req.url.startsWith('/melodica/')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(APP_PAGE);
  });
  await new Promise((ok) => web.server.listen(0, '127.0.0.1', ok));
  web.port = web.server.address().port;
  web.proxy = net.createServer((client) => {
    client.once('data', (head) => {
      const m = /^CONNECT ([^:\s]+):(\d+) HTTP/.exec(String(head));
      if (!m) { client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); return; }
      const [host, port] = m[1] === WEB_HOST ? ['127.0.0.1', web.port] : [m[1], Number(m[2])];
      const up = net.connect(port, host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(client); client.pipe(up); });
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
    });
  });
  await new Promise((ok) => web.proxy.listen(0, '127.0.0.1', ok));
  web.proxyPort = web.proxy.address().port;
  console.log(`web page server 127.0.0.1:${web.port}, proxy 127.0.0.1:${web.proxyPort}`);
}

// Chrome-context helpers: reload the add-on (what a browser restart does to a
// temporary add-on's background, storage.local and IndexedDB kept) or stop its
// background page (what Firefox does to an idle event page).
async function inChrome(driver, fn, ...args) {
  await driver.setContext(firefox.Context.CHROME);
  try { return await driver.executeAsyncScript(fn, ...args); } finally { await driver.setContext(firefox.Context.CONTENT); }
}
async function reloadAddon(driver) {
  return inChrome(driver, function (id) {
    const done = arguments[arguments.length - 1];
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    AddonManager.getAddonByID(id).then((a) => a.reload()).then(() => done('reloaded'), (e) => done(`reload failed: ${e}`));
  }, GECKO_ID);
}
async function stopBackground(driver) {
  return inChrome(driver, function (id) {
    const done = arguments[arguments.length - 1];
    try {
      const ext = WebExtensionPolicy.getByID(id).extension;
      Promise.resolve(ext.terminateBackground({ ignoreDevToolsAttached: true })).then(() => done('terminated'), (e) => done(`terminate failed: ${e}`));
    } catch (e) { done(`terminate failed: ${e}`); }
  }, GECKO_ID);
}

let driver = null;
let fakeAuth = null;
const bin = process.env.MELODICA_FIREFOX || 'firefox';
try {
  await mkdir(ARTIFACTS, { recursive: true });
  fakeAuth = await startAccountServer();
  console.log(`fake account server: ${fakeAuth.base}`);
  if (!tuner.https) await startTuner();
  if (!tuner.http) throw new Error('TUNER_HTTP_URL is required alongside TUNER_HTTPS_URL');
  const health = await getJson(`${tuner.http}/__tuner/health`);
  tuner.version = String(health.version || '');
  report.tuner = tuner.version;
  await fetch(`${tuner.http}/__tuner/reset`, { method: 'POST' });

  const manifest = JSON.parse(await readFile(resolve(EXT, 'manifest.json'), 'utf8'));
  check(manifest.browser_specific_settings?.gecko?.id === GECKO_ID, `dist manifest gecko id ${GECKO_ID}`);
  report.background = manifest.background;
  report.browser = firefoxVersion(bin);
  console.log(`browser: ${report.browser}`);

  const options = new firefox.Options().setBinary(bin);
  if (process.env.MELODICA_HEADLESS !== '0') options.addArguments('-headless');
  await startWeb();
  options.setPreference('network.proxy.type', 1);
  options.setPreference('network.proxy.ssl', '127.0.0.1');
  options.setPreference('network.proxy.ssl_port', web.proxyPort);
  options.setPreference('network.proxy.no_proxies_on', 'localhost, 127.0.0.1');
  options.setAcceptInsecureCerts(true); // the tuner's throwaway certificate, in pages and in the extension's fetch
  options.setPreference('extensions.webextensions.uuids', JSON.stringify({ [GECKO_ID]: UUID })); // fixed moz-extension:// origin
  options.setPreference('xpinstall.signatures.required', false);
  options.setPreference('extensions.webextensions.remote', true);
  options.setPreference('media.autoplay.default', 0);
  options.setPreference('media.autoplay.blocking_policy', 0);
  options.setPreference('media.autoplay.allow-extension-background-pages', true);
  options.setPreference('dom.webnotifications.enabled', false);
  options.setPreference('browser.shell.checkDefaultBrowser', false);
  options.setPreference('datareporting.policy.dataSubmissionEnabled', false);
  options.setPreference('app.update.enabled', false);
  options.setPreference('extensions.getAddons.cache.enabled', false);
  // Keep the add-on's console messages (not readable through WebDriver; the diagnostics ring is).
  options.setPreference('devtools.console.stdout.content', true);
  // geckodriver from PATH (or GECKODRIVER), not selenium-manager's download. Firefox
  // inherits the environment; the chrome-context loads in goExt need system access.
  process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1';
  const service = new firefox.ServiceBuilder(process.env.GECKODRIVER || 'geckodriver');
  driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  const caps = await driver.getCapabilities();
  report.engine = `${caps.get('browserName')} ${caps.get('browserVersion')} (${caps.get('platformName')})`;
  console.log(`webdriver: ${report.engine}; geckodriver ${caps.get('moz:geckodriverVersion') || ''}`);

  const addonId = await driver.installAddon(EXT, true);
  console.log(`installed temporary add-on ${addonId} from ${EXT}`);
  check(addonId === GECKO_ID, `installAddon returned ${addonId}`);
  const ext = `moz-extension://${UUID}`;
  report.extension = { id: addonId, uuid: UUID, version: manifest.version, name: manifest.name, temporary: true };
  step('extension loaded');

  // What Firefox granted the temporary add-on, before anything asks for more.
  await goExt(driver, `${ext}/options.html`);
  await driver.wait(until.elementLocated(By.css('#endpoint')), 30_000);
  const env = await inPage(driver, `return {
    permissions: await browser.permissions.getAll(),
    sessionStorage: typeof browser.storage.session,
    runtimeUrl: browser.runtime.getURL(''),
    ping: await browser.runtime.sendMessage({ type: 'ping' }),
  };`);
  if (env.error) throw new Error(`options page environment: ${env.error}`);
  report.permissions = env.value.permissions;
  report.sessionStorage = env.value.sessionStorage;
  console.log(`permissions: ${JSON.stringify(env.value.permissions)}; storage.session: ${env.value.sessionStorage}; runtime url ${env.value.runtimeUrl}; ping ${JSON.stringify(env.value.ping)}`);
  check(env.value.runtimeUrl === `${ext}/`, 'runtime.getURL matches the fixed UUID');
  check(env.value.ping && env.value.ping.ok, 'background answers ping');
  const origins = env.value.permissions.origins || [];
  check(origins.some((o) => o === 'https://tuner.pandora.com/*' || o === 'https://*.pandora.com/*'), `host permission for tuner.pandora.com granted at install (origins: ${origins.join(' ')})`);
  check(Array.isArray(manifest.background.scripts) && manifest.background.scripts.includes('bg.js'), 'background is an event page (scripts)');
  step('host permission granted');

  // 0. The account server is the local fake.
  const setBase = await inPage(driver, `await browser.storage.local.set({ accountBase: ${JSON.stringify(fakeAuth.base)} }); return (await browser.storage.local.get('accountBase')).accountBase;`);
  check(setBase.value === fakeAuth.base, `accountBase override stored (${JSON.stringify(setBase)})`);
  step('account server set');

  // 1. Options: point at the tuner.
  await goExt(driver, `${ext}/options.html`);
  await driver.wait(until.elementLocated(By.css('#endpoint')), 30_000);
  const endpointInput = await driver.findElement(By.css('#endpoint'));
  await endpointInput.clear();
  await endpointInput.sendKeys(`${tuner.https}/services/json/`);
  await driver.findElement(By.css('#save')).click();
  await driver.wait(until.elementTextContains(driver.findElement(By.css('#options-message')), 'Saved'), 20_000);
  const effective = await waitFor(driver, async () => { const s = await ask(driver, { type: 'state' }); return s.settings.endpoint === `${tuner.https}/services/json/` ? s.settings.endpoint : null; }, 'background endpoint', 20_000);
  console.log(`background endpoint: ${effective}`);
  step('endpoint set');

  // 2. Popup as a tab: login, stations.
  await goExt(driver, `${ext}/popup.html`);
  await waitFor(driver, async () => (await loginOutcome(driver)).view === 'login', 'login view');
  step('login screen');
  await screenshot(driver, 'login');
  // Access: an email not on the allow-list is not logged in, and Pandora is not asked.
  check((await driver.findElements(By.css('#access-note'))).length === 0, 'no login note');
  const refusedLogin = await loginAndWait(driver, tuner.user, tuner.password);
  const userLogins = async () => (await getJson(`${tuner.http}/__tuner/log`)).filter((e) => e.method === 'auth.userLogin').length;
  check(refusedLogin.view === 'login' && refusedLogin.message === 'melodica access is by allow-list. Your request has been sent.', `not on the list: not logged in (${JSON.stringify(refusedLogin)})`);
  check((await userLogins()) === 0, 'no auth.userLogin for an email not on the list');
  check(fakeAuth.requests.length === 1 && fakeAuth.requests[0].email === tuner.user.toLowerCase() && fakeAuth.requests[0].client === 'extension', `the access check was asked (${JSON.stringify(fakeAuth.requests)})`);
  await screenshot(driver, 'access-request');
  report.access = { notListed: { message: refusedLogin.message, userLogin: 0 } };
  step('not on the allow-list: not logged in');
  fakeAuth.allow(tuner.user);
  const outcome = await loginAndWait(driver, tuner.user, tuner.password);
  console.log(`login outcome: ${JSON.stringify(outcome)}`);
  check(outcome.view === 'player', `logged in (message: "${outcome.message}")`);
  step('logged in');

  await driver.wait(until.elementLocated(By.css('#station-list button.station')), 30_000);
  const names = (await Promise.all((await driver.findElements(By.css('#station-list button.station'))).map((e) => e.getText()))).map((t) => t.trim());
  console.log(`stations: ${names.join(' | ')}`);
  const state = await getJson(`${tuner.http}/__tuner/state`);
  const me = (state.users || []).find((u) => u.email === tuner.user) || {};
  const expected = (me.stations || []).map((s) => s.stationName).filter(Boolean);
  check(expected.length > 0, 'stations known to the tuner for this listener');
  for (const n of expected) check(names.some((x) => x.includes(n)), `station "${n}" from the tuner fixture listed`);
  step('stations listed');
  await screenshot(driver, 'stations');

  // 3. Start a station from the popup. No tab opens: the background page holds
  //    the <audio> element (Firefox has no offscreen documents) and the popup is
  //    a view of its state.
  const before = await driver.getAllWindowHandles();
  const first = (await driver.findElements(By.css('#station-list button.station')))[0];
  const chosen = (await first.getText()).trim();
  await first.click();
  await waitFor(driver, async () => (await driver.executeScript(() => document.getElementById('app')?.dataset.status || '')) === 'playing' ? true : null, 'playing status in the popup', 45_000);
  const now = await driver.executeScript(() => ({
    title: document.getElementById('np-title')?.textContent.trim(),
    artist: document.getElementById('np-artist')?.textContent.trim(),
    station: document.getElementById('np-station')?.textContent.trim(),
  }));
  check(now.title && !/^Pick a station$/.test(now.title), `popup shows a track (${now.title})`);
  check(now.station.includes(chosen), `popup shows the chosen station (${now.station} vs ${chosen})`);
  console.log(`now playing: ${now.title} – ${now.artist} on ${now.station}`);
  check((await driver.getAllWindowHandles()).length === before.length, 'no tab opened by starting a station');
  const playerState = async () => { const r = await ask(driver, { type: 'player-get' }); if (!r || !r.ok) throw new Error(`player-get: ${r && r.error}`); return r.state; };
  const st1 = await playerState();
  check(st1.status === 'playing', `background state playing (${st1.status} ${st1.error})`);
  check(st1.track && st1.track.title === now.title, 'background state names the shown track');
  check(st1.track && /\/audio\//.test(st1.track.audioUrl), 'the track came from the tuner');
  await screenshot(driver, 'playing');
  step('playing without a tab');

  // Leave the extension entirely: this tab goes to about:blank, so no extension page
  // exists for 45 s (longer than Firefox's 30 s event-page idle timeout). Back in a
  // popup, the background must still be playing and the position must have advanced
  // by about that long (or the track ended and the next one is playing).
  const NO_PAGE_MS = 45_000;
  await driver.get('about:blank');
  await sleep(NO_PAGE_MS);
  await goExt(driver, `${ext}/popup.html`);
  const st2 = await playerState();
  const advanced = st2.track && st1.track && st2.track.trackToken === st1.track.trackToken
    ? st2.position - st1.position
    : null;
  console.log(`after ${NO_PAGE_MS / 1000}s with no page: ${JSON.stringify({ status: st2.status, position: st2.position, title: st2.track && st2.track.title, advanced, history: (st2.history || []).length })}`);
  check(st2.status === 'playing', `still playing with no page open (${st2.status} ${st2.error})`);
  check(advanced === null ? (st2.history || []).length > (st1.history || []).length : advanced >= NO_PAGE_MS / 1000 - 8, `position advanced with no page open (${advanced === null ? 'next track' : advanced.toFixed(1) + 's'})`);
  await waitFor(driver, async () => (await driver.executeScript(() => document.getElementById('np-title')?.textContent.trim() || '')) === (st2.track && st2.track.title) ? true : null, 'popup shows the current track');
  await screenshot(driver, 'popup-playing');
  report.audio = { ...now, engine: 'background page', noPage: { seconds: NO_PAGE_MS / 1000, before: { status: st1.status, position: st1.position, title: st1.track.title }, after: { status: st2.status, position: st2.position, title: st2.track && st2.track.title }, advanced } };
  step('plays 45 s with no page open');

  // The player tab is optional: opened from the popup it shows the same track and holds
  // no <audio>; closing it stops nothing.
  const popupHandle = await driver.getWindowHandle();
  const handlesBefore = await driver.getAllWindowHandles();
  await driver.findElement(By.css('#open-player')).click();
  const handles = await waitFor(driver, async () => { const h = await driver.getAllWindowHandles(); return h.length > handlesBefore.length ? h : null; }, 'player tab');
  const playerHandle = handles.find((h) => !handlesBefore.includes(h));
  await driver.switchTo().window(playerHandle);
  await waitFor(driver, async () => (await driver.getCurrentUrl()).startsWith(`${ext}/player.html`) ? true : null, 'player url');
  const st3 = await playerState();
  await waitFor(driver, async () => (await driver.executeScript(() => document.getElementById('np-title')?.textContent.trim() || '')) === (st3.track && st3.track.title) ? true : null, 'player tab shows the current track');
  const tabView = await driver.executeScript(() => ({ status: document.getElementById('player-status')?.textContent || '', audio: document.querySelectorAll('#audio').length, progress: Number(document.getElementById('np-progress')?.value || 0) }));
  check(/Playing in the background/.test(tabView.status), `player tab says the music plays in the background (${tabView.status})`);
  check(tabView.audio === 0, 'no audio element in the player tab');
  await waitFor(driver, async () => (await driver.executeScript(() => Number(document.getElementById('np-progress')?.value || 0))) > tabView.progress + 1 ? true : null, 'progress advancing in the player tab', 15_000);
  await screenshot(driver, 'player-tab');
  await driver.close();
  await driver.switchTo().window(popupHandle);
  const st4 = await playerState();
  await sleep(3000);
  // A track boundary right here reads 'loading' for a moment; wait it out.
  const st5 = await waitFor(driver, async () => { const s = await playerState(); return s.status === 'loading' ? null : s; }, 'not loading after the player tab closed', 20_000);
  check(st5.status === 'playing', `still playing after the player tab closed (${st5.status})`);
  check(st5.track.trackToken !== st4.track.trackToken || st5.position > st4.position + 1, 'position advanced after the player tab closed');
  report.audio.playerTab = { title: st3.track && st3.track.title, afterClose: { status: st5.status, position: st5.position } };
  step('player tab optional');

  // Slots (default policy, no account): wait for a slot to play, check the popup shows it
  // and refuses next, then that the tuner saw it fetched, played and registered.
  const tunerSlots = async () => {
    const st = await getJson(`${tuner.http}/__tuner/state`);
    const u = (st.users || []).find((x) => x.email === tuner.user) || {};
    const list = u.ads || [];
    const sum = (k) => list.reduce((n, a) => n + (Number(a[k]) || 0), 0);
    return { issued: list.length, metadataFetched: sum('metadataFetched'), audioFetched: sum('audioFetched'), registered: sum('registered') };
  };
  const slotState = await waitFor(driver, async () => { const s = await playerState(); return s.track && s.track.ad && s.status === 'playing' ? s : null; }, 'a slot playing', 60_000);
  await waitFor(driver, async () => (await driver.executeScript(() => document.getElementById('np-station')?.textContent.trim() || '')) === '' ? true : null, 'popup shows the slot');
  check(await driver.executeScript(() => !!document.getElementById('next')?.disabled), 'next is disabled during the slot');
  await screenshot(driver, 'slot');
  const skipTry = await ask(driver, { type: 'player', action: 'next' });
  check(skipTry.state && skipTry.state.track && skipTry.state.track.ad, '`next` does nothing during a slot');
  const slotsSeen = await waitFor(driver, async () => { const a = await tunerSlots(); return a.registered > 0 ? a : null; }, 'ad.registerAd', 60_000);
  check(slotsSeen.metadataFetched > 0, 'ad.getAdMetadata called');
  check(slotsSeen.audioFetched > 0, 'the slot audio was fetched');
  report.spots = { defaultPolicy: { ...slotsSeen, title: slotState.track.title, company: slotState.track.artist, nextRefused: true } };
  console.log(`slots: ${JSON.stringify(report.spots)}`);
  step('slot played and registered');

  // The access answer says spots:false: after a re-check a slot gets no metadata.
  fakeAuth.allow(tuner.user, { spots:false });
  const re1 = await ask(driver, { type: 'access-check' });
  check(re1.access.allowed === true, 'still allowed after the re-check');
  const metaBefore = (await tunerSlots()).metadataFetched;
  const slot = await ask(driver, { type: 'spot-metadata', placeholder: { kind: 'spot', adToken: 'smoke-slot', stationId: '' } });
  check(slot.spot === null && (await tunerSlots()).metadataFetched === metaBefore, `no metadata for a slot once the answer says spots:false (${JSON.stringify(slot)})`);
  report.spots.accessOff = { slot: slot.spot };
  fakeAuth.allow(tuner.user, { spots:true });
  await ask(driver, { type: 'access-check' });
  step('access answer spots:false: no slot');

  // The optional spacegho.st sign-in: begun in the background, the authorize page
  // loaded in this tab, GitHub chosen there, and the redirect to the extension's
  // https://<uuid>.extensions.allizom.org/oauth address (which does not resolve; the
  // address is read from the tab) handed back.
  const begin = await ask(driver, { type: 'account-begin' });
  check(/^https:\/\/[a-z0-9-]+\.extensions\.allizom\.org\/oauth$/.test(begin.redirectUri), `Firefox redirect address (${begin.redirectUri})`);
  const flowHandle = await driver.getWindowHandle();
  await driver.get(begin.url);
  await driver.wait(until.elementLocated(By.css('#sg-github')), 20_000);
  await driver.findElement(By.css('#sg-github')).click();
  await driver.wait(until.elementLocated(By.css('#gh-octo-ci')), 20_000);
  // The redirect lands on Firefox's DNS error page; geckodriver reports that as an
  // error whose text carries the address (its code is never printed).
  let back = null;
  try {
    await driver.findElement(By.css('#gh-octo-ci')).click();
  } catch (e) {
    const m = /[?&]u=([^&\s]+)/.exec(String(e && e.message || ''));
    if (!m) throw new Error('the GitHub step of the sign-in failed');
    back = decodeURIComponent(m[1]);
  }
  if (!back) back = await waitFor(driver, async () => { const u = await driver.getCurrentUrl(); return u.startsWith(begin.redirectUri) ? u : null; }, 'redirect to the extension', 20_000);
  check(back.startsWith(begin.redirectUri + '?'), 'the sign-in came back to the extension address');
  await goExt(driver, `${ext}/popup.html`);
  const fin = await ask(driver, { type: 'account-finish', url: back });
  check(fin.account.signedIn === true && fin.account.label === 'octo-ci', `signed in to spacegho.st (${fin.account.label})`);
  await waitFor(driver, async () => (await driver.executeScript(() => document.getElementById('account-label')?.textContent || '')) === 'octo-ci' ? true : null, 'account label');
  const foot = await driver.executeScript(() => document.querySelector('.foot')?.textContent || '');
  check(!/github/i.test(foot), 'the account line names no provider');
  await screenshot(driver, 'account');
  const roomId = 'firefoxRoomProbe12345';
  fakeAuth.setRoom(roomId, {
    id: roomId, name: 'Firefox native room', kind: 'public', mode: 'rotation', host: 'host-ci',
    you: 'listener-ci', current_dj: 'host-ci', ready_at: 1, seq: 1, spots: 1, skip_fraction: 0.5,
    scrobble: true, play: null,
    members: [{ account: 'listener-ci', name: 'Firefox listener', role: 'listener', joined_at: 1730000000 }],
    djs: [], waiting: [], requests: [], past: [],
  });
  const joinedRoom = await ask(driver, { type: 'room-join', roomId });
  check(joinedRoom.ok === true && joinedRoom.room?.state?.id === roomId, `Firefox local background Engine joins the room (${JSON.stringify(joinedRoom)})`);
  check(joinedRoom.room.state.members[0].joined_at === 1730000000, 'Firefox room snapshot preserves numeric member joined_at');
  check(fakeAuth.roomCalls.some((call) => call.id === roomId && call.method === 'POST' && call.action === 'join'), 'Firefox RoomEngine joined through its authenticated local backend adapter');
  const leftRoom = await ask(driver, { type: 'room-leave', roomId });
  check(leftRoom.room?.id === null, 'Firefox RoomEngine leaves cleanly');
  report.rooms = { joined: true, left: true, joinedAt: 1730000000, calls: fakeAuth.roomCalls.filter((call) => call.id === roomId) };
  const out = await ask(driver, { type: 'account-signout' });
  check(out.account.signedIn === false && fakeAuth.tokens.revoked > 0, 'signed out; refresh token revoked');
  report.account = { label: fin.account.label, revoked: fakeAuth.tokens.revoked };
  step('spacegho.st sign-in');

  // Cold start: with "remember me" on, the web app page alone finds the extension
  // (present or ready within 1 s), gets a signed-in state with stations and steers
  // playback, after an add-on reload and after the background page was stopped.
  // No extension page is open in either round.
  await goExt(driver, `${ext}/options.html`);
  const relog = await ask(driver, { type: 'login', email: tuner.user, password: tuner.password, remember: true });
  check(relog && relog.ok !== false, `login with remember (${relog && relog.error})`);
  await waitFor(driver, async () => (await inPage(driver, `return !!(await browser.storage.local.get('vault')).vault;`)).value ? true : null, 'sealed remember', 15_000);
  await driver.get('about:blank');
  const coldRound = async (label) => {
    await driver.get(`https://${WEB_HOST}/melodica/app/`);
    const seen = await waitFor(driver, async () => driver.executeScript(() => { const m = window.__ext.find((x) => x.type === 'present' || x.type === 'ready'); return m ? Math.round(m.at) : null; }), `${label}: present/ready`, 5_000, 50);
    const roomCapability = await driver.executeScript(() => window.__ext.find((x) => x.type === 'ready')?.rooms || 0);
    check(roomCapability === 1, `${label}: ready advertises Firefox native Rooms`);
    await driver.executeScript(() => window.postMessage({ melodica: 1, type: 'subscribe' }, location.origin));
    const signed = await waitFor(driver, async () => driver.executeScript(() => { const m = window.__ext.find((x) => x.type === 'state' && x.state && x.state.loggedIn && (x.state.stations || []).length > 0); return m ? { at: Math.round(m.at), stations: m.state.stations.length, first: m.state.stations[0] } : null; }), `${label}: signed-in state with stations`, 20_000, 100);
    const cmd = async (cid, action, extra = {}) => {
      await driver.executeScript((c, a, x) => window.postMessage({ melodica: 1, type: 'command', id: c, action: a, ...x }, location.origin), cid, action, extra);
      return waitFor(driver, async () => driver.executeScript((c) => window.__ext.find((x) => x.type === 'result' && x.id === c) || null, cid), `${label}: ${action} result`, 30_000, 100);
    };
    const play = await cmd(`${label}-play`, 'play', { station: { token: signed.first.token, name: signed.first.name } });
    check(play.ok, `${label}: play over the bridge (${play.error || ''})`);
    await waitFor(driver, async () => driver.executeScript(() => window.__ext.some((x) => x.type === 'state' && x.state && x.state.status === 'playing') || null), `${label}: playing`, 30_000, 200);
    const pause = await cmd(`${label}-pause`, 'pause');
    check(pause.ok, `${label}: pause over the bridge (${pause.error || ''})`);
    const handles = await driver.getAllWindowHandles();
    const r = { detectedMs: seen, signedInMs: signed.at, stations: signed.stations, played: true, paused: true, roomsCapability: roomCapability, windows: handles.length, extensionPages: [] };
    console.log(`cold start ${label}: ${JSON.stringify(r)}`);
    check(seen < 1000, `${label}: the page saw present/ready within 1 s (${seen} ms)`);
    await driver.get('about:blank');
    return r;
  };
  const reloaded = await reloadAddon(driver);
  console.log(`add-on: ${reloaded}`);
  check(reloaded === 'reloaded', 'add-on reloaded');
  const coldRestart = await coldRound('addon-reload');
  step('cold start: add-on reloaded, page alone');
  const terminated = await stopBackground(driver);
  console.log(`background: ${terminated}`);
  check(terminated === 'terminated', 'background page stopped');
  const coldStopped = await coldRound('background-stopped');
  step('cold start: background stopped, page alone');
  report.coldStart = { ok: true, restart: coldRestart, workerStopped: coldStopped, note: 'Firefox: a temporary add-on does not survive a browser restart, so the restart round is an add-on reload' };
  await goExt(driver, `${ext}/popup.html`);

  // Access withdrawn: the next check stops the music and signs out of Pandora.
  fakeAuth.disallow(tuner.user);
  const re2 = await ask(driver, { type: 'access-check' });
  check(re2.access.allowed === false, 'access withdrawn');
  await waitFor(driver, async () => (await loginOutcome(driver)).view === 'login' ? true : null, 'login view after withdrawal', 15_000);
  const wd = await loginOutcome(driver);
  check(wd.message === 'melodica access is by allow-list. Your request has been sent.', `login card shows the answer (${wd.message})`);
  const stoppedState = await playerState();
  check(stoppedState.loggedIn === false && stoppedState.status !== 'playing', `stopped and signed out of Pandora (${stoppedState.status})`);
  report.access.withdrawn = { status: stoppedState.status, loggedIn: stoppedState.loggedIn };
  step('access withdrawn: stopped and signed out');

  // 4. The real tuner.pandora.com without an account (the Firefox-only part of the proof).
  if (process.env.MELODICA_SKIP_REAL === '1') {
    report.realPandora = { skipped: true };
  } else {
    await goExt(driver, `${ext}/options.html`);
    await driver.wait(until.elementLocated(By.css('#reset')), 30_000);
    await driver.findElement(By.css('#reset')).click();
    await driver.wait(until.elementTextContains(driver.findElement(By.css('#options-message')), 'Saved'), 20_000);
    const back = await waitFor(driver, async () => { const s = await ask(driver, { type: 'state' }); return s.settings.endpoint === 'https://tuner.pandora.com/services/json/' && !s.loggedIn ? s : null; }, 'endpoint back at Pandora, session dropped', 20_000);
    console.log(`endpoint ${back.settings.endpoint}, loggedIn ${back.loggedIn}`);
    step('endpoint reset to Pandora');
    await goExt(driver, `${ext}/popup.html`);
    await waitFor(driver, async () => (await loginOutcome(driver)).view === 'login', 'login view');
    fakeAuth.allow(BOGUS.email);
    const real = await loginAndWait(driver, BOGUS.email, BOGUS.password);
    console.log(`real Pandora login outcome: ${JSON.stringify(real)}`);
    await screenshot(driver, 'real-pandora');
    const lines = await diagnostics(driver, ext);
    report.log = lines;
    const userLogin = lines.filter((l) => /auth\.userLogin/.test(l));
    const partnerLogin = lines.filter((l) => /auth\.partnerLogin/.test(l));
    console.log(`background log (${lines.length} lines):\n  ${lines.join('\n  ')}`);
    report.realPandora = {
      endpoint: back.settings.endpoint, email: BOGUS.email, view: real.view, message: real.message,
      partnerLoginLines: partnerLogin, userLoginLines: userLogin,
      code: (real.message.match(/code (\d+)/) || [])[1] ? Number(real.message.match(/code (\d+)/)[1]) : null,
    };
    check(real.view === 'login' && real.error, 'bogus credentials rejected');
    check(partnerLogin.some((l) => /<- auth\.partnerLogin HTTP 200 stat=ok/.test(l)), 'auth.partnerLogin answered ok (log)');
    check(userLogin.some((l) => /<- auth\.userLogin HTTP 200 stat=fail code=1002/.test(l)), `auth.userLogin answered code 1002 (log: ${userLogin.join(' | ')})`);
    check(/auth\.userLogin \(code 1002/.test(real.message), `popup names the call and code (message: "${real.message}")`);
    check(/Wrong email address or password/.test(real.message), `popup says wrong credentials (message: "${real.message}")`);
    check(!/session expired/i.test(real.message), 'popup does not claim an expired session');
    step('real Pandora: bogus login -> code 1002');
  }

  report.ok = true;
  report.summary = `${report.browser}: temporary add-on ${GECKO_ID} with host permission ${origins.join(' ')}; refused an email not on the access allow-list without asking Pandora, signed in to the tuner (${tuner.version}), listed ${names.length} stations, played "${now.title}" in the background page with no tab (still playing after ${NO_PAGE_MS / 1000}s with no extension page open; the optional player tab showed it and its closing changed nothing; a slot was fetched x${report.spots.defaultPolicy.metadataFetched}, played and registered x${report.spots.defaultPolicy.registered}, with next refused during it, and no slot once the access answer said spots:false); signed in to the optional spacegho.st account (${report.account.label}) and out; stopped and signed out of Pandora when access was withdrawn; ` +
    (report.realPandora.skipped ? 'real Pandora probe skipped' : `real tuner.pandora.com with bogus credentials -> auth.userLogin code ${report.realPandora.code} ("${report.realPandora.message}")`);
} catch (e) {
  report.ok = false;
  // No sign-in code or token may reach the log or the report.
  const scrub = (t) => String(t).replace(/(code|state|access_token|refresh_token)(=|%3D)[^&\s%]+/gi, '$1$2…');
  report.errors.push(scrub(e && e.stack || e));
  report.summary = `FAILED: ${scrub(String(e && e.message || e).split('\n')[0])}`;
  console.error(report.summary);
  if (tuner.http) {
    const tl = await getJson(`${tuner.http}/__tuner/log`).catch(() => []);
    console.log(`tuner log (first 40 audio/slot/playlist of ${tl.length}):\n  ${tl.filter((e) => e.protocol !== "json" || /ad\.|getPlaylist/.test(e.method || "")).slice(0, 40).map((e) => `${e.protocol} ${e.httpMethod} ${e.method || e.path} -> ${e.status}${e.code == null ? '' : ` code=${e.code}`}${e.headers && e.headers.range ? ` range=${e.headers.range}` : ''}`).join('\n  ')}`);
  }
  if (driver) {
    try { await screenshot(driver, 'failure'); } catch {}
    try { report.log = await diagnostics(driver, `moz-extension://${UUID}`); console.log(`background log:\n  ${report.log.join('\n  ')}`); } catch (e2) { report.errors.push(`diagnostics: ${e2.message}`); }
  }
} finally {
  if (driver) await driver.quit().catch(() => {});
  if (fakeAuth) await new Promise((ok) => fakeAuth.server.close(ok));
  if (tuner.proc) { tuner.proc.kill('SIGTERM'); tuner.proc = null; }
  if (tuner.dir) await rm(tuner.dir, { recursive: true, force: true }).catch(() => {});
  if (web.server) web.server.close();
  if (web.proxy) web.proxy.close();
  if (web.dir) await rm(web.dir, { recursive: true, force: true }).catch(() => {});
  report.when = new Date().toISOString();
  await writeFile(resolve(ARTIFACTS, `${NAME}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(`${NAME}.json: ok=${report.ok} ${report.summary}`);
  process.exit(report.ok ? 0 : 1);
}
