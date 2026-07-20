import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readSource = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('workspace rail navigation owns its semantic active and focus states', () => {
  const source = readSource('src/pages/WorkspaceSidebar.tsx');
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
  const lightTokens = tokens.slice(tokens.indexOf('.bridge-app.theme-light {'));

  assert.equal(activeBackgrounds.length, 2);
  assert.equal(activeForegrounds.length, 2);
  assert.match(tokens, /--app-nav-rail-focus-ring:/);
  assert.match(lightTokens, /--app-nav-rail-active-bg:\s*oklch\(58% 0\.115 242\);/);
  assert.match(lightTokens, /--app-nav-rail-active-hover-bg:\s*oklch\(61% 0\.120 242\);/);
  assert.match(lightTokens, /--app-nav-rail-active-pressed-bg:\s*oklch\(54% 0\.110 242\);/);
  assert.match(lightTokens, /--app-nav-rail-active-text:\s*oklch\(96% 0\.010 242\);/);
  assert.doesNotMatch(lightTokens, /--app-nav-rail-active-bg:\s*oklch\(92\.5%/);
});
