// The GitHub sign-in gate in a real browser, against a fake Worker.
//
// A local server serves dist/ under /melodica/app/ with the site's CSP (connect-src
// 'self' only, like production) and plays the Worker's /melodica/auth/me,
// /melodica/auth/logout and /melodica/api/ routes. Its behaviour is switched per test
// (`mode`), and it records every Authorization header it saw. No network.
//
//   off        /auth/me -> 503: the Pandora login shows directly
//   anonymous  no token -> 401: the GitHub screen with the start link
//   allowed    #melodica_token=<allowed> -> stored, URL cleaned, Pandora login
//   denied     #melodica_token=<denied> -> the plain "not available for your account" message, sign-out works
//   refresh    /auth/me returns a new token -> it replaces the stored one
//   relay 401  a token the relay rejects -> back to the GitHub screen with the relay's words
//   ?api=      the gate screen is skipped; a stored token is still sent to the relay
//
// Artifacts: tests/artifacts/gate-anonymous.png, gate-denied.png, gate-relay-401.png.

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
const TOKEN_KEY = 'melodica.github';

const b64url = (s) => Buffer.from(s).toString('base64url');
const mk = (claims) => `${b64url(JSON.stringify(claims))}.${b64url('fake-mac-32-bytes-0123456789abcd')}`;
const ALLOWED = mk({ sub: 'alice', id: 1, friend: true, iat: 1, exp: 2, chk: 1 });
const ALLOWED2 = mk({ sub: 'alice', id: 1, friend: true, iat: 2, exp: 3, chk: 2 });
const DENIED_TOKEN = mk({ sub: 'bob', id: 2, friend: false, iat: 1, exp: 2, chk: 1 });
const DENIED = { stat: 'fail', code: -1, message: 'melodica is not available for this account: sign in with GitHub' };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8',
};
// Exactly the site worker's APP_CSP: everything the gate does is same-origin.
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; ` +
  `style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src https: http:; ` +
  `connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'`;

const fake = { mode: 'anonymous', relay: 'ok', seen: [] };
let server = null;
let base = '';

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...extra });
  res.end(text);
}

// The Worker's /auth/me as the client sees it, keyed on the token it was given.
function me(auth) {
  const token = /^Bearer (.+)$/.exec(auth || '')?.[1] || '';
  if (fake.mode === 'off') return [503, { error: 'auth not configured' }];
  if (!token) return [401, { error: 'missing token' }];
  if (token === ALLOWED) return [200, { login: 'alice', friend: true, exp: 2, checked_at: 1 }];
  if (token === ALLOWED2) return [200, { login: 'alice', friend: true, exp: 3, checked_at: 2 }];
  if (token === DENIED_TOKEN) return [200, { login: 'bob', friend: false, exp: 2, checked_at: 1 }];
  if (token === 'refresh-me.sig') return [200, { login: 'alice', friend: true, exp: 3, checked_at: 2, token: ALLOWED2 }];
  return [401, { error: 'invalid or expired token' }];
}

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers.authorization || '';
    if (url.pathname === '/melodica/auth/me') {
      fake.seen.push({ path: 'auth/me', method: req.method, auth });
      const [status, body] = me(auth);
      return sendJson(res, status, body);
    }
    if (url.pathname === '/melodica/auth/logout') {
      fake.seen.push({ path: 'auth/logout', method: req.method, auth });
      return sendJson(res, fake.mode === 'off' ? 503 : 200, fake.mode === 'off' ? { error: 'auth not configured' } : { ok: true });
    }
    if (url.pathname === '/melodica/api/') {
      fake.seen.push({ path: 'api', method: req.method, auth, apiMethod: url.searchParams.get('method') });
      if (fake.relay === '401') return sendJson(res, 401, DENIED, { 'www-authenticate': 'Bearer realm="melodica"' });
      // Not a real Pandora answer: a shape libpiano reports as an error, so the test can tell
      // "the relay was reached with the header" from "the relay refused".
      return sendJson(res, 200, { stat: 'fail', code: 1039, message: 'fake relay reached' });
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

test.beforeEach(() => {
  fake.mode = 'anonymous';
  fake.relay = 'ok';
  fake.seen = [];
});

// Chromium logs "Failed to load resource" for every non-2xx answer, including the
// ones the gate handles on purpose (/auth/me 503/401, the relay's 401). Those are
// not errors of the page; everything else is kept.
function expectedResourceError(msg) {
  if (msg.type() !== 'error' || !/Failed to load resource/.test(msg.text())) return false;
  const url = (msg.location() && msg.location().url) || '';
  return /\/melodica\/auth\//.test(url) || (/status of 401/.test(msg.text()) && /\/melodica\/api\//.test(url));
}

async function open(page, url, { storedToken = null } = {}) {
  const evidence = { console: [], errors: [], violations: [] };
  await page.addInitScript(({ key, token }) => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (ev) => {
      window.__cspViolations.push({ directive: ev.violatedDirective, blocked: ev.blockedURI, sample: ev.sample });
    });
    if (token) localStorage.setItem(key, token);
  }, { key: TOKEN_KEY, token: storedToken });
  page.on('console', (msg) => { if (!expectedResourceError(msg)) evidence.console.push(`[${msg.type()}] ${msg.text()}`); });
  page.on('pageerror', (err) => evidence.errors.push(String(err && err.stack || err)));
  await page.goto(url, { waitUntil: 'load' });
  // Whatever the gate decides, the wasm must be up (data-view leaves "loading").
  await expect(page.locator('#app')).not.toHaveAttribute('data-view', 'loading', { timeout: 30_000 });
  await expect(page.locator('#status')).toContainText('melodica.h');
  return evidence;
}

