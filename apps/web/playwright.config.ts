import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src/tests/e2e',
  fullyParallel: false, // Watch party tests need sequential execution (multi-context)
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1, // Single worker to avoid port conflicts in CI
  reporter: [['html'], ['list']],
  use: {
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        // Use Chromium for testing — best YouTube IFrame support
        channel: 'chrome',
      },
    },
  ],
  // Automatically start the dev server before tests
  webServer: [
    {
      command: 'npm run dev --workspace=apps/server',
      url: 'http://localhost:4000/health',
      reuseExistingServer: !process.env['CI'],
      env: {
        NODE_ENV: 'test',
        PORT: '4000',
      },
    },
    {
      command: 'npm run dev --workspace=apps/web',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env['CI'],
    },
  ],
});
