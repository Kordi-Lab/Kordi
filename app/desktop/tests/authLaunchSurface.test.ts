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
  assert.match(authPage, /Shared authentication enabled/);
});

test('gate provider picker uses cards without forced uppercase microcopy', () => {
  const providerList = readAuthSource('AuthProviderList.tsx');

  assert.match(providerList, /variant\?: 'settings' \| 'gate'/);
  assert.match(providerList, /grid-cols-\[repeat\(2,minmax\(0,1fr\)\)\]/);
  assert.match(providerList, /ChatGPT \+ API/);
  assert.match(providerList, /Claude \+ API/);
  assert.doesNotMatch(providerList, /\buppercase\b/);
  assert.doesNotMatch(providerList, /saved of/);
  assert.doesNotMatch(providerList, /provider\.loginHint/);
});

test('provider detail view keeps a persistent back control and scroll boundary', () => {
  const authPage = readAuthSource('AuthPage.tsx');
  const providerDetail = readAuthSource('AuthProviderDetail.tsx');

  assert.match(authPage, /Back to providers/);
  assert.doesNotMatch(authPage, /\{provider\.label\} auth/);
  assert.doesNotMatch(authPage, /aria-label="Go forward"/);
  assert.doesNotMatch(authPage, /AuthNavigationControls/);
  assert.match(authPage, /const settingsDetailContent = showDetailPage \? \([\s\S]*ScrollArea className="min-h-0 flex-1 pr-2"[\s\S]*\{content\}[\s\S]*\) : \(/);
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
  assert.match(providerDetail, /<DetailSection title="Connect">/);
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
