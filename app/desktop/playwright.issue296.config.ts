import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual', testMatch: 'markdownEmphasis.spec.ts', workers: 1,
  reporter: 'line', outputDir: '/tmp/kordi-296-browser-results',
  use: { baseURL: 'http://127.0.0.1:4196', viewport: { width: 1280, height: 1000 } },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4196 --strictPort',
    env: { VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081', VITE_KORDI_DEV_PROFILE: 'community' },
    url: 'http://127.0.0.1:4196/tests/visual/markdownEmphasis.html', reuseExistingServer: false,
  },
});
