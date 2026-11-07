// Design screenshots: every view at phone (390x844) and desktop (1280x800).
// Not a pass/fail test of looks; it records what the layout is and checks the
// one-column rule (the content column is at most 520 px wide and centered).
// Views: GitHub sign-in, Pandora login, player (remote mode against a fake
// extension with a track playing), stations sheet. No network.
// Output: tests/artifacts/design-<view>-<w>x<h>.png (DESIGN_TAG prefixes the name).
import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const ARTIFACTS = resolve(here, 'artifacts');
const TAG = process.env.DESIGN_TAG ? `${process.env.DESIGN_TAG}-` : '';
const CHECK_COLUMN = process.env.DESIGN_CHECK_COLUMN !== '0';
const APP_PATH = '/melodica/app/';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm' };
const SIZES = [[390, 844], [1280, 800]];
let server = null;
let base = '';
let gate = 'anonymous';

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/melodica/auth/me') {
      const [s, b] = gate === 'off' ? [503, { error: 'auth not configured' }] : [401, { error: 'missing token' }];
      res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); return;
    }
    if (!url.pathname.startsWith(APP_PATH)) { res.writeHead(404); res.end(); return; }
    let rel = url.pathname.slice(APP_PATH.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    try {
      const body = await readFile(resolve(DIST, rel));
      res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}${APP_PATH}`;
});
test.afterAll(async () => { if (server) await new Promise((ok) => server.close(ok)); });

// A fake extension already playing a track (remote mode), so the player view has content.
function fakeExtension() {
  const st = {
    status: 'playing', station: { token: 'S1', name: 'Aurora Fields Radio' },
    track: { title: 'Slow Light', artist: 'Aurora Fields', album: 'Northern Lines', trackToken: 'T1', duration: 214, rating: 1, coverArt: '', quality: 'high', audioFormat: 'aacplus' },
    position: 71, duration: 214, volume: 80, quality: 'high', queueLength: 3, error: '', history: [], loggedIn: true,
    gate: { mode: 'allowed', login: 'alice' },
    stations: [
      { token: 'QM', name: 'QuickMix', isQuickMix: true }, { token: 'S1', name: 'Aurora Fields Radio' },
      { token: 'S2', name: 'Band Two Radio' }, { token: 'S3', name: 'Late Night Piano Radio' },
      { token: 'S4', name: 'Slow Light Radio' }, { token: 'S5', name: 'Morning Coffee' },
    ],
  };
  const post = (m) => window.postMessage({ melodica: 1, ...m }, location.origin);
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.melodica !== 1) return;
    if (d.type === 'hello') post({ type: 'ready', name: 'melodica-extension', version: '0.3.0', player: true });
    if (d.type === 'subscribe') post({ type: 'state', state: st });
    if (d.type === 'command') post({ type: 'result', id: d.id, ok: true, state: st });
  });
}

async function shot(page, name, w, h) {
  const path = resolve(ARTIFACTS, `design-${TAG}${name}-${w}x${h}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`screenshot ${path}`);
}

// The visible content column: the widest visible card-like box in the active view.
async function column(page) {
  return page.evaluate(() => {
    const view = document.querySelector('.view:not([hidden])');
    const boxes = [...view.querySelectorAll('.card, .panel')].filter((n) => n.offsetParent).map((n) => n.getBoundingClientRect());
    const r = boxes.reduce((a, b) => (b.width > a.width ? b : a), boxes[0]);
    return { left: r.left, right: innerWidth - r.right, width: r.width, vw: innerWidth };
  });
}
function expectColumn(c) {
  if (!CHECK_COLUMN) return;
  expect(c.width, 'content column width').toBeLessThanOrEqual(522);
  expect(Math.abs(c.left - c.right), 'content column is centered').toBeLessThanOrEqual(2);
}

for (const [w, h] of SIZES) {
  test.describe(`${w}x${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test('GitHub sign-in', async ({ page }) => {
      gate = 'anonymous';
      await page.goto(base);
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'github', { timeout: 30_000 });
      await shot(page, 'github', w, h);
      expectColumn(await column(page));
    });

    test('Pandora login', async ({ page }) => {
      gate = 'off';
      await page.goto(base);
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'login', { timeout: 30_000 });
      await shot(page, 'login', w, h);
      expectColumn(await column(page));
    });

    test('player (remote mode)', async ({ page }) => {
      gate = 'off';
      await page.addInitScript(fakeExtension);
      await page.goto(base);
      await expect(page.locator('#app')).toHaveAttribute('data-view', 'player', { timeout: 30_000 });
      await expect(page.locator('#np-title')).toHaveText('Slow Light');
      await shot(page, 'player', w, h);
      expectColumn(await column(page));
      const open = page.locator('#stations-open');
      if (await open.count()) {
        await open.click();
        await expect(page.locator('#station-list button.station').first()).toBeVisible();
        await page.waitForTimeout(400); // the sheet's rise animation
        await page.screenshot({ path: resolve(ARTIFACTS, `design-${TAG}stations-${w}x${h}.png`) }); // viewport: the sheet is fixed
        console.log(`screenshot design-${TAG}stations-${w}x${h}.png`);
      }
    });
  });
}
