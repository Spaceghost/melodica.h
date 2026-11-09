// The player keeps the established blue/gold skin, checked at desktop and phone sizes.
//
// Env: MELODICA_DIST. Artifacts: tests/artifacts/design-system-<scheme>-<w>x<h>.png.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const ARTIFACTS = resolve(here, 'artifacts');
const APP_PATH = '/melodica/app/';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm' };
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
  `img-src 'self' data: https:; media-src https: http: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'`;
const SIZES = [[1440, 900], [390, 844]];

function serveDir(dir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(APP_PATH)) { res.writeHead(404); res.end(); return; }
    let rel = url.pathname.slice(APP_PATH.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some((p) => !p || p === '.' || p === '..')) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(join(dir, rel));
      const type = MIME[extname(rel)] || 'application/octet-stream';
      const headers = { 'content-type': type };
      if (type.startsWith('text/html')) headers['content-security-policy'] = csp(randomBytes(16).toString('base64'));
      res.writeHead(200, headers); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}${APP_PATH}` })));
}

// A still extension: one playing track, a fixed position, no ticking.
function stillExtension() {
  const cover = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b6f8f"/><stop offset="1" stop-color="#c9883a"/></linearGradient></defs><rect width="500" height="500" fill="url(#g)"/><circle cx="250" cy="250" r="120" fill="#f0d9a4" opacity="0.6"/></svg>');
  const st = {
    status: 'paused', loggedIn: true, volume: 70, quality: 'high', queueLength: 3, position: 42, duration: 200,
    station: { token: 'S1', name: 'Aurora Fields Radio' },
    track: { title: 'Slow Light', artist: 'Aurora Fields', album: 'Northern', trackToken: 'T1', duration: 200, rating: 0, coverArt: cover, quality: 'high', audioFormat: 'aacplus' },
    stations: [
      { token: 'QM', name: 'QuickMix', isQuickMix: true }, { token: 'S1', name: 'Aurora Fields Radio' },
      { token: 'S2', name: 'Band Two Radio' }, { token: 'S3', name: 'Northern Lights Radio' },
    ],
    history: [],
  };
  const post = (m) => window.postMessage({ melodica: 1, ...m }, location.origin);
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.melodica !== 1) return;
    if (d.type === 'hello') post({ type: 'ready', name: 'melodica-extension', version: '0.3.0', player: true });
    else if (d.type === 'subscribe') post({ type: 'state', state: st });
  });
}

let now = null;
test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  now = await serveDir(DIST);
});
test.afterAll(async () => {
  if (now) await new Promise((ok) => now.server.close(ok));
});

async function render(browser, url, w, h, scheme) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript(stillExtension);
  await page.goto(url);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'remote', { timeout: 15_000 });
  await expect(page.locator('#np-title')).toHaveText('Slow Light');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1600); // the wash fades in over 1.2 s (no transition with reduced motion, but be safe)
  const shot = await page.screenshot({ mask: [page.locator('#status'), page.locator('footer.foot')], animations: 'disabled' });
  const contract = await page.evaluate(() => {
    const cover = document.querySelector('#cover');
    const play = document.querySelector('#btn-play');
    const stage = document.querySelector('.stage');
    const c = getComputedStyle(cover), p = getComputedStyle(play), h = getComputedStyle(document.querySelector('#np-title'));
    return {
      coverWidth: cover.getBoundingClientRect().width,
      coverHeight: cover.getBoundingClientRect().height,
      coverRadius: c.borderRadius,
      titleFont: h.fontFamily,
      playRadius: p.borderRadius,
      playColor: p.backgroundColor,
      pageWidth: document.documentElement.scrollWidth,
      stageVisible: stage.getBoundingClientRect().width > 0,
      mode: document.querySelector('#app').dataset.mode,
    };
  });
  await ctx.close();
  return { shot, contract };
}

for (const [w, h] of SIZES) {
  test(`player design contract at ${w}x${h}`, async ({ browser }) => {
    const { shot, contract } = await render(browser, now.url, w, h, 'dark');
    const name = `design-system-dark-${w}x${h}`;
    await writeFile(resolve(ARTIFACTS, `${name}.png`), shot);
    expect(contract.mode).toBe('remote');
    expect(contract.stageVisible).toBe(true);
    expect(contract.coverWidth).toBeGreaterThanOrEqual(w < 500 ? 180 : 240);
    expect(contract.coverHeight).toBe(contract.coverWidth);
    expect(contract.coverRadius).toBe('12px');
    expect(contract.titleFont.toLowerCase()).toMatch(/palatino|palladio|georgia/);
    expect(contract.playRadius).toBe('14px');
    expect(contract.playColor).toBe('rgb(21, 27, 40)');
    expect(contract.pageWidth).toBeLessThanOrEqual(w);
  });
}
