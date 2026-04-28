import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Run `npm run serve` before the tests start, kill it after they finish.
  webServer: {
    command: 'npx serve . --listen 5500',
    url: 'http://localhost:5500',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:5500',
    // Capture screenshots and traces on failure for debugging.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // WebCodecs is Chrome-only; skip Firefox/Safari for now.
  ],
});
