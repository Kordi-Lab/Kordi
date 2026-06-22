import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ComposerMentionMenu, type ComposerMentionOption } from '../src/kordi-app/components/composer';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[0];
}

const options: ComposerMentionOption[] = [
  {
    value: 'ShenzhesKordi',
    label: 'ShenzhesKordi',
    detail: 'Agent owned by Shenzhe',
    targetKind: 'bridge-agent',
    bridgeHostId: 'host-1',
    nodeId: 'node-agent',
    runtime: 'kordi-desktop',
    agentId: 'agent-1',
    ownerName: 'Shenzhe',
  },
  {
    value: 'Alice',
    label: 'Alice',
    detail: 'Person',
    targetKind: 'bridge-person',
    bridgeHostId: 'host-1',
    nodeId: 'node-person',
    runtime: 'person',
    humanId: 'human-1',
  },
];

test('mention participant menu uses its own solid surface instead of the shared translucent modal blur', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    items: options,
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  const menuClass = html.match(/<div class="([^"]*app-composer-mention-menu[^"]*)"/)?.[1] ?? '';
  assert.ok(menuClass, 'mention menu should expose the solid-surface class');
  assert.doesNotMatch(menuClass, /app-modal-panel/);
  assert.doesNotMatch(menuClass, /backdrop-blur/);

  const css = readDesktopShellCss();
  const menuRule = cssRule(css, '.app-composer-mention-menu');
  assert.match(menuRule, /background:\s*var\(--app-composer-mention-menu-bg\);/);
  assert.doesNotMatch(menuRule, /transparent/);
  assert.doesNotMatch(menuRule, /backdrop-filter/);

  const lightRule = cssRule(css, '.bridge-app.theme-light .app-composer-mention-menu');
  assert.match(lightRule, /--app-composer-mention-menu-bg:\s*rgb\(255 255 255\);/);
});

test('mention participant menu can carry light theme after portaling outside the app shell', () => {
  const css = readDesktopShellCss();
  const lightRule = cssRule(css, '.app-composer-mention-menu-light');
  assert.match(lightRule, /--app-composer-mention-menu-bg:\s*rgb\(255 255 255\);/);

  const source = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');
  assert.match(source, /setMenuThemeClass/);
  assert.match(source, /app-composer-mention-menu-light/);
});

test('mention participant menu is rendered on the foreground popover layer', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    items: options,
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  assert.match(html, /app-composer-mention-menu-layer/);

  const css = readDesktopShellCss();
  const layerRule = cssRule(css, '.app-composer-mention-menu-layer');
  assert.match(layerRule, /z-index:\s*2147483000/);

  const source = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');
  assert.match(source, /createPortal\(renderMenu\(\), document\.body\)/);
  assert.doesNotMatch(source, /app-composer-mention-menu[^"`]*z-30/);
});

test('mention participant menu does not render a header or shortcut hint', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    items: options,
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  assert.doesNotMatch(html, /Mention participant/);
  assert.doesNotMatch(html, /Tab select/);
  assert.doesNotMatch(html, /app-composer-mention-menu-header/);
});

test('mention participant selected row has an opaque readable state', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    items: options,
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  assert.match(html, /app-composer-mention-menu-item-active/);
  const css = readDesktopShellCss();
  const activeRule = cssRule(css, '.app-composer-mention-menu-item-active');
  assert.match(activeRule, /background:\s*var\(--app-composer-mention-menu-item-active-bg\);/);
  assert.doesNotMatch(activeRule, /transparent/);

  const hoverRule = cssRule(css, '.app-composer-mention-menu-item:not\(.app-composer-mention-menu-item-active\):hover');
  assert.match(hoverRule, /background:\s*var\(--app-composer-mention-menu-item-hover-bg\);/);
});
