import { defineConfig } from '@playwright/test';

// Runs against the deployed demo, so only the live smoke workflow uses it
export default defineConfig({
  testDir: 'test-live',
  testMatch: '*.spec.mjs',
  outputDir: 'live-results/playwright',
  timeout: 300_000,
  retries: 1,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { channel: 'chromium', trace: 'retain-on-failure' },
});
