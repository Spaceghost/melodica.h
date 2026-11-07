// The optional spacegho.st sign-in end to end, in Chromium. The browser is on
// https://spacegho.st itself: Chromium resolves spacegho.st to a local HTTPS server
// (--host-resolver-rules, a throwaway self-signed certificate, ignoreHTTPSErrors)
// that serves the app from dist/ with the site's CSP and /oauth/* and /.well-known/*
// from the account server. Origin, redirect URI, issuer, redirects and Secure cookies
// are production's, and nothing reaches the real site. The account server is
//
//   - SPACEGHOST_AUTH_DIR=<spaceghost-auth checkout>: the real Worker's handle() over
//     its own test harness (D1 on node:sqlite with the real migrations and client
//     registrations, a fake GitHub bridge, an email binding that records messages);
//   - otherwise tests/tools/fake-account.mjs, which implements the same contract,
//     routes, pages and cookies (CI: the Worker's repository is private).
//
// Covered, for an email-only account and a GitHub-linked one:
//   invite accepted -> "Sign in with spacegho.st" -> code + PKCE -> tokens -> policy
//   fetched with the bearer token; the account line shows the display name (never
//   GitHub wording for an email account); a returning email account signs in through
//   the emailed link; a per-account policy change is picked up; sign-out revokes; a
//   page without an account server shows no sign-in link. No network.
//
// Artifacts: tests/artifacts/account-email.png, account-github.png.

import { test, expect } from '@playwright/test';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { makeBackend } from './tools/fake-account.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const ARTIFACTS = resolve(here, 'artifacts');
const AUTH_DIR = process.env.SPACEGHOST_AUTH_DIR || '';
const ORIGIN = 'https://spacegho.st';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm' };
// The site worker's APP_CSP: connect-src 'self' covers the account server on the same origin.
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
  `img-src 'self' data: https:; media-src https: http:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'`;

// The real Worker, with test data for this origin.
async function realBackend(issuer, dir) {
  const imp = (p) => import(pathToFileURL(resolve(dir, p)).href);
  const { handle } = await imp('src/worker.js');
  const { fakeD1, fakeBridge } = await imp('tests/helpers.mjs');
  const { generateSigningKey, sha256b64url, randomToken } = await imp('src/crypto.js');
  const mail = [];
  const env = {
    DB: fakeD1(), SIGNING_KEY: JSON.stringify(await generateSigningKey()), ISSUER: issuer,
    EMAIL_SENDING: 'on',
    EMAIL: { async send(m) { const link = /\S+\/oauth\/email\/verify\?t=[A-Za-z0-9_-]+/.exec(`${m.text} ${m.html}`); mail.push({ to: m.to, link: link && link[0] }); } },
    GITHUB_BRIDGE: fakeBridge({ alice: { id: 424242 } }),
  };
  const now = () => Math.floor(Date.now() / 1000);
  return {
    kind: 'real spaceghost-auth',
    mail,
    handle: (req) => handle(req, env, { now, fetch: async () => { throw new Error('no network in this test'); } }),
    async invite(email) {
      const t = randomToken(32);
      await env.DB.prepare('INSERT INTO invites (id, email, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(`inv_${randomToken(8)}`, email.toLowerCase(), await sha256b64url(t), now(), now() + 14 * 86400).run();
      return t;
    },
    // What /oauth/admin's per-account override does.
    async setPolicy(name, { ads }) {
      const r = await env.DB.prepare('UPDATE users SET override = ? WHERE display_name = ?').bind(ads ? 'standard' : 'full', name).run();
      if (!r.meta.changes) throw new Error(`no account ${name}`);
    },
  };
}

let origin = ORIGIN;
let backend = null;
let accountServer = true;

// The local spacegho.st: every request the browser makes to https://spacegho.st/.
// GitHub's authorize page, as GitHub would answer it: straight back with a code for
// `githubLogin` (both backends' GitHub step turns code-<login> into that account).
let githubLogin = 'alice';
async function serve(req, res) {
  if ((req.headers.host || '').startsWith('github.com')) {
    const state = new URL(req.url, 'https://github.com').searchParams.get('state') || '';
    res.writeHead(302, { location: `${ORIGIN}/oauth/github/callback?code=code-${githubLogin}&state=${encodeURIComponent(state)}` });
    res.end();
    return;
  }
  const url = new URL(req.url, ORIGIN);
  try {
    if (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/')) {
      if (!accountServer) { res.writeHead(404); res.end('not found'); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (k !== 'host') headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const r = await backend.handle(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      const out = {};
      r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
      if (r.headers.getSetCookie().length) out['set-cookie'] = r.headers.getSetCookie();
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (!url.pathname.startsWith('/melodica/app/')) { res.writeHead(404); res.end('not found'); return; }
    let rel = url.pathname.slice('/melodica/app/'.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some((p) => !p || p === '.' || p === '..')) { res.writeHead(404); res.end(); return; }
    const body = await readFile(resolve(DIST, rel));
    const type = MIME[extname(rel)] || 'application/octet-stream';
    const headers = { 'content-type': type };
    if (type.startsWith('text/html')) headers['content-security-policy'] = csp(randomBytes(16).toString('base64'));
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500); res.end(String(err && err.stack || err));
  }
}

let server = null;
let certDir = '';
let port = 0;

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  certDir = await mkdtemp(join(tmpdir(), 'melodica-account-'));
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=spacegho.st',
    '-addext', 'subjectAltName=DNS:spacegho.st,DNS:github.com', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { encoding: 'utf8' });
  if (gen.status !== 0) throw new Error(`openssl: ${gen.stderr}`);
  server = https.createServer({ key: await readFile(join(certDir, 'key.pem')), cert: await readFile(join(certDir, 'cert.pem')) }, serve);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  port = server.address().port;
  backend = AUTH_DIR ? await realBackend(origin, AUTH_DIR)
    : makeBackend(origin, { github: { alice: { ads: false } }, emailSending: true });
  console.log(`account server: ${backend.kind}; https://spacegho.st -> 127.0.0.1:${port}`);
});

