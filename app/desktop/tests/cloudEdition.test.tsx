import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudStartingScreen, KordiAppRoot } from '../src/KordiApp';
import { CloudLoginPage, cloudSignupAvatarInitials } from '../src/kordi-app/cloud/CloudLoginPage';
import {
  kordiEditionFromEnv,
  kordiEditionFromRuntimeHints,
  normalizeKordiEdition,
  shouldShowCloudLoginGate,
} from '../src/features/cloud/edition';
const repoRoot = resolve(import.meta.dirname, '..');

function makeStorageStub(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  };
}

function withLocalStorage<T>(storage: Storage, run: () => T): T {
  const target = globalThis as typeof globalThis & { localStorage?: Storage };
  const previous = target.localStorage;
  target.localStorage = storage;
  try {
    return run();
  } finally {
    if (previous) target.localStorage = previous;
    else delete target.localStorage;
  }
}

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

import {
  applyCloudLoginWindowSize,
  applyKordiMainWindowSize,
  cloudLoginWindowSizeForMode,
  isTauriRuntime,
} from '../src/features/cloud/loginWindow';

test('cloud shell source does not expose localhost bridge controls', () => {
  const navigation = readSource('src/kordi-app/data/navigation.tsx');
  const sidebar = readSource('src/pages/WorkspaceSidebar.tsx');
  const rightDetail = readSource('src/app/assembleRightDetailSlot.tsx');

  assert.doesNotMatch(navigation, /id: 'bridge'/);
  assert.doesNotMatch(sidebar, /Refresh bridge state|Copy host URL|Add \/ join another host/);
  assert.doesNotMatch(rightDetail, /onOpenBridgeHosts|handleCreateProjectBridgeInvite/);
});

test('normalizeKordiEdition defaults to cloud and keeps explicit local override', () => {
  assert.equal(normalizeKordiEdition(undefined), 'cloud');
  assert.equal(normalizeKordiEdition(''), 'cloud');
  assert.equal(normalizeKordiEdition('LOCAL'), 'local');
  assert.equal(normalizeKordiEdition('cloud'), 'cloud');
  assert.equal(normalizeKordiEdition('enterprise'), 'cloud');
});

test('kordiEditionFromEnv prefers Vite edition over runtime edition', () => {
  assert.equal(kordiEditionFromEnv({ VITE_KORDI_EDITION: 'cloud', KORDI_EDITION: 'local' }), 'cloud');
  assert.equal(kordiEditionFromEnv({ KORDI_EDITION: 'cloud' }), 'cloud');
  assert.equal(kordiEditionFromEnv({ VITE_KORDI_EDITION: 'local', KORDI_EDITION: 'cloud' }), 'local');
});

test('kordiEditionFromEnv defaults to cloud and keeps explicit local title override', () => {
  assert.equal(kordiEditionFromEnv({}), 'cloud');
  assert.equal(kordiEditionFromEnv({ VITE_KORDI_WINDOW_TITLE: 'Kordi Cloud Edition Login Gate' }), 'cloud');
  assert.equal(kordiEditionFromEnv({ VITE_KORDI_WINDOW_TITLE: 'Kordi Local Dev' }), 'local');
});

test('kordiEditionFromRuntimeHints defaults to cloud and detects explicit local preview title', () => {
  assert.equal(kordiEditionFromRuntimeHints({ documentTitle: '(6) Kordi Cloud Edition Login Gate' }), 'cloud');
  assert.equal(kordiEditionFromRuntimeHints({ documentTitle: 'Kordi' }), 'cloud');
  assert.equal(kordiEditionFromRuntimeHints({ documentTitle: 'Kordi Local Dev' }), 'local');
});

test('cloud login gate blocks signed-out Cloud Edition in native and web preview', () => {
  assert.equal(shouldShowCloudLoginGate({ edition: 'local', cloudSessionStatus: 'signed-out' }), false);
  assert.equal(shouldShowCloudLoginGate({ edition: 'cloud', cloudSessionStatus: 'authenticated' }), false);
  assert.equal(shouldShowCloudLoginGate({ edition: 'cloud', cloudSessionStatus: 'signed-out' }), true);
});

