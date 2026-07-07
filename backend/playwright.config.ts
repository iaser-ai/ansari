import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    headless: true,
    screenshot: 'on',
    trace: 'on-first-retry',
  },
  reporter: 'list',
});
