import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildBeforeDevCommand } from '../scripts/tauri-dev-env.mjs';

test('buildBeforeDevCommand forwards Cloud Edition env into the Vite dev server command', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi Cloud Edition Login Gate',
    host: '127.0.0.1',
    port: 1492,
    env: { KORDI_EDITION: 'cloud' },
  });

  assert.match(command, /^VITE_KORDI_WINDOW_TITLE='Kordi Cloud Edition Login Gate' /);
  assert.match(command, / VITE_KORDI_EDITION='cloud' /);
  assert.match(command, / KORDI_EDITION='cloud' /);
  assert.match(command, /npm run dev:web -- --host 127\.0\.0\.1 --port 1492 --strictPort$/);
});

test('buildBeforeDevCommand lets an explicit Vite edition override the runtime edition', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi',
    host: '127.0.0.1',
    port: 1420,
    env: { VITE_KORDI_EDITION: 'cloud', KORDI_EDITION: 'local' },
  });

  assert.match(command, / VITE_KORDI_EDITION='cloud' /);
  assert.match(command, / KORDI_EDITION='local' /);
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