test('cloud login CSS hides the oversized native WebKit caps-lock indicator', () => {
  const css = readSource('src/styles/theme-overrides.css');

  assert.match(css, /\.app-cloud-login-input::-webkit-caps-lock-indicator/);
  assert.match(css, /display:\s*none/);
  assert.match(css, /width:\s*0/);
});

test('cloud login mode switch keeps the top edge stable and smooths signup sections', () => {
  const css = readSource('src/styles/theme-overrides.css');
  const source = readSource('src/kordi-app/cloud/CloudLoginPage.tsx');

  assert.match(css, /\.app-cloud-login-panel \{\n  min-height: 548px;/);
  assert.match(css, /\.app-cloud-login-signup-section \{[\s\S]*?grid-template-rows: 0fr/);
  assert.match(css, /data-cloud-login-signup-section="open"\][\s\S]*?grid-template-rows: 1fr/);
  assert.match(css, /transform: translate3d\(0, -4px, 0\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /@keyframes app-cloud-login-signup-field-enter/);
  assert.doesNotMatch(source, /key=\{`form-/);
  assert.doesNotMatch(source, /key=\{`copy-/);
});

test('cloud login page centers a minimal Codex-style Kordi account view before model provider auth', () => {
  const markup = renderToStaticMarkup(createElement(CloudLoginPage));

  // The painted brand mark no longer renders on the login surface.
  assert.doesNotMatch(markup, /kordi-paint-mark/);
  // Page surface is driven by theme tokens (light/dark follow the active
  // `.bridge-app.theme-*` class) instead of a hard-coded paper colour.
  assert.match(markup, /app-cloud-login-page/);
  assert.doesNotMatch(markup, /bg-\[oklch\(0\.955_0\.026_82\)\]/);
  assert.doesNotMatch(markup, /app-overlay/);
  assert.match(markup, /place-items-center/);
  assert.match(markup, /Welcome to Kordi/);
  assert.match(markup, /data-cloud-login-mode-copy="login"/);
  assert.match(markup, /data-cloud-login-mode-form="login"/);
  assert.match(markup, /Sign up/);
  assert.match(markup, /Email/);
  assert.match(markup, /Password/);
  assert.match(markup, /Continue/);
  assert.match(markup, /Google/);
  assert.match(markup, /GitHub/);
  assert.doesNotMatch(markup, /data-provider="x"/);
  assert.doesNotMatch(markup, /Kordi Cloud/);
  assert.doesNotMatch(markup, /Log in to Kordi Cloud/);
  assert.match(markup, /Continue with GitHub/);
  assert.doesNotMatch(markup, /Your Kordi account comes first/);
  assert.doesNotMatch(markup, /After account login/);
  assert.doesNotMatch(markup, /Model provider credentials stay local by default/);
  assert.doesNotMatch(markup, /bg-\[oklch\(0\.145_0\.01_250\)\]/);
  assert.doesNotMatch(markup, /Connect one provider before your first chat/);
});

test('signup mode requires avatar upload and removes random avatar controls', () => {
  const markup = renderToStaticMarkup(createElement(CloudLoginPage, { initialMode: 'signup' }));

  assert.match(markup, /Create account/);
  assert.match(markup, /data-cloud-login-mode-copy="signup"/);
  assert.match(markup, /data-cloud-login-mode-form="signup"/);
  assert.match(markup, /Upload avatar/);
  assert.match(markup, /data-cloud-signup-avatar-placeholder="true"/);
  assert.match(markup, />KO<\/span>/);
  assert.match(markup, /data-cloud-signup-avatar-upload-icon="true"/);
  assert.match(markup, /data-cloud-signup-avatar-upload-dock="true"/);
  assert.match(markup, /bottom-0 left-1\/2/);
  assert.match(markup, /overflow-hidden rounded-full/);
  assert.doesNotMatch(markup, /top-\[46px\]/);
  assert.doesNotMatch(markup, /bottom-\[3px\] right-\[3px\]/);
  assert.doesNotMatch(markup, />Upload<\/span>/);
  assert.doesNotMatch(markup, />\+<\/span>/);
  assert.doesNotMatch(markup, />Change<\/span>/);
  assert.doesNotMatch(markup, /Random avatar/);
  assert.match(markup, /Display name/);
  assert.match(markup, /Confirm Password/);
  assert.doesNotMatch(markup, />Name</);
  assert.match(markup, /Create account/);
  assert.doesNotMatch(markup, /Kordi Cloud/);
});

test('signup uploaded avatar preview keeps the upload affordance in a bottom dock', () => {
  const storage = makeStorageStub({
    'kordi.cloud.signupAvatar': JSON.stringify({ kind: 'upload', dataUrl: 'data:image/jpeg;base64,abc' }),
  });
  const markup = withLocalStorage(storage, () => renderToStaticMarkup(createElement(CloudLoginPage, { initialMode: 'signup' })));

  assert.match(markup, /src="data:image\/jpeg;base64,abc"/);
  assert.match(markup, /data-cloud-signup-avatar-upload-icon="true"/);
  assert.match(markup, /data-cloud-signup-avatar-upload-dock="true"/);
  assert.match(markup, /bottom-0 left-1\/2/);
  assert.match(markup, /overflow-hidden rounded-full/);
  assert.doesNotMatch(markup, /top-\[46px\]/);
  assert.doesNotMatch(markup, /bottom-\[3px\] right-\[3px\]/);
  assert.doesNotMatch(markup, />Upload<\/span>/);
  assert.doesNotMatch(markup, />Change<\/span>/);
});

test('cloud signup avatar placeholder derives initials from the display name', () => {
  assert.equal(cloudSignupAvatarInitials('Ada Lovelace'), 'AD');
  assert.equal(cloudSignupAvatarInitials('杨谢'), '杨谢');
  assert.equal(cloudSignupAvatarInitials(''), 'KO');
});

test('signup mode does not render a generated pixel avatar before upload', () => {
  const markup = renderToStaticMarkup(createElement(CloudLoginPage, { initialMode: 'signup' }));

  assert.doesNotMatch(markup, /shape-rendering="crispEdges"/);
  assert.doesNotMatch(markup, /viewBox="0 0 64 64"/);
  assert.doesNotMatch(markup, /linear-gradient\(135deg, oklch\(0\.72 0\.16 211\)/);
  assert.doesNotMatch(markup, /linear-gradient\(135deg, oklch\(0\.66 0\.26 355\)/);
});

test('social buttons surface provider sign-in affordances', () => {
  const markup = renderToStaticMarkup(createElement(CloudLoginPage, { onSocialSignIn: async () => {} }));
  assert.match(markup, /title="Continue with Google"/);
  assert.match(markup, /title="Continue with GitHub"/);
  assert.doesNotMatch(markup, /title="Continue with X"/);
  assert.match(markup, /aria-label="Continue with Google"/);
  assert.match(markup, /aria-label="Continue with GitHub"/);
  assert.doesNotMatch(markup, /aria-label="Continue with X"/);
  assert.doesNotMatch(markup, /coming soon/i);
  assert.match(markup, /aria-label="Sign in"/);
});

test('social buttons render icon marks and no provider text label', () => {
  const markup = renderToStaticMarkup(createElement(CloudLoginPage));
  // Buttons exist for each provider with their data attribute.
  assert.match(markup, /data-provider="google"[\s\S]*?<svg/);
  assert.match(markup, /data-provider="github"[\s\S]*?<svg/);
  assert.doesNotMatch(markup, /data-provider="x"/);
  // The Google brand fingerprint (a known fill colour from the canonical 4-color G).
  assert.match(markup, /fill="#FBBC05"/);
  // The visible provider names should NOT appear inside the social buttons themselves.
  assert.doesNotMatch(markup, /<button[^>]*data-provider="google"[^>]*>[^<]*Google/);
  assert.doesNotMatch(markup, /<button[^>]*data-provider="github"[^>]*>[^<]*GitHub/);
});

test('signup-mode submit button is the create-account variant', () => {
  const markup = renderToStaticMarkup(createElement(CloudLoginPage, { initialMode: 'signup' }));
  assert.match(markup, /aria-label="Create account"/);
  assert.match(markup, />Create account<\/button>/);
});

test('signup submit falls back to the displayed initials avatar image', () => {
  const source = readSource('src/kordi-app/cloud/CloudLoginPage.tsx');

  assert.doesNotMatch(source, /if \(isSignup && !avatarPref\) return false;/);
  assert.match(source, /cloudSignupDefaultAvatarDataUrl\(trimmedName \|\| displayName\)/);
  assert.match(source, /return canvas\.toDataURL\('image\/png'\)/);
  assert.match(source, /avatarUrl,/);
  assert.doesNotMatch(source, /flashUploadError\('Upload an avatar\.'\)/);
});

test('login-mode tab pill announces aria-pressed for accessibility', () => {
  const markup = renderToStaticMarkup(createElement(CloudLoginPage, { initialMode: 'login' }));
  // Log in tab is pressed, Sign up is not.
  assert.match(markup, /aria-pressed="true"[^>]*>Log in/);
  assert.match(markup, /aria-pressed="false"[^>]*>Sign up/);
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
  assert.deepEqual(cloudLoginWindowSizeForMode('signup'), { width: 760, height: 860, minWidth: 620, minHeight: 640 });
  assert.equal(isTauriRuntime({ __TAURI_INTERNALS__: {} } as typeof globalThis), true);
  assert.equal(isTauriRuntime({} as typeof globalThis), false);

  await applyCloudLoginWindowSize('signup', deps);

  assert.deepEqual(calls, [
    { method: 'setResizable', resizable: false },
    { method: 'setMinSize', size: { width: 620, height: 640 } },
    { method: 'setSize', size: { width: 760, height: 860 } },
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

test('cloud starting screen renders only the quiet watercolor dots', () => {
  const markup = renderToStaticMarkup(createElement(CloudStartingScreen));

  assert.match(markup, /app-cloud-starting-screen/);
  assert.match(markup, /app-cloud-starting-dots/);
  assert.equal((markup.match(/<span class="app-cloud-starting-dot/g) ?? []).length, 3);
  assert.doesNotMatch(markup, /Starting/);
  assert.doesNotMatch(markup, /Restoring session/);
});

test('cloud starting timeout still has no visible retry copy', () => {
  const markup = renderToStaticMarkup(createElement(CloudStartingScreen, { status: 'error', onRetry: () => {} }));

  assert.match(markup, /app-cloud-starting-screen-error/);
  assert.equal((markup.match(/<span class="app-cloud-starting-dot/g) ?? []).length, 3);
  assert.doesNotMatch(markup, /Retry/);
  assert.doesNotMatch(markup, /button/);
});

test('cloud edition session restore uses the same dot loading screen', () => {
  const markup = renderToStaticMarkup(createElement(KordiAppRoot, {
    edition: 'cloud',
    cloudSessionStatus: 'loading',
    cloudSession: {
      status: 'loading',
      account: null,
      signIn: async () => {},
      signUp: async () => {},
      signInWithProvider: async () => {},
    },
  }));

  assert.match(markup, /app-cloud-starting-screen/);
  assert.equal((markup.match(/<span class="app-cloud-starting-dot/g) ?? []).length, 3);
  assert.doesNotMatch(markup, /Restoring session/);
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

test('cloud login gate reads persisted theme preference before shell mount', () => {
  const source = readSource('src/KordiApp.tsx');

  assert.match(source, /readStoredThemeMode/);
  assert.match(source, /resolveThemeMode\(themeMode, readSystemTheme\(\)\)/);
  assert.match(source, /setTheme\(resolveThemeMode\(themeMode, mediaQuery\.matches \? 'light' : 'dark'\)\)/);
  assert.doesNotMatch(source, /const \[theme, setTheme\] = useState<ResolvedThemeMode>\(\(\) => readSystemTheme\(\)\)/);
});
