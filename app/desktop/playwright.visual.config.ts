import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}-{projectName}-{platform}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.002,
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4174',
    viewport: { width: 1440, height: 1040 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4174 --strictPort',
    env: {
      ...process.env,
      VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:8787',
    },
    url: 'http://127.0.0.1:4174/tests/visual/transientSurfaceGallery.html',
    reuseExistingServer: !process.env.CI,
  },
});
