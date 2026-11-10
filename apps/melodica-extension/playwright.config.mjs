// Smoke test configuration. The spec launches its own persistent Chromium
// context with the unpacked extension (see tests/smoke-extension.spec.mjs),
// so most `use` options here are irrelevant; keep one worker and no retries.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: ['smoke-extension.spec.mjs', 'cdn-playback.spec.mjs'],
  outputDir: 'tests/artifacts/playwright',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: { actionTimeout: 20_000, navigationTimeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  projects: [{ name: 'chromium' }],
});
