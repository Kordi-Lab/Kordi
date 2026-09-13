import { defineConfig } from '@playwright/test';

// Uses an explicitly selected preview; never starts or reuses a backend implicitly.
const baseURL = process.env.KORDI_AUTH_TRANSITION_TEST_URL;
if (!baseURL) throw new Error('Set KORDI_AUTH_TRANSITION_TEST_URL to the task-owned preview URL.');
export default defineConfig({
  testDir: '.',
  testMatch: ['authTransitions.spec.ts', 'workspaceResize.spec.ts'],
  workers: 1,
  reporter: 'line',
  use: { baseURL, viewport: { width: 760, height: 760 } },
  projects: [
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'webkit-reduced-motion', use: { browserName: 'webkit', reducedMotion: 'reduce' } },
  ],
});
