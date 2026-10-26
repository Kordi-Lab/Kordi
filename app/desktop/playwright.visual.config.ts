import { defineConfig, devices } from '@playwright/test';

// KORDI_VISUAL_PORT serves the pages on another port; the default is the one CI uses.
const port = Number(process.env.KORDI_VISUAL_PORT ?? '4174');

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
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
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1040 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'webkit-text-selection', testMatch: '**/textSelection.spec.ts', use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-cloud-transport', testMatch: '**/cloudTransport.spec.ts', use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-live-photo', testMatch: '**/livePhoto.spec.ts', use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-pinned-list', testMatch: '**/pinnedMessageList.spec.ts', use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-emoji-picker', testMatch: '**/emojiPickerOffline.spec.ts', use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-onboarding', testMatch: '**/helpHub.spec.ts', use: { ...devices['Desktop Safari'] } },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    env: {
      ...process.env,
      VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:8787',
    },
    url: `http://127.0.0.1:${port}/tests/visual/transientSurfaceGallery.html`,
    reuseExistingServer: !process.env.CI,
  },
});