async function finish(page, evidence, info) {
  evidence.violations = await page.evaluate(() => window.__cspViolations);
  const lines = [
    `view: ${await page.locator('#app').getAttribute('data-view')}`,
    `fake worker saw (${fake.seen.length}):`, ...fake.seen.map((s) => `  ${s.method} ${s.path}${s.apiMethod ? ` ${s.apiMethod}` : ''} auth=${s.auth ? s.auth.slice(0, 24) + '…' : '(none)'}`),
    `console (${evidence.console.length}):`, ...evidence.console.map((l) => `  ${l}`),
    `page errors (${evidence.errors.length}):`, ...evidence.errors.map((l) => `  ${l}`),
    `csp violations (${evidence.violations.length}):`, ...evidence.violations.map((v) => `  ${JSON.stringify(v)}`),
  ];
  console.log(lines.join('\n'));
  await info.attach('evidence', { body: lines.join('\n'), contentType: 'text/plain' });
  expect(evidence.errors, 'uncaught page errors').toEqual([]);
  expect(evidence.console.filter((l) => l.startsWith('[error]')), 'console errors').toEqual([]);
  expect(evidence.violations, 'CSP violations').toEqual([]);
}

test.describe.serial('GitHub sign-in gate', () => {
  test('503 from /auth/me (not configured): the Pandora login shows directly', async ({ page }, info) => {
    fake.mode = 'off';
    const evidence = await open(page, base);
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
      await expect(page.locator('#view-github')).toBeHidden();
      await expect(page.locator('#login-email')).toBeVisible();
      await expect(page.locator('#github-line')).toBeHidden();
      expect(fake.seen.map((s) => s.path)).toEqual(['auth/me']);
      expect(fake.seen[0].auth).toBe('');
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('no token: the GitHub screen, with the start link and the plain explanation', async ({ page }, info) => {
    const evidence = await open(page, base);
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'github');
      await expect(page.locator('#view-login')).toBeHidden();
      await expect(page.locator('#view-player')).toBeHidden();
      await expect(page.locator('#login-email')).toBeHidden();
      const button = page.locator('#github-button');
      await expect(button).toBeVisible();
      await expect(button).toHaveText('Sign in with GitHub');
      const origin = new URL(base).origin;
      expect(await button.getAttribute('href')).toBe(`${origin}/melodica/auth/start?return_to=${encodeURIComponent(`${origin}/melodica/app/`)}`);
      await expect(page.locator('#view-github')).toContainText('Sign in with GitHub to use melodica web');
      await expect(page.locator('#view-github')).toContainText('identity only');
      await expect(page.locator('#github-denied')).toBeHidden();
      await expect(page.locator('#github-message')).toHaveText('');
      await page.screenshot({ path: resolve(ARTIFACTS, 'gate-anonymous.png') });
      await info.attach('gate-anonymous', { path: resolve(ARTIFACTS, 'gate-anonymous.png'), contentType: 'image/png' });
      expect(fake.seen.map((s) => s.path)).toEqual(['auth/me']);
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('a GitHub-side error in the fragment is shown, and the fragment is cleaned', async ({ page }, info) => {
    const evidence = await open(page, `${base}#melodica_error=access_denied`);
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'github');
      await expect(page.locator('#github-message')).toContainText('access_denied');
      expect(await page.evaluate(() => location.hash)).toBe('');
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('#melodica_token for an allowed account: stored, URL cleaned, Pandora login with the GitHub line', async ({ page }, info) => {
    const evidence = await open(page, `${base}?keep=1#melodica_token=${ALLOWED}&other=x`);
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
      expect(await page.evaluate(() => location.hash)).toBe('#other=x');
      expect(await page.evaluate(() => location.search)).toBe('?keep=1');
      expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBe(ALLOWED);
      await expect(page.locator('#github-line')).toBeVisible();
      await expect(page.locator('#github-login')).toHaveText('alice');
      expect(fake.seen.map((s) => `${s.path} ${s.auth}`)).toEqual([`auth/me Bearer ${ALLOWED}`]);
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('/auth/me can hand back a refreshed token, which replaces the stored one', async ({ page }, info) => {
    const evidence = await open(page, base, { storedToken: 'refresh-me.sig' });
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
      expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBe(ALLOWED2);
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('signed in but not allowed: the plain message naming the login, and sign-out', async ({ page }, info) => {
    const evidence = await open(page, `${base}#melodica_token=${DENIED_TOKEN}`);
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'github');
      const text = page.locator('#github-denied-text');
      await expect(text).toBeVisible();
      await expect(text).toHaveText('melodica is not available for your GitHub account (bob).');
      await expect(page.locator('#github-button')).toBeHidden();
      await page.screenshot({ path: resolve(ARTIFACTS, 'gate-denied.png') });
      await info.attach('gate-denied', { path: resolve(ARTIFACTS, 'gate-denied.png'), contentType: 'image/png' });

      await page.click('#github-signout');
      await expect(page.locator('#github-button')).toBeVisible();
      await expect(page.locator('#github-denied')).toBeHidden();
      expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBeNull();
      await expect.poll(() => fake.seen.some((s) => s.path === 'auth/logout' && s.method === 'POST' && s.auth === `Bearer ${DENIED_TOKEN}`)).toBe(true);
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('a 401 from the relay sends the user back to the GitHub screen with the relay\'s message', async ({ page }, info) => {
    fake.relay = '401';
    const evidence = await open(page, base, { storedToken: ALLOWED });
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
      await page.fill('#login-email', 'nobody@example.invalid');
      await page.fill('#login-password', 'wrong');
      await page.click('#login-button');
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'github', { timeout: 20_000 });
      await expect(page.locator('#github-message')).toHaveText(DENIED.message);
      await page.screenshot({ path: resolve(ARTIFACTS, 'gate-relay-401.png') });
      await info.attach('gate-relay-401', { path: resolve(ARTIFACTS, 'gate-relay-401.png'), contentType: 'image/png' });
      const api = fake.seen.filter((s) => s.path === 'api');
      expect(api.length).toBeGreaterThan(0);
      expect(api[0].apiMethod).toBe('auth.partnerLogin');
      for (const s of api) expect(s.auth, 'the relay request carried the bearer token').toBe(`Bearer ${ALLOWED}`);
      // The token was still accepted by /auth/me (the fake says allowed), so the screen offers the link, not the denial.
      await expect(page.locator('#github-denied')).toBeHidden();
      await expect(page.locator('#github-button')).toBeVisible();
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('with ?api= the GitHub screen is skipped and a stored token still reaches the relay', async ({ page }, info) => {
    const origin = new URL(base).origin;
    const evidence = await open(page, `${base}?api=${encodeURIComponent(`${origin}/melodica/api/`)}`, { storedToken: ALLOWED });
    try {
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
      expect(fake.seen.filter((s) => s.path === 'auth/me')).toEqual([]);
      await page.fill('#login-email', 'nobody@example.invalid');
      await page.fill('#login-password', 'wrong');
      await page.click('#login-button');
      await expect(page.locator('#login-message')).not.toHaveText(/^(Signing in…)?$/, { timeout: 20_000 });
      const api = fake.seen.filter((s) => s.path === 'api');
      expect(api.length).toBeGreaterThan(0);
      expect(api[0].auth).toBe(`Bearer ${ALLOWED}`);
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
    } finally {
      await finish(page, evidence, info);
    }
  });
});
