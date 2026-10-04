import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test-browser',
  testMatch: '*.spec.mjs',
  // Pyodide, its packages and the ffmpeg core load over the network
  timeout: 300_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { channel: 'chromium' },
});
