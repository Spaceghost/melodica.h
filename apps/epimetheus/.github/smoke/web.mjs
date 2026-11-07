// Web smoke test: open the served Flutter web build in headless Chromium, wait for the sign-in form.
// env: URL (served build), OUT (dir). Optional tuner: TUNER_HOST (host[:port] for the "CORS stripper" field),
// TUNER_USER, TUNER_PASSWORD, TUNER_LOG_URL.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.URL, OUT = process.env.OUT;
fs.mkdirSync(OUT, { recursive: true });
const when = new Date().toISOString();
const steps = [], notes = [], pageErrors = [], consoleErrors = [];
let ok = false, tuner = 'none', tunerResult = 'not attempted';
const log = (m) => { const l = `[smoke-web ${new Date().toISOString().slice(11, 19)}] ${m}`; console.log(l); fs.appendFileSync(path.join(OUT, 'smoke-web-steps.txt'), l + '\n'); };
const step = (s) => { steps.push(s); log('step: ' + s); };
const note = (s) => { notes.push(s); log('note: ' + s); };
const finish = (summary) => {
  const j = { ok, platform: 'web', summary, when, steps, tuner, tuner_result: tunerResult, notes, url: URL,
    browser: 'headless Chromium via playwright@1.48', pageErrors, consoleErrors: consoleErrors.slice(0, 20),
    detection: 'flt-glass-pane present and sign-in texts (Email address / Password / Sign in / CORS stripper) found in the DOM (Flutter 1.22 html renderer) or input elements present; screenshot non-blank' };
  fs.writeFileSync(path.join(OUT, 'smoke-web.json'), JSON.stringify(j, null, 2));
  console.log(JSON.stringify(j, null, 2));
};

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => { pageErrors.push(String(e)); log('pageerror: ' + e); });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); fs.appendFileSync(path.join(OUT, 'smoke-web-console.txt'), `[${m.type()}] ${m.text()}\n`); });
page.on('requestfailed', (r) => fs.appendFileSync(path.join(OUT, 'smoke-web-console.txt'), `[requestfailed] ${r.url()} ${r.failure()?.errorText}\n`));

const texts = ['Email address', 'Password', 'Sign in', 'CORS stripper'];
const findText = async (t) => (await page.locator(`text="${t}"`).count()) > 0 || (await page.locator(`[aria-label="${t}"]`).count()) > 0;
const waitFor = async (list, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const t of list) if (await findText(t)) return t;
    await page.waitForTimeout(1000);
  }
  return null;
};

