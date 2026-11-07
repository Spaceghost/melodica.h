// Real-browser proof that the client loads and reaches its login screen.
//
// Opens the page in Chromium, waits for melodica.wasm to instantiate (the
// app switches #app[data-view] from "loading" to "login" only after
// PianoClient.load() resolved and mw_init returned 0), checks the login
// form, collects console messages, page errors and CSP violations, then
// submits fake credentials. Without a Pandora account the correct outcome
// is Pandora's error 1002 on the auth.userLogin step, which libpiano maps to
// PIANO_RET_INVALID_LOGIN and the UI shows as "Wrong email address or
// password." That proves the whole path: wasm -> Blowfish body -> relay ->
// Pandora -> parsed error.
//
// Env:
//   MELODICA_APP_URL   hosted page to test (e.g. https://spacegho.st/melodica/app/).
//                      Unset: a local static server serves dist/ under
//                      /melodica/app/ with the same CSP the site worker sends
//                      (plus the relay origin in connect-src) and ?api= points
//                      the client at MELODICA_API.
//   MELODICA_API       relay URL for the local variant (default
//                      https://spacegho.st/melodica/api/).
//   MELODICA_DIST      dist directory (default ../dist).
//   MELODICA_BROWSER_ALLOW_RELAY_BLOCK=1
//                      Cloudflare answers datacenter clients (GitHub Actions
//                      runners) with a challenge page instead of the relay.
//                      With this set, that outcome skips the login-error test
//                      as "not provable here" instead of failing it.
//
// Artifacts: tests/artifacts/login-screen.png and login-error.png.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const HOSTED = process.env.MELODICA_APP_URL || '';
const RELAY = process.env.MELODICA_API || 'https://spacegho.st/melodica/api/';
const ALLOW_RELAY_BLOCK = process.env.MELODICA_BROWSER_ALLOW_RELAY_BLOCK === '1';
const ARTIFACTS = resolve(here, 'artifacts');
const APP_PATH = '/melodica/app/';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8',
};
// The site worker's APP_CSP, with the relay origin added to connect-src
// because the local server is a different origin from the relay.
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; ` +
  `style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src https: http:; ` +
  `connect-src 'self' ${new URL(RELAY).origin}; font-src 'self'; base-uri 'none'; form-action 'none'; ` +
  `frame-ancestors 'none'; worker-src 'self'`;

let server = null;
let appUrl = HOSTED;

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (HOSTED) return;
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
  appUrl = `http://127.0.0.1:${port}${APP_PATH}?api=${encodeURIComponent(RELAY)}`;
});

test.afterAll(async () => {
  if (server) await new Promise((ok) => server.close(ok));
});

// Opens the page with instrumentation and returns the collected evidence.
async function openApp(page) {
  const evidence = { console: [], errors: [], failed: [], relay: [] };
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (ev) => {
      window.__cspViolations.push({
        directive: ev.violatedDirective, blocked: ev.blockedURI, source: ev.sourceFile,
        line: ev.lineNumber, sample: ev.sample,
      });
    });
  });
  page.on('console', (msg) => evidence.console.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => evidence.errors.push(String(err && err.stack || err)));
  page.on('requestfailed', (req) => evidence.failed.push(`${req.method()} ${req.url()} ${req.failure()?.errorText}`));
  page.on('response', async (res) => {
    if (!res.url().startsWith(RELAY)) return;
    const q = new URL(res.url()).searchParams.get('method');
    let head = '';
    try { head = (await res.text()).slice(0, 160).replace(/\s+/g, ' '); } catch { /* body gone */ }
    evidence.relay.push({ method: q, status: res.status(), head });
  });

  const res = await page.goto(appUrl, { waitUntil: 'load' });
  const title = await page.title();
  const html = await page.content();
  const challenged = /Just a moment|cf-chl|challenge-platform\/h\/|Attention Required/i.test(title + html.slice(0, 4000))
    && !html.includes('id="login-form"');
  evidence.challenged = challenged;
  evidence.httpStatus = res ? res.status() : null;
  evidence.csp = res ? res.headers()['content-security-policy'] || '' : '';
  return evidence;
}

function report(evidence) {
  const lines = [
    `url: ${appUrl}`,
    `http: ${evidence.httpStatus}`,
    `csp: ${evidence.csp}`,
    `challenged: ${evidence.challenged}`,
    `console (${evidence.console.length}):`, ...evidence.console.map((l) => `  ${l}`),
    `page errors (${evidence.errors.length}):`, ...evidence.errors.map((l) => `  ${l}`),
    `failed requests (${evidence.failed.length}):`, ...evidence.failed.map((l) => `  ${l}`),
    `csp violations (${(evidence.violations || []).length}):`, ...(evidence.violations || []).map((v) => `  ${JSON.stringify(v)}`),
    `relay calls (${evidence.relay.length}):`, ...evidence.relay.map((r) => `  ${r.method} -> HTTP ${r.status} ${r.head}`),
  ];
  console.log(lines.join('\n'));
  return lines.join('\n');
}

