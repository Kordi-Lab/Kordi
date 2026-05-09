import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { KordiAppRoot } from '../src/KordiApp';
import { CloudLoginPage } from '../src/kordi-app/cloud/CloudLoginPage';
import {
  kordiEditionFromEnv,
  kordiEditionFromRuntimeHints,
  normalizeKordiEdition,
  shouldShowCloudLoginGate,
} from '../src/features/cloud/edition';
import {
  applyCloudLoginWindowSize,
  applyKordiMainWindowSize,
  cloudLoginWindowSizeForMode,
  isTauriRuntime,
} from '../src/features/cloud/loginWindow';

test('normalizeKordiEdition defaults to local and accepts cloud explicitly', () => {
  assert.equal(normalizeKordiEdition(undefined), 'local');
  assert.equal(normalizeKordiEdition(''), 'local');
  assert.equal(normalizeKordiEdition('LOCAL'), 'local');
  assert.equal(normalizeKordiEdition('cloud'), 'cloud');
  assert.equal(normalizeKordiEdition('enterprise'), 'local');
});

test('kordiEditionFromEnv prefers Vite edition over runtime edition', () => {
  assert.equal(kordiEditionFromEnv({ VITE_KORDI_EDITION: 'cloud', KORDI_EDITION: 'local' }), 'cloud');
  assert.equal(kordiEditionFromEnv({ KORDI_EDITION: 'cloud' }), 'cloud');
  assert.equal(kordiEditionFromEnv({ VITE_KORDI_EDITION: 'local', KORDI_EDITION: 'cloud' }), 'local');
});

test('kordiEditionFromEnv treats Cloud Edition window title as cloud preview fallback', () => {
  assert.equal(kordiEditionFromEnv({ VITE_KORDI_WINDOW_TITLE: 'Kordi Cloud Edition Login Gate' }), 'cloud');
  assert.equal(kordiEditionFromEnv({ VITE_KORDI_WINDOW_TITLE: 'Kordi Local Dev' }), 'local');
});

test('kordiEditionFromRuntimeHints detects the Cloud Edition preview title', () => {
  assert.equal(kordiEditionFromRuntimeHints({ documentTitle: '(6) Kordi Cloud Edition Login Gate' }), 'cloud');
  assert.equal(kordiEditionFromRuntimeHints({ documentTitle: 'Kordi' }), 'local');
});

test('cloud login gate blocks signed-out Cloud Edition in native and web preview', () => {
  assert.equal(shouldShowCloudLoginGate({ edition: 'local', cloudSessionStatus: 'signed-out' }), false);
  assert.equal(shouldShowCloudLoginGate({ edition: 'cloud', cloudSessionStatus: 'authenticated' }), false);
  assert.equal(shouldShowCloudLoginGate({ edition: 'cloud', cloudSessionStatus: 'signed-out' }), true);
});

test('cloud login page centers a minimal Codex-style Kordi account view before model provider auth', () => {
  const markup = renderToStaticMarkup(createElement(CloudLoginPage));

  assert.match(markup, /kordi-paint-mark/);
  assert.match(markup, /bg-\[oklch\(0\.955_0\.026_82\)\]/);
  assert.doesNotMatch(markup, /app-overlay/);
  assert.match(markup, /place-items-center/);
  assert.match(markup, /Welcome to Kordi/);
  assert.match(markup, /Sign up/);
  assert.match(markup, /Email/);
  assert.match(markup, /Password/);
  assert.match(markup, /Continue/);
  assert.match(markup, /Google/);
  assert.match(markup, /GitHub/);
  assert.match(markup, /𝕏/);
  assert.match(markup, /Model setup comes next\./);
  assert.doesNotMatch(markup, /Kordi Cloud/);
  assert.doesNotMatch(markup, /Log in to Kordi Cloud/);
  assert.doesNotMatch(markup, /Continue with GitHub/);
  assert.doesNotMatch(markup, /Your Kordi account comes first/);
  assert.doesNotMatch(markup, /After account login/);
  assert.doesNotMatch(markup, /Model provider credentials stay local by default/);
  assert.doesNotMatch(markup, /bg-\[oklch\(0\.145_0\.01_250\)\]/);
  assert.doesNotMatch(markup, /Connect one provider before your first chat/);
});

