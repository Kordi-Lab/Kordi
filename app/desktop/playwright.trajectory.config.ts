import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.KORDI_TRAJECTORY_TEST_PORT ?? '62360');

export default defineConfig({
  testDir: './tests/visual',
  testMatch: ['processingTrajectory.spec.ts', 'progressDuration.spec.ts', 'pinMotion.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1040 },
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `pnpm exec vite build --config vite.trajectory.config.js && pnpm exec vite preview --config vite.trajectory.config.js --host 127.0.0.1 --port ${port} --strictPort`,
    env: {
      ...process.env,
      VITE_KORDI_DEV_PROFILE: 'community',
      VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:8787',
    },
    url: `http://127.0.0.1:${port}/tests/visual/processingTrajectory.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
