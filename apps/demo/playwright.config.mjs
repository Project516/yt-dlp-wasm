import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test-browser',
  testMatch: '*.spec.mjs',
  // Pyodide, its packages and the ffmpeg core load over the network
  timeout: 300_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { channel: 'chromium' },
  // Serves the build, so run `pnpm build` first
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !process.env.CI,
  },
});
