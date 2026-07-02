import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

function readAuthSource(relativePath: string): string {
  return readFileSync(new URL(`../src/kordi-app/auth/${relativePath}`, import.meta.url), 'utf8');
}

test('provider gate is a focused single-column launch surface', () => {
  const authPage = readAuthSource('AuthPage.tsx');

  assert.match(authPage, /Connect a provider/);
  assert.match(authPage, /Use cloud APIs or local models to start chatting\./);
  assert.doesNotMatch(authPage, /Connect one provider before your first chat\./);
  assert.doesNotMatch(authPage, /grid-cols-\[minmax\(320px,0\.86fr\)_minmax\(460px,1\.08fr\)\]/);
  assert.doesNotMatch(authPage, /Shared sign-in store/);
  assert.doesNotMatch(authPage, /Shared authentication enabled/);
  assert.doesNotMatch(authPage, /Details stay in Settings → Authentication\./);
  assert.match(authPage, /You can find this setting anytime in Settings → Authentication\./);
});

test('gate provider picker uses cards without forced uppercase microcopy', () => {
  const providerList = readAuthSource('AuthProviderList.tsx');

  assert.match(providerList, /variant\?: 'settings' \| 'gate'/);
  assert.match(providerList, /grid-cols-\[repeat\(2,minmax\(0,1fr\)\)\]/);
  assert.match(providerList, /app-auth-provider-gate-card/);
  assert.doesNotMatch(providerList, /app-auth-provider-gate-card-selected/);
  assert.doesNotMatch(providerList, /col-span-2/);
  assert.match(providerList, /ChatGPT subscription or API key/);
  assert.match(providerList, /API key/);
  assert.match(providerList, /Copilot subscription/);
  assert.match(providerList, /Model router API/);
  assert.doesNotMatch(providerList, /Fast inference/);
  assert.doesNotMatch(providerList, /Local inference/);
  assert.doesNotMatch(providerList, /\buppercase\b/);
  assert.doesNotMatch(providerList, /saved of/);
  assert.doesNotMatch(providerList, /provider\.loginHint/);

  const shellPages = readFileSync(new URL('../src/styles/shell-pages.css', import.meta.url), 'utf8');
  const gateHoverRule = shellPages.match(/\.app-auth-provider-gate-card:hover,[\s\S]*?\n}\n/)?.[0] ?? '';
  assert.match(gateHoverRule, /background:/);
  assert.match(gateHoverRule, /box-shadow:/);
  assert.doesNotMatch(gateHoverRule, /translateY|scale\(|animation:/);
  assert.doesNotMatch(shellPages, /app-auth-provider-selected/);
});

