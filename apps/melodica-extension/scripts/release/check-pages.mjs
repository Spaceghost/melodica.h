import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkPages(version, output) {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        for (const path of ['/extensions/', '/melodica/extension/']) {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', e => errors.push(String(e)));
          await page.goto(`https://spacegho.st${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          const scope = path.startsWith('/melodica/') ? '#route-body' : 'main';
          await page.locator(`${scope} #melodica-extension`).waitFor({ state: 'visible', timeout: 45000 });
          const result = await page.evaluate(({ scope, path, width, version }) => {
            const root = document.querySelector(scope);
            const card = root.querySelector('#melodica-extension');
            const bar = document.getElementById('bar');
            return { path, width, version: card.textContent.includes(version),
              ids: [...root.querySelectorAll('section.card[id]')].map(x => x.id),
              links: [...card.querySelectorAll('a[href]')].map(a => a.href),
              allStore: !!root.querySelector('a[href="https://spacegho.st/extensions/"]'),
              overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
              bar: bar ? { bottom: bar.getBoundingClientRect().bottom, height: innerHeight } : null };
          }, { scope, path, width, version });
          assert.equal(result.version, true, `${path}: visible release version`);
          assert.equal(result.overflow, false, `${path}: horizontal overflow at ${width}`);
          if (path.startsWith('/melodica/')) {
            assert.deepEqual(result.ids, ['melodica-extension']);
            assert.equal(result.allStore, true);
            assert.ok(result.bar && Math.abs(result.bar.bottom - result.bar.height) <= 2, 'Player bar remains pinned');
          }
          for (const suffix of ['.xpi', '.crx', '-chrome.zip', '-firefox.zip']) {
            assert.ok(result.links.some(url => url.includes(`melodica-extension-${version}${suffix}`)), `${path}: missing ${suffix}`);
          }
          assert.deepEqual(errors, []);
          results.push({ ...result, errors });
          await page.screenshot({ path: join(output, `${width}-${path.startsWith('/melodica/') ? 'melodica' : 'store'}.png`), fullPage: true });
          await page.close();
        }
      } finally { await context.close(); }
    }
    await writeFile(join(output, 'pages.json'), JSON.stringify(results, null, 2) + '\n');
    return results.map(({ path, width, version, overflow, errors }) => ({ path, width, version, overflow, errors }));
  } finally { await browser.close(); }
}