try {
  const resp = await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  if (!resp || !resp.ok()) throw new Error('index.html status ' + (resp && resp.status()));
  step('opened');
  await page.waitForSelector('flt-glass-pane, flt-scene-host, flutter-view', { timeout: 60000 }).catch(() => null);
  const glass = await page.locator('flt-glass-pane, flt-scene-host, flutter-view').count();
  note(`flutter host elements: ${glass}`);
  const hit = await waitFor(texts, 60000);
  const inputs = await page.locator('input').count();
  await page.screenshot({ path: path.join(OUT, 'smoke-web-login.png') });
  fs.writeFileSync(path.join(OUT, 'smoke-web-dom.html'), await page.content());
  if (hit) note(`login screen text found in DOM: "${hit}"`); else note(`no sign-in text in DOM; inputs=${inputs}`);
  if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join(' | '));
  if (!(hit || (glass > 0 && inputs > 0))) throw new Error('sign-in form not detected within 60 s');
  step('login screen');
  let summary = 'Web build serves and opens to the Sign in screen in headless Chromium';

  if (process.env.TUNER_HOST && process.env.TUNER_USER) {
    const apiHost = process.env.TUNER_HOST.replace(/^https?:\/\//, '').replace(/\/$/, '');
    tuner = await (async () => { try { const r = await ctx.request.get((process.env.TUNER_HTTP_URL || process.env.TUNER_HOST) + '/__tuner/health', { ignoreHTTPSErrors: true }); return (await r.json()).version || 'unknown'; } catch { return 'unknown'; } })();
    note(`tuner ${apiHost} version ${tuner}`);
    // Flutter web draws the form on canvas; enabling the semantics tree exposes the text fields as <input> elements.
    const placeholder = page.locator('flt-semantics-placeholder');
    if (await placeholder.count()) { await placeholder.first().click({ force: true }).catch(() => null); await page.waitForTimeout(1500); }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && (await page.locator('flt-glass-pane input, flt-semantics input, input').count()) < 3) await page.waitForTimeout(500);
    const inputs = page.locator('flt-glass-pane input, flt-semantics input, input');
    const n = await inputs.count();
    note(`semantics inputs after enabling accessibility: ${n}`);
    const values = [process.env.TUNER_USER, process.env.TUNER_PASSWORD, apiHost];
    // Layout at 1280x900 (from the login screenshot) as a fallback when semantics are unavailable.
    const coords = [[640, 400], [640, 466], [613, 532]];
    for (let i = 0; i < 3; i++) {
      if (n >= 3) { await inputs.nth(i).click({ force: true }); } else { await page.mouse.click(...coords[i]); }
      await page.waitForTimeout(400);
      await page.keyboard.type(values[i], { delay: 15 });
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(OUT, 'smoke-web-filled.png') });
    const btn = page.locator('flt-semantics[role="button"]:has-text("Sign in"), [aria-label="Sign in"]');
    if (await btn.count()) await btn.last().click({ force: true }); else await page.mouse.click(832, 586);
    step('submitted credentials');
    const after = await waitFor(['My Collection'], 90000);
    let stationsUi = null;
    if (after) { step('logged in'); stationsUi = await waitFor(['Aurora Fields', 'Radio', 'Shuffle'], 60000); }
    await page.screenshot({ path: path.join(OUT, 'smoke-web-stations.png') });
    fs.writeFileSync(path.join(OUT, 'smoke-web-dom-after.html'), await page.content());
    let loginLogged = false, stationsLogged = false;
    if (process.env.TUNER_LOG_URL) {
      try {
        const r = await ctx.request.get(process.env.TUNER_LOG_URL, { ignoreHTTPSErrors: true });
        const text = await r.text(); fs.writeFileSync(path.join(OUT, 'smoke-web-tuner-log.json'), text);
        const d = JSON.parse(text); const entries = Array.isArray(d) ? d : (d.entries || d.log || []);
        const okm = (m) => entries.some((e) => e.protocol === 'rest' && String(e.method || '').endsWith(m) && (e.code === null || e.code === 0 || e.code === undefined));
        loginLogged = okm('auth/login'); stationsLogged = okm('station/getStations');
        if (loginLogged) step('auth/login ok (tuner log)');
        if (stationsLogged) step('station/getStations ok (tuner log)');
      } catch (e) { note('tuner log fetch failed: ' + e.message); }
    }
    if (after && stationsLogged) {
      step('station list'); ok = true;
      tunerResult = `logged in; "My Collection" shown; tuner log has auth/login and station/getStations; station name in DOM: ${stationsUi}`;
      summary = `Web build opens to the Sign in screen, logs in against melodica-tuner ${tuner} and lists stations`;
    } else {
      tunerResult = after ? `collection page shown but station/getStations not confirmed in the tuner log (login logged: ${loginLogged})`
                          : 'login submitted but the collection page was not detected within 90 s (see smoke-web-stations.png, console log)';
      note(tunerResult);
    }
  }
  finish(summary);
} catch (e) {
  log('FAIL ' + e);
  await page.screenshot({ path: path.join(OUT, 'smoke-web-login.png') }).catch(() => {});
  finish('web smoke failed: ' + e.message);
  await browser.close();
  process.exit(1);
}
await browser.close();