test('provider gate uses a flat cool light surface without modal board chrome', () => {
  const authPage = readAuthSource('AuthPage.tsx');
  const themeOverrides = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');

  assert.match(authPage, /app-auth-gate-shell/);
  assert.match(authPage, /app-auth-gate-shell flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-none border-0 bg-transparent px-8 py-8 shadow-none/);
  assert.doesNotMatch(authPage, /app-modal-panel flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-\[30px\] border border-white\/10/);

  const gateLightRule = themeOverrides.match(/\.bridge-app\.theme-light \.app-auth-gate-shell \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(gateLightRule, /background:/);
  assert.match(gateLightRule, /rgb\(248 251 255\)|rgb\(241 247 255\)|rgba\(248, 251, 255/);
  assert.doesNotMatch(gateLightRule, /rgba\(248, 246, 242|rgba\(245, 240, 232|warm|amber|orange/);
  assert.match(gateLightRule, /box-shadow:\s*none/);
});

test('inline auth popup uses direct handoff copy without authentication status chips', () => {
  const authPopup = readFileSync(new URL('../src/AuthPopup.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(authPopup, /Authentication window/);
  assert.doesNotMatch(authPopup, />Authentication</);
  assert.doesNotMatch(authPopup, /Authentication successful/);
  assert.match(authPopup, /Signed in/);
  assert.match(authPopup, /This account is connected and ready to use\./);
  assert.match(authPopup, /Finish sign-in/);
});

test('inline auth popup uses cool chat-aligned light cards instead of warm gray', () => {
  const authPopup = readFileSync(new URL('../src/AuthPopup.tsx', import.meta.url), 'utf8');
  const authFlowSteps = readAuthSource('AuthFlowSteps.tsx');
  const themeOverrides = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');

  assert.match(authPopup, /app-auth-popup-panel/);
  assert.match(authPopup, /app-auth-popup-info-card/);
  assert.match(authPopup, /app-auth-popup-note/);
  assert.match(authFlowSteps, /app-auth-flow-steps/);

  const popupPaletteBlock = themeOverrides.slice(
    themeOverrides.indexOf('.bridge-app.theme-light .app-auth-popup-panel'),
    themeOverrides.indexOf('.bridge-app.theme-light .app-agent-shell'),
  );

  assert.match(popupPaletteBlock, /rgba\(248, 251, 255, 0\.96\)/);
  assert.match(popupPaletteBlock, /rgba\(241, 247, 255, 0\.92\)/);
  assert.match(popupPaletteBlock, /rgba\(37, 99, 235, 0\.12\)/);
  assert.match(popupPaletteBlock, /rgba\(239, 246, 255, 0\.72\)/);
  assert.doesNotMatch(popupPaletteBlock, /rgba\(126,\s*111,\s*64|rgba\(147,\s*128,\s*109|rgba\(138,\s*118,\s*98|rgb\(245 241 232\)|rgba\(255, 252, 244|warm|amber|orange/i);
});

test('provider detail view keeps a persistent back control without nesting settings scroll areas', () => {
  const authPage = readAuthSource('AuthPage.tsx');
  const providerDetail = readAuthSource('AuthProviderDetail.tsx');

  assert.match(authPage, /Back to providers/);
  assert.doesNotMatch(authPage, /\{provider\.label\} auth/);
  assert.doesNotMatch(authPage, /aria-label="Go forward"/);
  assert.doesNotMatch(authPage, /AuthNavigationControls/);
  const settingsDetailContentStart = authPage.indexOf('const settingsDetailContent');
  const settingsDetailContentBlock = authPage.slice(
    settingsDetailContentStart,
    authPage.indexOf('  return (', settingsDetailContentStart),
  );
  assert.match(settingsDetailContentBlock, /const settingsDetailContent = showDetailPage \? \(\s*<div className="min-h-0 w-full min-w-0 max-w-none pb-6"[\s\S]*\{content\}[\s\S]*<\/div>\s*\) : \(/);
  assert.doesNotMatch(settingsDetailContentBlock, /ScrollArea/);
  assert.match(authPage, /showDetailPage[\s\S]*detailHeader[\s\S]*ScrollArea className="min-h-0 flex-1/);
  assert.match(providerDetail, /className="grid min-h-0 w-full gap-3\.5 pb-6"/);
  assert.doesNotMatch(providerDetail, /overflow-y-auto/);
});

test('auth pages avoid all-caps styling and use sentence-case detail chrome', () => {
  const authDir = new URL('../src/kordi-app/auth/', import.meta.url);
  const authTsxFiles = readdirSync(authDir)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => [file, readFileSync(new URL(file, authDir), 'utf8')] as const);

  authTsxFiles.push(['AuthPopup.tsx', readFileSync(new URL('../src/AuthPopup.tsx', import.meta.url), 'utf8')]);

  for (const [file, source] of authTsxFiles) {
    assert.doesNotMatch(source, /\buppercase\b/, `${file} should not force all-caps text`);
    assert.doesNotMatch(source, /tracking-\[0\.1[2468]em\]/, `${file} should not use small-caps letter spacing`);
  }

  const authPage = readAuthSource('AuthPage.tsx');
  const providerDetail = readAuthSource('AuthProviderDetail.tsx');

  assert.doesNotMatch(authPage, /\{provider\.label\} auth/);
  assert.doesNotMatch(providerDetail, /What this provider is for/);
  assert.doesNotMatch(providerDetail, /Storage and cleanup/);
  assert.doesNotMatch(providerDetail, /<DetailSection title="Connect">/);
});

test('login from the first-run gate opens the auth page without routing into settings', () => {
  const uiState = readFileSync(new URL('../src/features/auth/useDesktopAuthUiState.ts', import.meta.url), 'utf8');

  assert.match(uiState, /const shouldStayOnAuthGate = !startupGateSatisfied && !isAuthGateDismissed/);
  assert.match(uiState, /if \(!shouldStayOnAuthGate\) \{\s*openAuthSettings\(\);\s*\}/);
});

test('inline provider configuration keeps the first-run gate behind it', () => {
  const uiState = readFileSync(new URL('../src/features/auth/useDesktopAuthUiState.ts', import.meta.url), 'utf8');
  const showGateExpression = uiState.match(/const showAuthGate = useMemo\(\(\) => \([\s\S]*?\), \[/)?.[0] ?? '';

  assert.doesNotMatch(showGateExpression, /&& !inlineAuthDialog/);
});

test('provider detail does not repeat connect actions in an upper hero', () => {
  const providerDetail = readAuthSource('AuthProviderDetail.tsx');

  assert.doesNotMatch(providerDetail, /Connect access/);
  assert.doesNotMatch(providerDetail, /Connect \$\{provider\.label\}/);
  assert.doesNotMatch(providerDetail, /Setup needed/);
  assert.doesNotMatch(providerDetail, /primaryConnect\.method/);
});
