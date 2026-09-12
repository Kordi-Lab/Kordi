import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

const port = Number(process.env.KORDI_PRODUCTION_TEST_PORT ?? 62359);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/production', workers: 1, reporter: 'line',
  use: { baseURL },
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    env: { NODE_ENV: 'production', VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:8787', VITE_KORDI_DEV_PROFILE: 'community' },
    url: baseURL, reuseExistingServer: false,
  },
});