test.afterAll(async () => {
  if (server) await new Promise((ok) => server.close(ok));
  if (certDir) await rm(certDir, { recursive: true, force: true });
});

// spacegho.st (and nothing else) goes to the local server; everything else is refused,
// so no request can reach the real site or any other host.
test.use({
  ignoreHTTPSErrors: true,
  launchOptions: { args: [] },
});
let browserForSite = null;
async function site(_browser, options = {}) {
  const { chromium } = await import('@playwright/test');
  if (!browserForSite) {
    browserForSite = await chromium.launch({ args: [`--host-resolver-rules=MAP spacegho.st:443 127.0.0.1:${port}, MAP github.com:443 127.0.0.1:${port}, MAP * ~NOTFOUND`] });
  }
  return browserForSite.newContext({ ignoreHTTPSErrors: true, ...options });
}
test.afterAll(async () => { if (browserForSite) await browserForSite.close(); });

const app = () => `${origin}/melodica/app/`;

// Opens the app, clicks "Sign in with spacegho.st" and follows the browser until it is back
// on the app; `onAuthorizePage` handles the sign-in page when there is no session.
async function signIn(page, onAuthorizePage) {
  await page.goto(app());
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
  await expect(page.locator('#account-signin')).toBeVisible();
  await expect(page.locator('#account-signin')).toHaveText('Sign in with spacegho.st');
  const policy = page.waitForResponse((r) => r.url().endsWith('/oauth/melodica/policy') && r.request().headers().authorization, { timeout: 30_000 });
  await page.click('#account-signin');
  if (onAuthorizePage) {
    await page.waitForURL(/\/oauth\/authorize\?/);
    await onAuthorizePage(page);
  }
  const res = await policy;
  await page.waitForURL((u) => u.pathname === '/melodica/app/');
  await expect(page.locator('#account-signed')).toBeVisible({ timeout: 20_000 });
  const url = new URL(page.url());
  expect(url.searchParams.get('code'), 'the code is removed from the address bar').toBeNull();
  expect(url.searchParams.get('state')).toBeNull();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('melodica.account')));
  expect(typeof stored.refresh).toBe('string');
  return { policy: await res.json(), bearer: res.request().headers().authorization };
}

function noErrors(evidence) {
  expect(evidence.errors, 'uncaught page errors').toEqual([]);
}

