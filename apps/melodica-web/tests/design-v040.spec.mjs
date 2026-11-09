// The desktop look must stay v0.4.0's. The player view (remote mode, driven by a
// still fake extension so both builds show the same track, cover and wash) is
// rendered from this build and from the v0.4.0 release at 1920x1080 and 2560x1440,
// dark and light, in the same browser; the two must differ in under 1% of the
// pixels. The status line and the footer (version text) are masked.
//
// Env: MELODICA_V040_DIST, the extracted dist/ of the v0.4.0 release
// (melodica-web-0.4.0.tar.gz); the test is skipped without it. MELODICA_DIST.
// Artifacts: tests/artifacts/design-v040-<scheme>-<w>x<h>-{v040,now}.png.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const OLD = process.env.MELODICA_V040_DIST ? resolve(process.env.MELODICA_V040_DIST) : '';
const ARTIFACTS = resolve(here, 'artifacts');
const APP_PATH = '/melodica/app/';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm' };
const csp = (nonce) => `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
  `img-src 'self' data: https:; media-src https: http: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'`;
const SIZES = [[1920, 1080], [2560, 1440]];

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
let old = null;
test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (!OLD || !existsSync(join(OLD, 'index.html'))) return;
  now = await serveDir(DIST);
  old = await serveDir(OLD);
});
test.afterAll(async () => {
  for (const s of [now, old]) if (s) await new Promise((ok) => s.server.close(ok));
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
  // 0.11.0 moved the controls into the player bar pinned to the viewport and added the
  // top menu, so the page is compared where the design must not change: the stage
  // (cover, title, artist, album, quality, progress).
  // Whole pixels: the stage may sit at a fractional offset (a 1 px taller element shot).
  const box = await page.locator('section.stage').boundingBox();
  const stage = await page.screenshot({ animations: 'disabled', clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
  await ctx.close();
  return { shot, stage };
}

for (const scheme of ['dark', 'light']) {
  for (const [w, h] of SIZES) {
    test(`player at ${w}x${h} (${scheme}) looks like v0.4.0`, async ({ browser }, info) => {
      test.skip(!old, 'no v0.4.0 build: set MELODICA_V040_DIST');
      const name = `design-v040-${scheme}-${w}x${h}`;
      const before = await render(browser, old.url, w, h, scheme);
      const after = await render(browser, now.url, w, h, scheme);
      await writeFile(resolve(ARTIFACTS, `${name}-v040.png`), before.shot);
      await writeFile(resolve(ARTIFACTS, `${name}-now.png`), after.shot);
      // The v0.4.0 render is the reference for this run's comparison.
      for (const part of ['stage']) {
        const ref = info.snapshotPath(`${name}-${part}.png`);
        await mkdir(dirname(ref), { recursive: true });
        await writeFile(ref, before[part]);
        expect(after[part]).toMatchSnapshot(`${name}-${part}.png`, { maxDiffPixelRatio: 0.01, threshold: 0.02 });
      }
    });
  }
}
