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
    value: 'EthansKordi',
    label: 'EthansKordi',
    detail: 'Owner · Ethan',
    targetKind: 'agent',
    sourceHostId: 'host-1',
    nodeId: 'node-agent',
    runtime: 'kordi-desktop',
    agentId: 'agent-1',
    ownerName: 'Ethan',
    avatarImageUrl: 'https://images.test/ethan-agent.png',
  } as ComposerMentionOption,
  {
    value: 'Alice',
    label: 'Alice',
    detail: 'Person',
    targetKind: 'person',
    sourceHostId: 'host-1',
    nodeId: 'node-person',
    runtime: 'person',
    humanId: 'human-1',
    avatarImageUrl: 'https://images.test/alice.png',
  } as ComposerMentionOption,
];

const referenceOption: ComposerMentionOption = {
  value: 'src/app.tsx',
  label: 'app.tsx',
  detail: 'Code file · src/',
  targetKind: 'reference',
  sourceHostId: 'local-files',
  nodeId: '/workspace/src/app.tsx',
  runtime: 'reference',
  referenceKind: 'file',
  referencePath: '/workspace/src/app.tsx',
};

test('mention participant menu uses the shared near-opaque transient surface', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    items: options,
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  const menuClass = html.match(/<div class="([^"]*app-composer-mention-menu[^"]*)"/)?.[1] ?? '';
  assert.ok(menuClass, 'mention menu should expose the transient-surface class');
  assert.match(menuClass, /app-transient-surface/);
  assert.doesNotMatch(menuClass, /backdrop-blur/);

  const css = readDesktopShellCss();
  const menuRule = cssRule(css, '.app-composer-mention-menu');
  assert.match(menuRule, /background:\s*var\(--app-composer-mention-menu-bg\);/);
  assert.doesNotMatch(menuRule, /transparent/);
  assert.doesNotMatch(menuRule, /backdrop-filter/);

  const sharedSurfaceContract = readFileSync(new URL('../src/styles/transient-surfaces.css', import.meta.url), 'utf8');
  const lightRule = cssRule(css, '.kordi-app.theme-light .app-composer-mention-menu');
  assert.match(sharedSurfaceContract, /\.app-transient-surface,[\s\S]*background:\s*var\(--app-transient-surface-fallback\) !important;/);
  assert.match(sharedSurfaceContract, /\.app-transient-surface,[\s\S]*background:\s*var\(--app-transient-surface-bg\) !important;/);
  assert.match(lightRule, /--app-composer-mention-menu-bg:\s*var\(--app-transient-surface-bg\);/);
});

test('mention participant menu can carry light theme after portaling outside the app shell', () => {
  const css = readDesktopShellCss();
  const lightRule = cssRule(css, '.app-composer-mention-menu-light');
  const themeTokens = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');
  assert.match(lightRule, /color-scheme:\s*light;/);
  assert.match(themeTokens, /\.app-composer-mention-menu-light\)\s*\{[\s\S]*--app-transient-surface-bg:\s*rgb\(252 252 253 \/ 0\.985\);/);

  const source = readFileSync(new URL('../src/kordi-app/components/composerMentionMenu.tsx', import.meta.url), 'utf8');
  assert.match(source, /setMenuThemeClass/);
  assert.match(source, /app-composer-mention-menu-light/);
  assert.match(source, /onSelect\(item\)/);
});