test('signup mode offers avatar upload and random avatar controls', () => {
  const markup = renderToStaticMarkup(createElement(CloudLoginPage, { initialMode: 'signup' }));

  assert.match(markup, /Create account/);
  assert.match(markup, /Upload avatar/);
  assert.match(markup, /Random avatar/);
  assert.match(markup, /Name/);
  assert.match(markup, /Create account/);
  assert.doesNotMatch(markup, /Kordi Cloud/);
});

test('cloud login native window uses a compact size instead of the full app frame', async () => {
  const calls: Array<{ method: string; size?: { width: number; height: number }; resizable?: boolean }> = [];
  class FakeLogicalSize {
    constructor(public width: number, public height: number) {}
  }
  const deps = {
    LogicalSize: FakeLogicalSize,
    getCurrentWindow: () => ({
      setResizable: async (resizable: boolean) => calls.push({ method: 'setResizable', resizable }),
      setMinSize: async (size: FakeLogicalSize) => calls.push({ method: 'setMinSize', size: { width: size.width, height: size.height } }),
      setSize: async (size: FakeLogicalSize) => calls.push({ method: 'setSize', size: { width: size.width, height: size.height } }),
      center: async () => calls.push({ method: 'center' }),
    }),
  };

  assert.deepEqual(cloudLoginWindowSizeForMode('login'), { width: 760, height: 760, minWidth: 620, minHeight: 640 });
  assert.deepEqual(cloudLoginWindowSizeForMode('signup'), { width: 760, height: 900, minWidth: 620, minHeight: 640 });
  assert.equal(isTauriRuntime({ __TAURI_INTERNALS__: {} } as typeof globalThis), true);
  assert.equal(isTauriRuntime({} as typeof globalThis), false);

  await applyCloudLoginWindowSize('signup', deps);

  assert.deepEqual(calls, [
    { method: 'setResizable', resizable: false },
    { method: 'setMinSize', size: { width: 620, height: 640 } },
    { method: 'setSize', size: { width: 760, height: 900 } },
    { method: 'center' },
  ]);
});

test('main app shell restores the normal app window size after login', async () => {
  const calls: Array<{ method: string; size?: { width: number; height: number }; resizable?: boolean }> = [];
  class FakeLogicalSize {
    constructor(public width: number, public height: number) {}
  }

  await applyKordiMainWindowSize({
    LogicalSize: FakeLogicalSize,
    getCurrentWindow: () => ({
      setResizable: async (resizable: boolean) => calls.push({ method: 'setResizable', resizable }),
      setMinSize: async (size: FakeLogicalSize) => calls.push({ method: 'setMinSize', size: { width: size.width, height: size.height } }),
      setSize: async (size: FakeLogicalSize) => calls.push({ method: 'setSize', size: { width: size.width, height: size.height } }),
      center: async () => calls.push({ method: 'center' }),
    }),
  });

  assert.deepEqual(calls, [
    { method: 'setResizable', resizable: true },
    { method: 'setMinSize', size: { width: 1192, height: 760 } },
    { method: 'setSize', size: { width: 1480, height: 980 } },
    { method: 'center' },
  ]);
});

test('cloud edition app root renders account login before the chat shell', () => {
  const markup = renderToStaticMarkup(createElement(KordiAppRoot, {
    edition: 'cloud',
    cloudSessionStatus: 'signed-out',
  }));

  assert.match(markup, /Welcome to Kordi/);
  assert.doesNotMatch(markup, /No provider connected yet/);
  assert.doesNotMatch(markup, /Ask your agent/);
});
