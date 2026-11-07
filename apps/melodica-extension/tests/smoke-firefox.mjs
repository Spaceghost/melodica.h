// Proof of the built Firefox extension (dist/firefox) in a real Mozilla Firefox,
// driven through geckodriver with selenium-webdriver (Playwright's Firefox build
// cannot load extensions). Two parts:
//
//   1. against melodica-tuner, like the Chromium and Brave smokes: the options
//      page points the extension at the tuner, the popup (opened as a tab)
//      signs in, lists the fixture's stations, starts one; the player tab opens
//      and its <audio> element plays;
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
// Output: tests/artifacts/smoke-firefox.json and smoke-firefox-{login,stations,playing,real-pandora}.png
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { spawn, execFileSync } from 'node:child_process';
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
  extension: {}, permissions: null, sessionStorage: null, background: null, audio: null,
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
    '--ready-file', ready, '--log-level', 'info'];
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

let driver = null;
const bin = process.env.MELODICA_FIREFOX || 'firefox';
try {
  await mkdir(ARTIFACTS, { recursive: true });
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

  // 1. Options: point at the tuner.
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

  // 3. Start a station: the player tab opens and plays.
  const popupHandle = await driver.getWindowHandle();
  const before = await driver.getAllWindowHandles();
  const first = (await driver.findElements(By.css('#station-list button.station')))[0];
  const chosen = (await first.getText()).trim();
  await first.click();
  const handles = await waitFor(driver, async () => { const h = await driver.getAllWindowHandles(); return h.length > before.length ? h : null; }, 'player tab');
  const playerHandle = handles.find((h) => !before.includes(h));
  await driver.switchTo().window(playerHandle);
  await waitFor(driver, async () => (await driver.getCurrentUrl()).startsWith(`${ext}/player.html`) ? true : null, 'player url');
  await waitFor(driver, async () => {
    const t = await driver.executeScript(() => document.getElementById('np-title')?.textContent || '');
    return t && !/^(Pick a station)?$/.test(t.trim()) ? t : null;
  }, 'now playing title');
  const now = await driver.executeScript(() => ({
    title: document.getElementById('np-title')?.textContent.trim(),
    artist: document.getElementById('np-artist')?.textContent.trim(),
    station: document.getElementById('np-station')?.textContent.trim(),
  }));
  check(now.station.includes(chosen), `player shows the chosen station (${now.station} vs ${chosen})`);
  console.log(`now playing: ${now.title} – ${now.artist} on ${now.station}`);
  await waitFor(driver, async () => driver.executeScript(() => { const a = document.getElementById('audio'); return a && (a.readyState >= 2 || a.error) ? true : null; }), 'audio ready');
  await waitFor(driver, async () => driver.executeScript(() => { const a = document.getElementById('audio'); return a && (a.currentTime > 0.5 || a.error) ? true : null; }), 'audio progress', 15_000).catch(() => {});
  const audio = await driver.executeScript(() => { const a = document.getElementById('audio'); return { src: a.src, readyState: a.readyState, paused: a.paused, currentTime: a.currentTime, duration: a.duration, error: a.error ? a.error.code : null }; });
  report.audio = { ...audio, ...now, station: chosen };
  console.log(`audio: ${JSON.stringify(audio)}`);
  await screenshot(driver, 'playing');
  check(audio.error === null, `audio element error ${audio.error}`);
  check(audio.src.includes('/audio/'), 'audio src from the tuner');
  check(audio.readyState >= 2, `HTMLMediaElement.readyState ${audio.readyState}`);
  check(audio.paused === false, 'audio playing');
  step('playing');
  await driver.close();
  await driver.switchTo().window(popupHandle);

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
  report.summary = `${report.browser}: temporary add-on ${GECKO_ID} with host permission ${origins.join(' ')}; signed in to the tuner (${tuner.version}), listed ${names.length} stations, played "${now.title}" (readyState ${audio.readyState}); ` +
    (report.realPandora.skipped ? 'real Pandora probe skipped' : `real tuner.pandora.com with bogus credentials -> auth.userLogin code ${report.realPandora.code} ("${report.realPandora.message}")`);
} catch (e) {
  report.ok = false;
  report.errors.push(String(e && e.stack || e));
  report.summary = `FAILED: ${String(e && e.message || e).split('\n')[0]}`;
  console.error(report.summary);
  if (driver) {
    try { await screenshot(driver, 'failure'); } catch {}
    try { report.log = await diagnostics(driver, `moz-extension://${UUID}`); console.log(`background log:\n  ${report.log.join('\n  ')}`); } catch (e2) { report.errors.push(`diagnostics: ${e2.message}`); }
  }
} finally {
  if (driver) await driver.quit().catch(() => {});
  if (tuner.proc) { tuner.proc.kill('SIGTERM'); tuner.proc = null; }
  if (tuner.dir) await rm(tuner.dir, { recursive: true, force: true }).catch(() => {});
  report.when = new Date().toISOString();
  await writeFile(resolve(ARTIFACTS, `${NAME}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(`${NAME}.json: ok=${report.ok} ${report.summary}`);
  process.exit(report.ok ? 0 : 1);
}
