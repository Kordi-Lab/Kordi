import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildBeforeDevCommand,
  resolveDesktopPreviewIcons,
} from '../scripts/tauri-dev-env.mjs';

const appShellFrameSource = readFileSync(new URL('../src/app/AppShellFrame.tsx', import.meta.url), 'utf8');

test('native startup preserves the title selected by a named Tauri profile', () => {
  const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /set_title\("Kordi"\)/);
});

test('buildBeforeDevCommand does not forward removed edition env into the Vite dev server command', () => {
  const command = buildBeforeDevCommand({
    title: 'Kordi Cloud',
    host: '127.0.0.1',
    port: 1492,
    env: {
      KORDI_EDITION: 'local',
      VITE_KORDI_EDITION: 'local',
      VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:17081',
    },
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
  assert.match(command, / VITE_KORDI_DEV_PROFILE='community' /);
});

test('buildBeforeDevCommand fails closed without a debug server origin', () => {
  assert.throws(
    () => buildBeforeDevCommand({
      title: 'Kordi',
      host: '127.0.0.1',
      port: 1420,
      env: {},
    }),
    /VITE_KORDI_CLOUD_API_BASE is required for development/i,
  );
});

test('buildBeforeDevCommand rejects the production origin', () => {
  for (const productionOrigin of [
    'https://kordi.ai',
    'http://kordi.ai',
    'https://kordi.ai./',
  ]) {
    assert.throws(
      () => buildBeforeDevCommand({
        title: 'Kordi',
        host: '127.0.0.1',
        port: 1420,
        env: { VITE_KORDI_CLOUD_API_BASE: productionOrigin },
      }),
      /production Cloud API is blocked in development/i,
    );
  }
});

test('buildBeforeDevCommand permits production only for acknowledged operator runs', () => {
  const base = {
    VITE_KORDI_CLOUD_API_BASE: 'https://kordi.ai',
    VITE_KORDI_DEV_PROFILE: 'operator',
  };
  assert.throws(
    () => buildBeforeDevCommand({
      title: 'Kordi Operator',
      host: '127.0.0.1',
      port: 1420,
      env: base,
    }),
    /blocked in development/i,
  );

  const command = buildBeforeDevCommand({
    title: 'Kordi Operator',
    host: '127.0.0.1',
    port: 1420,
    env: {
      ...base,
      VITE_KORDI_PRODUCTION_DEBUG_ACK: '1',
    },
  });
  assert.match(command, /VITE_KORDI_DEV_PROFILE='operator'/);
  assert.match(command, /VITE_KORDI_PRODUCTION_DEBUG_ACK='1'/);
});

test('desktop preview icons visibly distinguish development from product', () => {
  assert.deepEqual(
    resolveDesktopPreviewIcons({ VITE_KORDI_DEV_PROFILE: 'community' }),
    ['icons/icon-dev.png', 'icons/icon-dev.icns'],
  );
  assert.deepEqual(
    resolveDesktopPreviewIcons({ VITE_KORDI_DEV_PROFILE: 'operator' }),
    ['icons/icon.png', 'icons/icon.icns'],
  );
});

test('named development profiles render a visible in-window instance label', () => {
  assert.match(appShellFrameSource, /if \(!import\.meta\.env\.DEV\) return null;/);
  assert.match(appShellFrameSource, /VITE_KORDI_WINDOW_TITLE/);
  assert.match(appShellFrameSource, /Preview · \{instanceLabel\}/);
  assert.match(appShellFrameSource, /aria-label=\{`Preview instance: \$\{instanceLabel\}`\}/);
});
