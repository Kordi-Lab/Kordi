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
    avatarImageUrl: 'https://images.test/shenzhe-agent.png',
  } as ComposerMentionOption,
  {
    value: 'Alice',
    label: 'Alice',
    detail: 'Person',
    targetKind: 'bridge-person',
    bridgeHostId: 'host-1',
    nodeId: 'node-person',
    runtime: 'person',
    humanId: 'human-1',
    avatarImageUrl: 'https://images.test/alice.png',
  } as ComposerMentionOption,
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

test('mention participant menu uses product-facing copy and correct avatars', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    items: options,
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  assert.match(html, /src="https:\/\/images\.test\/shenzhe-agent\.png"/);
  assert.match(html, /src="https:\/\/images\.test\/alice\.png"/);
  assert.doesNotMatch(html, /Bridge person/);
  assert.doesNotMatch(html, /Bridge agent/);
  assert.doesNotMatch(html, /kordi-desktop/);
  assert.doesNotMatch(html, /Owner:/);
  assert.doesNotMatch(html, /app-composer-mention-menu-detail/);
  assert.doesNotMatch(html, />Agent owned by Shenzhe</);
  assert.doesNotMatch(html, />Person</);
});

test('mention participant menu uses polished card sizing without secondary detail text', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('export function ComposerMentionMenu');
  const end = source.indexOf('export function composerThinkingLabel', start);
  assert.ok(start >= 0 && end > start, 'expected ComposerMentionMenu source block');
  const block = source.slice(start, end);

  assert.match(block, /app-composer-mention-menu[^']*rounded-\[22px\][^']*px-2 py-2/);
  assert.match(block, /app-composer-mention-menu-item[^']*rounded-\[16px\][^']*px-2\.5 py-2[^']*text-\[13px\]/);
  assert.match(block, /app-composer-mention-menu-icon h-7 w-7/);
  assert.match(block, /app-composer-mention-menu-at/);
  assert.match(block, /app-composer-mention-menu-label[^']*text-\[13px\][^']*font-semibold/);
  assert.match(block, /Math\.min\(\s*Math\.max\(240, rect\.width\),/);
  assert.doesNotMatch(block, /Math\.min\(\s*480,/);
  assert.doesNotMatch(block, /app-composer-mention-menu-detail/);
  assert.doesNotMatch(block, /<AtSign/);
  assert.doesNotMatch(block, /h-5 w-5/);
  assert.doesNotMatch(block, /px-2 py-1/);
});

test('mention participant menu does not render unread count badges', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    items: [{ ...options[0], unreadCount: 7 }],
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  assert.doesNotMatch(html, />7</);
  assert.doesNotMatch(html, /tabular-nums/);
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

test('mention participant selected row uses a soft hover-like state in both themes without accent edges', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    items: options,
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  assert.match(html, /app-composer-mention-menu-item-active/);
  assert.doesNotMatch(html, /app-composer-mention-menu-kind-active/);

  const css = readDesktopShellCss();
  const darkRule = cssRule(css, '.app-composer-mention-menu');
  const lightClassRule = cssRule(css, '.app-composer-mention-menu-light');
  const lightShellRule = cssRule(css, '.bridge-app.theme-light .app-composer-mention-menu');
  const activeRule = cssRule(css, '.app-composer-mention-menu-item-active');
  const hoverRule = cssRule(css, '.app-composer-mention-menu-item:not(.app-composer-mention-menu-item-active):hover');

  assert.match(darkRule, /--app-composer-mention-menu-item-hover-bg:\s*rgba\(255, 255, 255, 0\.075\);/);
  assert.match(darkRule, /--app-composer-mention-menu-item-active-bg:\s*rgba\(255, 255, 255, 0\.075\);/);
  assert.match(lightClassRule, /--app-composer-mention-menu-item-hover-bg:\s*rgb\(248 250 252\);/);
  assert.match(lightClassRule, /--app-composer-mention-menu-item-active-bg:\s*rgb\(248 250 252\);/);
  assert.match(lightShellRule, /--app-composer-mention-menu-item-hover-bg:\s*rgb\(248 250 252\);/);
  assert.match(lightShellRule, /--app-composer-mention-menu-item-active-bg:\s*rgb\(248 250 252\);/);
  assert.match(activeRule, /background:\s*var\(--app-composer-mention-menu-item-active-bg\);/);
  assert.match(hoverRule, /background:\s*var\(--app-composer-mention-menu-item-hover-bg\);/);
  assert.doesNotMatch(`${darkRule}\n${lightClassRule}\n${lightShellRule}\n${activeRule}`, /indigo|purple|818cf8|99,\s*102,\s*241|226 232 240|35 43 57|53 63 82|203 213 225/i);
});
