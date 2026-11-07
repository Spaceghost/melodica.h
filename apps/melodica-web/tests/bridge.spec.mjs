// The extension bridge in a real browser, with a fake content script.
//
// A page-world script injected before app.js plays the melodica browser
// extension: it answers {type:'hello'} with {type:'ready', name, version} and
// proxies every {type:'request'} to the relay with fetch, posting the bytes
// back as {type:'response'}. The test checks that the status line says the
// transport is direct, that the login round trips were carried by the bridge,
// and that an explicit ?api= wins over the bridge (no hello is even sent).
//
// Env (as tests/browser.spec.mjs): MELODICA_API (relay the fake script forwards
// to, default https://spacegho.st/melodica/api/), MELODICA_DIST,
// MELODICA_BROWSER_ALLOW_RELAY_BLOCK=1 (a Cloudflare challenge answered to the
// fake script skips the credentials check instead of failing it),
// MELODICA_RELAY_TOKEN (the fake script sends it as Authorization: Bearer, as the
// real extension sends its own; without it a 401 from the gated relay skips the
// credentials check with a log line). The local server answers /melodica/auth/me
// with 503 (gate not configured) so the Pandora login shows directly.
//
// Artifacts: tests/artifacts/bridge-login-screen.png, bridge-login-error.png.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const RELAY = process.env.MELODICA_API || 'https://spacegho.st/melodica/api/';
const ALLOW_RELAY_BLOCK = process.env.MELODICA_BROWSER_ALLOW_RELAY_BLOCK === '1';
const TOKEN = process.env.MELODICA_RELAY_TOKEN || '';
const ARTIFACTS = resolve(here, 'artifacts');
const APP_PATH = '/melodica/app/';
const EXT = { name: 'melodica extension', version: '0.1.0' };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8',
};
// The site worker's APP_CSP; the relay origin is in connect-src only because
// the fake content script fetches from the page world (a real extension does
// its fetch from its own context).
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; ` +
  `style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src https: http:; ` +
  `connect-src 'self' ${new URL(RELAY).origin}; font-src 'self'; base-uri 'none'; form-action 'none'; ` +
  `frame-ancestors 'none'; worker-src 'self'`;

let server = null;
let base = '';

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/melodica/auth/me') {
      // The gate is the Worker's; this fake has none, so the page goes straight to the Pandora login.
      res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"auth not configured"}'); return;
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
  if (!TOKEN) console.log('MELODICA_RELAY_TOKEN is not set: if the relay is gated (GitHub sign-in), the credentials step is skipped.');
});

test.afterAll(async () => {
  if (server) await new Promise((ok) => server.close(ok));
});

// Chromium logs "Failed to load resource" for every non-2xx answer, including the
// ones the gate handles on purpose (/auth/me 503/401, the relay's 401). Those are
// not errors of the page; everything else is kept.
function expectedResourceError(msg) {
  if (msg.type() !== 'error' || !/Failed to load resource/.test(msg.text())) return false;
  const url = (msg.location() && msg.location().url) || '';
  return /\/melodica\/auth\//.test(url) || (/status of 401/.test(msg.text()) && /\/melodica\/api\//.test(url));
}

// The fake content script. Runs in the page world before app.js; `relay` is
// where it forwards requests, `token` the access token it sends (the real
// extension holds its own). window.__bridgeLog records what it saw.
function fakeContentScript({ relay, ext, token }) {
  window.__bridgeLog = [];
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.melodica !== 1) return;
    if (d.type === 'hello') {
      window.__bridgeLog.push('hello');
      window.postMessage({ melodica: 1, type: 'ready', name: ext.name, version: ext.version }, location.origin);
      return;
    }
    if (d.type !== 'request') return;
    const method = new URLSearchParams(d.search).get('method');
    window.__bridgeLog.push(`request ${method} id=${d.id} body=${d.body instanceof Uint8Array ? d.body.length : typeof d.body}`);
    let reply;
    try {
      const headers = { 'content-type': 'text/plain' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(relay + d.search, { method: 'POST', headers, body: d.body });
      reply = { ok: res.ok, status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
      window.__bridgeLog.push(`response ${method} ${res.status}`);
    } catch (err) {
      reply = { ok: false, status: 0, body: new Uint8Array(0), error: String(err) };
      window.__bridgeLog.push(`response ${method} error ${err}`);
    }
    window.postMessage({ melodica: 1, type: 'response', id: d.id, ...reply }, location.origin);
  });
}

async function openApp(page, url) {
  const evidence = { console: [], errors: [], failed: [], relay: [], url };
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (ev) => {
      window.__cspViolations.push({ directive: ev.violatedDirective, blocked: ev.blockedURI, source: ev.sourceFile, line: ev.lineNumber });
    });
  });
  await page.addInitScript(fakeContentScript, { relay: RELAY, ext: EXT, token: TOKEN });
  page.on('console', (msg) => { if (!expectedResourceError(msg)) evidence.console.push(`[${msg.type()}] ${msg.text()}`); });
  page.on('pageerror', (err) => evidence.errors.push(String(err && err.stack || err)));
  page.on('requestfailed', (req) => evidence.failed.push(`${req.method()} ${req.url()} ${req.failure()?.errorText}`));
  page.on('response', (res) => {
    if (res.url().startsWith(RELAY)) evidence.relay.push({ method: new URL(res.url()).searchParams.get('method'), status: res.status() });
  });
  await page.goto(url, { waitUntil: 'load' });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
  await expect(page.locator('#status')).toContainText('melodica.h');
  return evidence;
}

async function finish(page, evidence, info) {
  evidence.violations = await page.evaluate(() => window.__cspViolations);
  evidence.bridgeLog = await page.evaluate(() => window.__bridgeLog);
  evidence.status = await page.locator('#status').textContent();
  const lines = [
    `url: ${evidence.url}`, `status line: ${evidence.status}`,
    `bridge log (${evidence.bridgeLog.length}):`, ...evidence.bridgeLog.map((l) => `  ${l}`),
    `relay fetches by the fake script (${evidence.relay.length}):`, ...evidence.relay.map((r) => `  ${r.method} -> HTTP ${r.status}`),
    `console (${evidence.console.length}):`, ...evidence.console.map((l) => `  ${l}`),
    `page errors (${evidence.errors.length}):`, ...evidence.errors.map((l) => `  ${l}`),
    `failed requests (${evidence.failed.length}):`, ...evidence.failed.map((l) => `  ${l}`),
    `csp violations (${evidence.violations.length}):`, ...evidence.violations.map((v) => `  ${JSON.stringify(v)}`),
  ];
  console.log(lines.join('\n'));
  await info.attach('evidence', { body: lines.join('\n'), contentType: 'text/plain' });
}

test.describe.serial('extension bridge', () => {
  test('a ready content script switches the transport to direct', async ({ page }, info) => {
    const evidence = await openApp(page, base);
    try {
      await expect(page.locator('#status')).toContainText(`direct via ${EXT.name} ${EXT.version}`);
      await expect(page.locator('#status')).not.toContainText('relay');
      await page.screenshot({ path: resolve(ARTIFACTS, 'bridge-login-screen.png') });
      await info.attach('bridge-login-screen', { path: resolve(ARTIFACTS, 'bridge-login-screen.png'), contentType: 'image/png' });
      expect(await page.evaluate(() => window.__bridgeLog)).toEqual(['hello']);
      expect(evidence.errors, 'uncaught page errors').toEqual([]);
      expect(evidence.console.filter((l) => l.startsWith('[error]')), 'console errors').toEqual([]);
      expect(await page.evaluate(() => window.__cspViolations), 'CSP violations').toEqual([]);
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('sign-in round trips are carried by the bridge', async ({ page }, info) => {
    const evidence = await openApp(page, base);
    try {
      await expect(page.locator('#status')).toContainText('direct via');
      await page.fill('#login-email', 'nobody@example.invalid');
      await page.fill('#login-password', 'wrong');
      await page.click('#login-button');
      const message = page.locator('#login-message');
      await expect(message).not.toHaveText(/^(Signing in…)?$/, { timeout: 25_000 });
      const text = (await message.textContent()).trim();
      info.annotations.push({ type: 'login-message', description: text });
      await page.screenshot({ path: resolve(ARTIFACTS, 'bridge-login-error.png') });
      await info.attach('bridge-login-error', { path: resolve(ARTIFACTS, 'bridge-login-error.png'), contentType: 'image/png' });

      const log = await page.evaluate(() => window.__bridgeLog);
      expect(log[0]).toBe('hello');
      expect(log.some((l) => l.startsWith('request auth.partnerLogin ')), 'partnerLogin went through the bridge').toBe(true);
      expect(log.filter((l) => l.startsWith('request ')).every((l) => / id=mw-\d+-\S+ body=\d+$/.test(l)), 'requests carry an id and a Uint8Array body').toBe(true);

      const relayBlocked = /answered HTTP 403 via the melodica extension/.test(text) && evidence.relay.some((r) => r.status === 403);
      if (relayBlocked && ALLOW_RELAY_BLOCK) {
        console.log('WARNING: the relay answered HTTP 403 (Cloudflare challenge) to the fake content script; the error was reported through the bridge but the credentials path could not be exercised here.');
        test.skip(true, 'relay blocked by Cloudflare from this network (MELODICA_BROWSER_ALLOW_RELAY_BLOCK=1)');
      }
      const relayGated = evidence.relay.some((r) => r.status === 401);
      if (relayGated && !TOKEN) {
        console.log('WARNING: the relay answered HTTP 401 (GitHub sign-in gate) to the fake content script and MELODICA_RELAY_TOKEN is not set; the 401 travelled through the bridge, but the credentials path could not be exercised here.');
        await expect(page.locator('#app')).toHaveAttribute('data-view', 'github');
        test.skip(true, 'relay gated (GitHub sign-in) and no MELODICA_RELAY_TOKEN');
      }
      expect(relayGated, 'the relay rejected MELODICA_RELAY_TOKEN (401)').toBe(false);
      expect(text, 'login message').toMatch(/wrong email address or password|invalid (username|password|credentials)/i);
      expect(log.some((l) => l.startsWith('request auth.userLogin ')), 'userLogin went through the bridge').toBe(true);
      expect(evidence.errors, 'uncaught page errors').toEqual([]);
      expect(evidence.console.filter((l) => l.startsWith('[error]')), 'console errors').toEqual([]);
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login');
    } finally {
      await finish(page, evidence, info);
    }
  });

  test('an explicit ?api= wins over the bridge', async ({ page }, info) => {
    const url = `${base}?api=${encodeURIComponent(RELAY)}`;
    const evidence = await openApp(page, url);
    try {
      await expect(page.locator('#status')).toContainText(`via ${new URL(RELAY).host} relay (?api=)`);
      await expect(page.locator('#status')).not.toContainText('direct');
      expect(await page.evaluate(() => window.__bridgeLog), 'no hello is posted when ?api= is set').toEqual([]);
      expect(evidence.errors, 'uncaught page errors').toEqual([]);
    } finally {
      await finish(page, evidence, info);
    }
  });
});