test('unified mention selection preserves the selected agent identity for sending', () => {
  const controller = readFileSync(new URL('../src/pages/useComposerReferenceOptions.ts', import.meta.url), 'utf8');
  const composer = readFileSync(new URL('../src/pages/chatsPage.mainComposer.tsx', import.meta.url), 'utf8');
  assert.match(controller, /onSelectOption\?\.\(item\)/);
  assert.match(composer, /onSelectOption:\s*acceptChatMentionTarget/);
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

  const source = readFileSync(new URL('../src/kordi-app/components/composerMentionMenu.tsx', import.meta.url), 'utf8');
  assert.match(source, /createPortal\(menu, document\.body\)/);
  assert.doesNotMatch(source, /app-composer-mention-menu[^"`]*z-30/);
});

test('mention participant menu uses product-facing copy and correct avatars', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    items: options,
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  assert.match(html, /src="https:\/\/images\.test\/ethan-agent\.png"/);
  assert.match(html, /src="https:\/\/images\.test\/alice\.png"/);
  assert.doesNotMatch(html, /Bridge person/);
  assert.doesNotMatch(html, /Bridge agent/);
  assert.doesNotMatch(html, /kordi-desktop/);
  assert.doesNotMatch(html, /Owner:/);
  assert.match(html, /app-composer-mention-menu-detail/);
  assert.match(html, />Owner · Ethan</);
  assert.doesNotMatch(html, />Person</);
});

test('unified mention menu groups references, contacts, and agents without redundant chrome', () => {
  const html = renderToStaticMarkup(createElement(ComposerMentionMenu, {
    id: 'mention-menu',
    items: [...options, referenceOption],
    selectedIndex: 0,
    onSelect: () => undefined,
  }));

  assert.match(html, /role="listbox"/);
  assert.match(html, />References</);
  assert.match(html, />Contacts</);
  assert.match(html, />Agents</);
  assert.match(html, /app-composer-mention-menu-reference-icon/);
  assert.doesNotMatch(html, />File</);
  assert.doesNotMatch(html, /app-composer-mention-menu-kind/);
  assert.match(html, /mention-menu-option-0/);
  assert.doesNotMatch(html, /Navigate|Esc Close|app-composer-mention-menu-footer/);
});

test('attach file mention action reuses each composer file input', () => {
  const shared = readFileSync(new URL('../src/pages/useComposerReferenceOptions.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/pages/chatsPage.mainComposer.tsx', import.meta.url), 'utf8');
  const project = readFileSync(new URL('../src/pages/ProjectsPage.tsx', import.meta.url), 'utf8');
  const thread = readFileSync(new URL('../src/pages/ChatThreadPanel.tsx', import.meta.url), 'utf8');

  assert.match(shared, /referenceAction === 'pick-file'[\s\S]*onPickFile\(\)/);
  assert.match(main, /onPickFile: \(\) => chatAttachmentInputRef\.current\?\.click\(\)/);
  assert.match(project, /onPickFile: \(\) => chatAttachmentInputRef\.current\?\.click\(\)/);
  assert.match(thread, /onPickFile: \(\) => inputRef\.current\?\.click\(\)/);
});

test('mention participant menu keeps owner metadata subordinate to the agent name', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/composerMentionMenu.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('export function ComposerMentionMenu');
  assert.ok(start >= 0, 'expected ComposerMentionMenu source block');
  const block = source.slice(start);

  assert.match(block, /app-composer-mention-menu[^']*rounded-\[14px\][^']*p-1\.5/);
  assert.match(block, /app-composer-mention-menu-item[^']*rounded-\[10px\][^']*px-2\.5 py-1\.5[^']*text-\[13px\]/);
  assert.match(block, /app-composer-mention-menu-icon h-6 w-6/);
  assert.match(block, /app-composer-mention-menu-at/);
  assert.match(block, /app-composer-mention-menu-label[^']*text-\[13px\][^']*font-medium/);
  assert.match(block, /Math\.min\(\s*480,/);
  assert.match(block, /app-composer-mention-menu-detail[^']*text-\[10\.5px\][^']*leading-4/);
  assert.doesNotMatch(block, /app-composer-mention-menu-section[^']*uppercase/);
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

test('mention menu avoids a redundant title above its section labels', () => {
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
  const lightShellRule = cssRule(css, '.kordi-app.theme-light .app-composer-mention-menu');
  const activeRule = cssRule(css, '.app-composer-mention-menu-item-active');
  const hoverRule = cssRule(css, '.app-composer-mention-menu-item:not(.app-composer-mention-menu-item-active):hover');

  assert.match(darkRule, /--app-composer-mention-menu-item-hover-bg:\s*var\(--app-transient-hover-bg\);/);
  assert.match(darkRule, /--app-composer-mention-menu-item-active-bg:\s*var\(--app-transient-hover-bg\);/);
  assert.match(lightClassRule, /color-scheme:\s*light;/);
  assert.match(lightShellRule, /--app-composer-mention-menu-item-hover-bg:\s*var\(--app-transient-hover-bg\);/);
  assert.match(lightShellRule, /--app-composer-mention-menu-item-active-bg:\s*var\(--app-transient-hover-bg\);/);
  assert.match(activeRule, /background:\s*var\(--app-composer-mention-menu-item-active-bg\);/);
  assert.match(hoverRule, /background:\s*var\(--app-composer-mention-menu-item-hover-bg\);/);
  assert.doesNotMatch(`${darkRule}\n${lightClassRule}\n${lightShellRule}\n${activeRule}`, /indigo|purple|818cf8|99,\s*102,\s*241|226 232 240|35 43 57|53 63 82|203 213 225/i);
});
