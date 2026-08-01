import { defineConfig, devices } from '@playwright/test';

const baseURL =
  process.env.SMOKE_BASE_URL?.replace(/\/$/, '') ||
  'https://www.sadiemarie.co';

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
  },
});