test.describe.serial('spacegho.st sign-in (optional)', () => {
  let palState = null; // the email account's browser storage, for the later tests

  test('email-only account: invite accepted, then sign in, then policy fetched', async ({ browser }, info) => {
    const context = await site(browser);
    const page = await context.newPage();
    const evidence = { errors: [] };
    page.on('pageerror', (e) => evidence.errors.push(String(e)));
    const t = await backend.invite('Pal@Example.com');
    await page.goto(`${origin}/oauth/invite?t=${t}`);
    await page.getByRole('button', { name: 'Accept and sign in' }).click();
    await page.waitForURL(`${origin}/oauth/`);
    // The session cookie set by the invite is what authorize uses: no sign-in page.
    const { policy, bearer } = await signIn(page, null);
    console.log(`email account policy: ${JSON.stringify(policy)}`);
    expect(bearer).toMatch(/^Bearer \S+/);
    expect(policy.playback.ads).toBe(true);
    expect(policy.display.name).toBe('pal');
    await expect(page.locator('#account-name')).toHaveText('pal');
    await expect(page.locator('#account-line')).not.toContainText('GitHub');
    await page.screenshot({ path: resolve(ARTIFACTS, 'account-email.png') });
    await info.attach('account-email', { path: resolve(ARTIFACTS, 'account-email.png'), contentType: 'image/png' });
    noErrors(evidence);
    palState = await context.storageState();
    await context.close();
  });

  test('a returning email account signs in through the emailed link', async ({ browser }) => {
    const context = await site(browser); // no session, no tokens
    const page = await context.newPage();
    const { policy } = await signIn(page, async (p) => {
      // The sign-in page offers email because sending is on.
      await expect(p.getByRole('button', { name: 'Continue with email' })).toBeVisible();
      await p.getByLabel('Email address').fill('pal@example.com');
      const sent = backend.mail.length;
      await p.getByRole('button', { name: 'Continue with email' }).click();
      await expect(p.locator('h2')).toHaveText('Check your email');
      expect(backend.mail.length, 'a sign-in link was emailed').toBe(sent + 1);
      const { to, link } = backend.mail.at(-1);
      expect(to).toBe('pal@example.com');
      await p.goto(link);
      await p.getByRole('button', { name: 'Sign in' }).click();
    });
    expect(policy.display.name).toBe('pal');
    await expect(page.locator('#account-name')).toHaveText('pal');
    await context.close();
  });

  test('GitHub-linked account: sign in through GitHub, then policy fetched', async ({ browser }, info) => {
    const context = await site(browser); // github.com is the local server too (see serve)
    githubLogin = 'alice';
    const page = await context.newPage();
    const evidence = { errors: [] };
    page.on('pageerror', (e) => evidence.errors.push(String(e)));
    const { policy } = await signIn(page, async (p) => {
      await p.getByRole('link', { name: 'Continue with GitHub' }).click();
    });
    console.log(`GitHub account policy: ${JSON.stringify(policy)}`);
    expect(policy.display.name).toBe('alice');
    expect(typeof policy.playback.ads).toBe('boolean');
    await expect(page.locator('#account-name')).toHaveText('alice');
    await page.screenshot({ path: resolve(ARTIFACTS, 'account-github.png') });
    await info.attach('account-github', { path: resolve(ARTIFACTS, 'account-github.png'), contentType: 'image/png' });
    noErrors(evidence);
    await context.close();
  });

  test('the policy is the account\'s: a per-account change shows on the next start', async ({ browser }) => {
    const context = await site(browser, { storageState: palState });
    const page = await context.newPage();
    const first = page.waitForResponse((r) => r.url().endsWith('/oauth/melodica/policy') && r.request().headers().authorization);
    await page.goto(app());
    expect((await (await first).json()).playback.ads).toBe(true);
    await backend.setPolicy('pal', { ads: false });
    const again = page.waitForResponse((r) => r.url().endsWith('/oauth/melodica/policy') && r.request().headers().authorization);
    await page.reload();
    const body = await (await again).json();
    console.log(`after the per-account change: ${JSON.stringify(body)}`);
    expect(body.playback.ads).toBe(false);
    await backend.setPolicy('pal', { ads: true });
    await context.close();
  });

  test('sign-out forgets the tokens and revokes; the sign-in link comes back', async ({ browser }) => {
    const context = await site(browser, { storageState: palState });
    const page = await context.newPage();
    await page.goto(app());
    await expect(page.locator('#account-signed')).toBeVisible({ timeout: 20_000 });
    const revoke = page.waitForRequest((r) => r.url().endsWith('/oauth/revoke') && r.method() === 'POST');
    await page.click('#account-signout');
    expect((await revoke).postData()).toMatch(/token=/);
    await expect(page.locator('#account-signin')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('melodica.account'))).toBeNull();
    await context.close();
  });

  test('without an account server the page shows no sign-in link', async ({ browser }) => {
    accountServer = false;
    const context = await site(browser);
    const page = await context.newPage();
    try {
      await page.goto(app());
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
      await expect(page.locator('#login-email')).toBeVisible();
      await expect(page.locator('#account-line')).toBeHidden();
    } finally {
      accountServer = true;
      await context.close();
    }
  });
});
