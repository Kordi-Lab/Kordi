import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { syncNativeWindowTheme } from '../src/app/nativeWindowTheme';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

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

test('native shell exposes vibrancy through the complete left navigation stack', () => {
  const shellCss = readDesktopShellCss();
  const tokensCss = readSource('src/styles/theme-tokens.css');
  const profileControl = readSource('src/pages/workspaceSidebar.profile.tsx');
  const indexHtml = readSource('index.html');

  assert.match(indexHtml, /__TAURI_INTERNALS__[\s\S]*document\.documentElement\.classList\.add\('kordi-native-shell'\)/);
  assert.match(shellCss, /html\.kordi-native-shell \.kordi-app \.app-left-glass\s*\{[^}]*background:\s*var\(--app-nav-rail-glass-bg\)/s);
  assert.match(shellCss, /html\.kordi-native-shell \.kordi-app \.app-session-panel\s*\{[^}]*background:\s*var\(--app-native-session-bg\)/s);
  assert.match(shellCss, /html\.kordi-native-shell \.kordi-app \.app-main-panel\s*\{[^}]*background:\s*var\(--app-native-main-bg\)/s);
  assert.match(shellCss, /html\.kordi-native-shell \.kordi-app \.app-shell,[\s\S]*html\.kordi-native-shell \.kordi-app \.app-main-panel\s*\{[^}]*backdrop-filter:\s*none/s);
  assert.match(shellCss, /@media \(prefers-reduced-transparency: reduce\)[\s\S]*\.app-left-glass\s*\{[^}]*background:\s*var\(--app-nav-rail-glass-fallback\)[\s\S]*\.app-session-panel\s*\{[^}]*background:\s*var\(--app-native-session-fallback\)/s);
  assert.equal((tokensCss.match(/--app-nav-rail-glass-bg:/g) ?? []).length, 2);
  assert.equal((tokensCss.match(/--app-native-session-bg:/g) ?? []).length, 2);
  assert.equal((tokensCss.match(/--app-native-session-fallback:/g) ?? []).length, 2);
  assert.equal((tokensCss.match(/--app-native-main-bg:/g) ?? []).length, 2);
  assert.match(tokensCss, /\.kordi-app\.theme-light\s*{[\s\S]*--app-native-session-bg:\s*var\(--app-session-bg\);/);
  assert.match(profileControl, /className="app-nav-rail-profile rounded-full"/);
  assert.match(profileControl, /className="app-nav-rail-avatar h-9 w-9"/);
  assert.doesNotMatch(profileControl, /shadow-\[inset_-1px_0_0_rgba/);
});

test('navigation rail uses black glass in dark mode and translucent white glass in light mode', () => {
  const tokensCss = readSource('src/styles/theme-tokens.css');
  const darkThemeStart = tokensCss.indexOf('.kordi-app {');
  const lightThemeStart = tokensCss.indexOf('.kordi-app.theme-light {');
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
    /--app-nav-rail-glass-bg:\s*linear-gradient\(180deg, oklch\(99% 0\.002 248 \/ 0\.34\) 0%, oklch\(96% 0\.004 248 \/ 0\.24\) 100%\);/,
  );
  assert.match(
    lightTokens,
    /--app-nav-rail-glass-fallback:\s*linear-gradient\(180deg, oklch\(96\.5% 0\.004 248 \/ 0\.98\) 0%, oklch\(93\.5% 0\.005 248 \/ 0\.98\) 100%\);/,
  );
  assert.match(lightTokens, /--app-side-bg:\s*oklch\(99\.2% 0\.001 80 \/ 0\.58\);/);
  assert.match(lightTokens, /--app-session-bg:\s*oklch\(99\.4% 0\.001 80 \/ 0\.68\);/);
  assert.match(lightTokens, /--app-native-session-fallback:\s*oklch\(98\.6% 0\.002 80\);/);
});

test('system Kordi theme clears the native macOS material override', async () => {
  const appliedThemes: Array<'light' | 'dark' | null> = [];
  const target = {
    setTheme: async (theme: 'light' | 'dark' | null) => {
      appliedThemes.push(theme);
    },
  };

  await syncNativeWindowTheme('auto', target);
  await syncNativeWindowTheme('dark', target);
  await syncNativeWindowTheme('auto', target);

  assert.deepEqual(appliedThemes, [null, 'dark', null]);

  const gateSource = readSource('src/KordiApp.tsx');
  const shellEffectsSource = readSource('src/app/useKordiUiEffects.ts');
  const workspaceSource = readSource('src/app/useKordiWorkspaceState.ts');
  assert.match(gateSource, /syncNativeWindowTheme\(themeMode\)/);
  assert.match(shellEffectsSource, /syncNativeWindowTheme\(themeMode\)/);
  assert.match(shellEffectsSource, /\[resolvedThemeMode, themeMode\]/);
  assert.match(workspaceSource, /themeMode: settingsUi\.themeMode/);
  assert.match(workspaceSource, /resolvedThemeMode: settingsUi\.resolvedThemeMode/);
});
