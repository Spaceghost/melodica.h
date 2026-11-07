// Browser test configuration. Run: npx playwright test (after
// `npm install` and `npx playwright install chromium`).
// See tests/browser.spec.mjs and tests/smoke-tuner.spec.mjs for the
// environment variables they read; smoke-tuner skips itself without a tuner.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: ['browser.spec.mjs', 'bridge.spec.mjs', 'remote.spec.mjs', 'design.spec.mjs', 'account.spec.mjs', 'smoke-tuner.spec.mjs', 'smoke-ads.spec.mjs'],
  outputDir: 'tests/artifacts/playwright',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1280, height: 800 },
    // A plain desktop UA: the hosted page sits behind Cloudflare bot
    // protection and the point is to observe what a browser sees, not to
    // disguise anything beyond dropping "HeadlessChrome".
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    screenshot: 'off',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
