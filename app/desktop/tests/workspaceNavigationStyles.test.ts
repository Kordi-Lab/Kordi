import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readSource = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('workspace rail navigation owns its semantic active and focus states', () => {
  const source = readSource('src/pages/workspaceSidebar.navigation.tsx');
  const styles = readSource('src/styles/shell-sidebar.css');

  assert.match(source, /data-active=\{active \? 'true' : 'false'\}/);
  assert.match(source, /aria-current=\{active \? 'page' : undefined\}/);
  assert.doesNotMatch(source, /app-workspace-nav-button app-list-item/);
  assert.match(styles, /\.app-workspace-nav-button\[data-active='true'\]/);
  assert.match(styles, /\.app-workspace-nav-button:focus-visible/);
  assert.match(styles, /--app-nav-rail-active-bg/);
});

test('workspace rail navigation has explicit light and dark theme tokens', () => {
  const tokens = readSource('src/styles/theme-tokens.css');
  const activeBackgrounds = tokens.match(/--app-nav-rail-active-bg:/g) ?? [];
  const activeForegrounds = tokens.match(/--app-nav-rail-active-text:/g) ?? [];
  const lightTokens = tokens.slice(tokens.indexOf('.kordi-app.theme-light {'));

  assert.equal(activeBackgrounds.length, 2);
  assert.equal(activeForegrounds.length, 2);
  assert.match(tokens, /--app-nav-rail-focus-ring:/);
  assert.match(lightTokens, /--app-sidebar-selected-bg:\s*#EEF4FF;/);
  assert.match(lightTokens, /--app-nav-rail-active-bg:\s*var\(--app-sidebar-selected-bg\);/);
  assert.match(lightTokens, /--app-nav-rail-active-hover-bg:\s*color-mix\(in oklab, var\(--app-sidebar-selected-bg\) 86%, var\(--app-sidebar-accent\)\);/);
  assert.match(lightTokens, /--app-nav-rail-active-pressed-bg:\s*color-mix\(in oklab, var\(--app-sidebar-selected-bg\) 76%, var\(--app-sidebar-accent\)\);/);
  assert.match(lightTokens, /--app-nav-rail-active-text:\s*var\(--app-sidebar-title-text\);/);
  assert.doesNotMatch(lightTokens, /--app-nav-rail-active-bg:\s*oklch\(58% 0\.115 242\);/);
});