async function waitForLoginScreen(page, evidence) {
  expect(evidence.challenged, 'Cloudflare answered with a challenge page instead of the app').toBe(false);
  await expect(page).toHaveTitle(/melodica/);
  await expect(page.locator('header h1')).toContainText('melodica');
  // data-view="login" is set by app.js only after the wasm module loaded and mw_init returned 0.
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
  await expect(page.locator('#view-error')).toBeHidden();
  // Regression: .player's display:grid used to override the hidden attribute,
  // so the empty player view showed through under the login form.
  await expect(page.locator('#view-player')).toBeHidden();
  await expect(page.locator('#station-list')).toBeHidden();
  await expect(page.locator('#status')).toContainText('melodica.h');
  await expect(page.locator('#login-email')).toBeVisible();
  await expect(page.locator('#login-password')).toBeVisible();
  await expect(page.locator('#login-button')).toBeVisible();
  const wasm = await page.evaluate(() => ({
    hasWebAssembly: typeof WebAssembly === 'object',
    status: document.getElementById('status').textContent,
  }));
  expect(wasm.hasWebAssembly).toBe(true);
  evidence.violations = await page.evaluate(() => window.__cspViolations);
  return wasm;
}

test.describe.serial('melodica-web in Chromium', () => {
  test('loads the wasm module and shows the login form under CSP', async ({ page }, info) => {
    const evidence = await openApp(page);
    try {
      const wasm = await waitForLoginScreen(page, evidence);
      info.annotations.push({ type: 'status', description: wasm.status });
      await page.screenshot({ path: resolve(ARTIFACTS, 'login-screen.png') });
      await info.attach('login-screen', { path: resolve(ARTIFACTS, 'login-screen.png'), contentType: 'image/png' });
      expect(evidence.errors, 'uncaught page errors').toEqual([]);
      expect(evidence.console.filter((l) => l.startsWith('[error]')), 'console errors').toEqual([]);
      expect(evidence.violations, 'CSP violations').toEqual([]);
      expect(evidence.failed, 'failed requests').toEqual([]);
    } finally {
      await info.attach('evidence', { body: report(evidence), contentType: 'text/plain' });
    }
  });

  test('a wrong password reaches Pandora through the relay and is reported in the UI', async ({ page }, info) => {
    const evidence = await openApp(page);
    try {
      await waitForLoginScreen(page, evidence);
      await page.fill('#login-email', 'nobody@example.invalid');
      await page.fill('#login-password', 'wrong');
      await page.click('#login-button');
      const message = page.locator('#login-message');
      // The two-step login is at least two relay round trips; allow 20 s.
      await expect(message).not.toHaveText(/^(Signing in…)?$/, { timeout: 20_000 });
      const text = (await message.textContent()).trim();
      info.annotations.push({ type: 'login-message', description: text });
      await page.screenshot({ path: resolve(ARTIFACTS, 'login-error.png') });
      await info.attach('login-error', { path: resolve(ARTIFACTS, 'login-error.png'), contentType: 'image/png' });

      const relayBlocked = /answered HTTP 403/.test(text) && evidence.relay.some((r) => r.status === 403);
      if (relayBlocked && ALLOW_RELAY_BLOCK) {
        console.log('WARNING: the relay answered HTTP 403 (Cloudflare challenge) from this network; the live login path could not be exercised here.');
        test.skip(true, 'relay blocked by Cloudflare from this network (MELODICA_BROWSER_ALLOW_RELAY_BLOCK=1)');
      }
      expect(text, 'login message').toMatch(/wrong email address or password|invalid (username|password|credentials)/i);
      expect(evidence.relay.map((r) => r.method), 'relay calls').toEqual(
        expect.arrayContaining(['auth.partnerLogin', 'auth.userLogin']),
      );
      for (const r of evidence.relay) expect(r.status, `relay HTTP status for ${r.method}`).toBe(200);
      expect(evidence.errors, 'uncaught page errors').toEqual([]);
      expect(evidence.console.filter((l) => l.startsWith('[error]')), 'console errors').toEqual([]);
      evidence.violations = await page.evaluate(() => window.__cspViolations);
      expect(evidence.violations, 'CSP violations').toEqual([]);
      // Still on the login screen, nothing leaked into the player.
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
    } finally {
      await info.attach('evidence', { body: report(evidence), contentType: 'text/plain' });
    }
  });
});
