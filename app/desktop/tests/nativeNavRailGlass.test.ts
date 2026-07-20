import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { syncNativeWindowTheme } from '../src/app/nativeWindowTheme';

const readSource = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('macOS main window enables semantic sidebar vibrancy on a transparent canvas', () => {
  const config = JSON.parse(readSource('src-tauri/tauri.conf.json')) as {
    app: {
      macOSPrivateApi?: boolean;
      windows: Array<{
        label?: string;
        transparent?: boolean;
        backgroundColor?: string;
        windowEffects?: { effects?: string[]; state?: string };
      }>;
    };
  };
  const cargo = readSource('src-tauri/Cargo.toml');
  const capability = JSON.parse(readSource('src-tauri/capabilities/default.json')) as {
    permissions?: string[];
  };
  const mainWindow = config.app.windows.find((window) => window.label === 'main');

  assert.equal(config.app.macOSPrivateApi, true);
  assert.equal(mainWindow?.transparent, true);
  assert.equal(mainWindow?.backgroundColor, '#00000000');
  assert.deepEqual(mainWindow?.windowEffects, {
    effects: ['sidebar'],
    state: 'followsWindowActiveState',
  });
  assert.match(cargo, /tauri\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"macos-private-api"/s);
  assert.ok(capability.permissions?.includes('core:window:allow-set-theme'));
});

test('native shell exposes vibrancy through the navigation rail only', () => {
  const shellCss = readSource('src/styles/shell.css');
  const tokensCss = readSource('src/styles/theme-tokens.css');
  const sidebar = readSource('src/pages/WorkspaceSidebar.tsx');
  const indexHtml = readSource('index.html');

  assert.match(indexHtml, /__TAURI_INTERNALS__[\s\S]*document\.documentElement\.classList\.add\('kordi-native-shell'\)/);
  assert.match(shellCss, /html\.kordi-native-shell \.bridge-app \.app-left-glass\s*\{[^}]*background:\s*var\(--app-nav-rail-glass-bg\)/s);
  assert.match(shellCss, /html\.kordi-native-shell \.bridge-app \.app-session-panel\s*\{[^}]*background:\s*var\(--app-native-session-bg\)/s);
  assert.match(shellCss, /html\.kordi-native-shell \.bridge-app \.app-main-panel\s*\{[^}]*background:\s*var\(--app-native-main-bg\)/s);
  assert.match(shellCss, /html\.kordi-native-shell \.bridge-app \.app-shell,[\s\S]*html\.kordi-native-shell \.bridge-app \.app-main-panel\s*\{[^}]*backdrop-filter:\s*none/s);
  assert.match(shellCss, /@media \(prefers-reduced-transparency: reduce\)[\s\S]*background:\s*var\(--app-nav-rail-glass-fallback\)/);
  assert.equal((tokensCss.match(/--app-nav-rail-glass-bg:/g) ?? []).length, 2);
  assert.equal((tokensCss.match(/--app-native-session-bg:/g) ?? []).length, 2);
  assert.equal((tokensCss.match(/--app-native-main-bg:/g) ?? []).length, 2);
  assert.match(sidebar, /className="app-nav-rail-profile rounded-full"/);
  assert.match(sidebar, /className="app-nav-rail-avatar h-9 w-9"/);
  assert.doesNotMatch(sidebar, /shadow-\[inset_-1px_0_0_rgba/);
});

test('dark navigation rail uses a black glass tint without changing light glass', () => {
  const tokensCss = readSource('src/styles/theme-tokens.css');
  const darkThemeStart = tokensCss.indexOf('.bridge-app {');
  const lightThemeStart = tokensCss.indexOf('.bridge-app.theme-light {');
  assert.ok(darkThemeStart >= 0, 'dark theme token block should exist');
  assert.ok(lightThemeStart > darkThemeStart, 'light theme token block should follow dark tokens');

  const darkTokens = tokensCss.slice(darkThemeStart, lightThemeStart);
  const lightTokens = tokensCss.slice(lightThemeStart);

  assert.match(
    darkTokens,
    /--app-nav-rail-glass-bg:\s*linear-gradient\(180deg, oklch\(18% 0\.008 252 \/ 0\.18\) 0%, oklch\(12% 0\.006 252 \/ 0\.10\) 100%\);/,
  );
  assert.match(
    lightTokens,
    /--app-nav-rail-glass-bg:\s*linear-gradient\(180deg, rgb\(252 253 255 \/ 0\.52\) 0%, rgb\(240 243 248 \/ 0\.40\) 100%\);/,
  );
});

test('resolved Kordi theme is applied to the native macOS material', async () => {
  const appliedThemes: string[] = [];
  const target = {
    setTheme: async (theme: 'light' | 'dark') => {
      appliedThemes.push(theme);
    },
  };

  await syncNativeWindowTheme('dark', target);
  await syncNativeWindowTheme('light', target);

  assert.deepEqual(appliedThemes, ['dark', 'light']);

  const gateSource = readSource('src/KordiApp.tsx');
  const shellEffectsSource = readSource('src/app/useKordiUiEffects.ts');
  assert.match(gateSource, /syncNativeWindowTheme\(theme\)/);
  assert.match(shellEffectsSource, /syncNativeWindowTheme\(themeMode\)/);
});
