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

test('every rail badge is the same neutral pill capped at 9+', async () => {
  const { formatRailBadgeCount } = await import('../src/pages/workspaceSidebar.badges');
  assert.equal(formatRailBadgeCount(1), '1');
  assert.equal(formatRailBadgeCount(9), '9');
  assert.equal(formatRailBadgeCount(10), '9+');

  const source = readSource('src/pages/workspaceSidebar.navigation.tsx');
  const styles = readSource('src/styles/shell-sidebar.css');
  assert.equal((source.match(/app-nav-rail-unread-badge/g) ?? []).length, 1, 'contact requests and unread chats share one badge');
  assert.doesNotMatch(source, /emerald|bg-green/);
  const badge = styles.match(/\.app-nav-rail-unread-badge\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(badge, /height:\s*16px;/);
  assert.match(badge, /background:\s*var\(--app-nav-rail-badge-bg\);/);
  assert.match(badge, /color:\s*var\(--app-nav-rail-badge-text\);/);
  assert.match(badge, /box-shadow:\s*0 0 0 1\.5px var\(--app-nav-rail-unread-ring\);/);
  for (const file of ['src/styles/theme-tokens.css', 'src/styles/theme-palette.css']) {
    assert.match(readSource(file), /--app-nav-rail-badge-bg:/, file);
  }
});
