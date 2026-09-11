import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

const port = Number(process.env.KORDI_HISTORY_TEST_PORT ?? 62358);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/visual', testMatch: 'transcriptHistory.spec.ts', workers: 1,
  reporter: 'line', use: { baseURL, reducedMotion: 'reduce' },
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:8787', VITE_KORDI_DEV_PROFILE: 'community' },
    url: `${baseURL}/tests/visual/transcriptHistory.html`, reuseExistingServer: false,
  },
});
