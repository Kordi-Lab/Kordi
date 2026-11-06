import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

const port = Number(process.env.KORDI_WEB_APP_TEST_PORT ?? 62483);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e', workers: 1, reporter: 'line',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/app/`, reuseExistingServer: false,
    env: { VITE_KORDI_EDITION: 'cloud', VITE_KORDI_DEV_PROFILE: 'community', VITE_KORDI_CLOUD_API_BASE: baseURL },
  },
});
