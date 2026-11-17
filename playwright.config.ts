import { defineConfig } from '@playwright/test';

const timeoutMultiplier = Number(process.env.E2E_TIMEOUT_MULTIPLIER ?? 1);
if (![1, 2].includes(timeoutMultiplier)) throw new Error('Expected E2E_TIMEOUT_MULTIPLIER 1 or 2.');

export default defineConfig({
  testDir: process.env.E2E_EXPERIMENT_TEST_DIR ?? 'e2e',
  testMatch: process.env.E2E_PROFILE_ONLY === '1' ? '**/*.probe.ts' : '**/*.spec.ts',
  fullyParallel: true,
  retries: 0,
  timeout: 30_000 * timeoutMultiplier,
  expect: { timeout: 10_000 * timeoutMultiplier },
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    acceptDownloads: true,
    offline: true,
    trace: process.env.E2E_TRACE === '1' ? { mode: 'retain-on-failure', screenshots: false } : 'off',
  },
  projects: [
    { name: 'chromium', use: {} },
    { name: 'chrome', use: { channel: 'chrome' } },
    { name: 'msedge', use: { channel: 'msedge' } },
  ],
});
