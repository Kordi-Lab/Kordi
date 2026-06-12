import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildBeforeDevCommand } from '../scripts/tauri-dev-env.mjs';

test('buildBeforeDevCommand does not forward removed edition env into the Vite dev server command', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi Cloud',
    host: '127.0.0.1',
    port: 1492,
    env: { KORDI_EDITION: 'local', VITE_KORDI_EDITION: 'local' },
  });

  assert.match(command, /^VITE_KORDI_WINDOW_TITLE='Kordi Cloud' /);
  assert.doesNotMatch(command, /VITE_KORDI_EDITION|KORDI_EDITION/);
  assert.match(command, /npm run dev:web -- --host 127\.0\.0\.1 --port 1492 --strictPort$/);
});

test('buildBeforeDevCommand forwards explicit Cloud API base into the Vite dev server command', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi Cloud',
    host: '127.0.0.1',
    port: 1482,
    env: { VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081' },
  });

  assert.match(command, / VITE_KORDI_CLOUD_API_BASE='http:\/\/127\.0\.0\.1:17081' /);
});

test('buildBeforeDevCommand forwards the desktop update preview flag into Vite', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi Cloud Update Preview',
    host: '127.0.0.1',
    port: 1484,
    env: { VITE_KORDI_PREVIEW_UPDATE: 'available' },
  });

  assert.match(command, / VITE_KORDI_PREVIEW_UPDATE='available' /);
});

test('buildBeforeDevCommand omits edition env when no edition is configured', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi',
    host: '127.0.0.1',
    port: 1420,
    env: {},
  });

  assert.doesNotMatch(command, /KORDI_EDITION/);
});
