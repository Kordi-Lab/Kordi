import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { CompactComposerModelMenu } from '../src/kordi-app/components/composer';
import { shouldUseCompactModelRouteMenu } from '../src/pages/ChatsPage';
import type { Conversation } from '../src/kordi-app/types';

const providerOptions = [
  { value: 'openai::personal', providerId: 'openai', label: 'openai', detail: 'personal key', selectionLabel: 'openai · personal key', active: true },
  { value: 'google::default', providerId: 'google', label: 'google gemini', detail: 'available fallback' },
];

const modelOptions = [
  { value: 'openai/gpt-5.1', label: 'gpt-5.1', provider: 'openai', detail: 'balanced for chat requests', thinkingLevels: ['auto', 'light', 'deep'] },
  { value: 'openai/gpt-5.1-mini', label: 'gpt-5.1-mini', provider: 'openai', detail: 'faster replies', thinkingLevels: ['auto', 'light'] },
];

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'session:direct-person:me:alice',
    name: 'alice',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'cloud',
    directness: 'direct person chat',
    participants: ['me', 'alice'],
    messages: [],
    ...overrides,
  };
}

test('compact composer model menu renders lowercase popout with foldable sections and save action', () => {
  const markup = renderToStaticMarkup(createElement(CompactComposerModelMenu, {
    scope: 'chat',
    selection: { mode: 'chat', model: 'openai/gpt-5.1', thinking: 'auto' },
    providerOptions,
    modelOptions,
    defaultOpen: true,
    onSave: () => {},
  }));

  assert.match(markup, /aria-label="model route"/);
  assert.match(markup, /data-compact-model-menu="true"/);
  assert.match(markup, /data-compact-model-trigger="bare"/);
  assert.match(markup, /lucide-menu/);
  assert.match(markup, /place-items-center/);
  assert.match(markup, /text-slate-400/);
  assert.match(markup, /app-compact-model-menu/);
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-label="Agent model"/);
  assert.match(markup, /aria-label="Close agent model"/);
  assert.match(markup, /app-button-quiet/);
  assert.doesNotMatch(markup, /app-button-outline/);
  assert.match(markup, /app-button-primary/);
  assert.match(markup, /app-compact-model-menu-option/);
  assert.doesNotMatch(markup, /Choose the provider, model, and thinking level\./);
  assert.doesNotMatch(markup, /only you see this/);
  assert.doesNotMatch(markup, /changes stay local in this popout until you save them\./);
  assert.doesNotMatch(markup, /pending route:/);
  assert.doesNotMatch(markup, /provider · gpt-5\.5/);
  assert.doesNotMatch(markup, /provider · gpt-5\.1/);
  assert.doesNotMatch(markup, /bg-\[rgba\(43,43,46,0\.82\)\]/);
  assert.doesNotMatch(markup, /bg-neutral-950\/25/);
  assert.doesNotMatch(markup, /bg-white\/8/);
  assert.doesNotMatch(markup, /bg-slate-200/);
  assert.doesNotMatch(markup, /data-compact-model-trigger="bare"[\s\S]{0,240}rounded-full/);
  assert.doesNotMatch(markup, /data-compact-model-trigger="bare"[\s\S]{0,260}bg-emerald/);
  assert.doesNotMatch(markup, /text-sky|bg-sky|ring-sky|hover:text-sky|hover:bg-sky/);
  assert.equal((markup.match(/<details/g) ?? []).length, 3);
  assert.equal((markup.match(/app-compact-model-menu-chevron/g) ?? []).length, 3);
  assert.equal((markup.match(/lucide-chevron-down/g) ?? []).length, 3);
  assert.doesNotMatch(markup, /<details open=""/);
  assert.match(markup, />Agent model</);
  assert.doesNotMatch(markup, />Agent Model</);
  assert.doesNotMatch(markup, />model route</);
  assert.match(markup, />provider</);
  assert.match(markup, />model</);
  assert.match(markup, />thinking level</);
  assert.match(markup, />save</);
  assert.match(markup, />cancel</);
  assert.doesNotMatch(markup, />Provider</);
  assert.doesNotMatch(markup, />Model</);
  assert.doesNotMatch(markup, />Thinking level</);
  assert.doesNotMatch(markup, />Save</);
});

test('compact model route menu uses light-theme tokenized popover colors', () => {
  const css = readDesktopShellCss();

  assert.match(css, /\.app-compact-model-menu\s*{[\s\S]*border:\s*1px solid var\(--app-transient-border\);/);
  assert.match(css, /\.app-compact-model-menu details\[open\] \.app-compact-model-menu-chevron\s*{[\s\S]*transform:\s*rotate\(180deg\);/);
  assert.match(css, /\.app-compact-model-menu-section \+ \.app-compact-model-menu-section\s*{[\s\S]*border-top:\s*1px solid var\(--app-transient-divider\);/);
  assert.match(css, /\.app-compact-model-menu \.app-compact-model-menu-option,[\s\S]*background:\s*transparent;/);
  assert.match(css, /\.app-compact-model-menu \.app-compact-model-menu-option:hover,[\s\S]*background:\s*var\(--app-transient-hover-bg\);/);
  assert.match(css, /\.kordi-app\.theme-light \.app-compact-model-menu,\n\.app-compact-model-menu-light\s*{[\s\S]*color-scheme:\s*light;/);
  assert.match(css, /\.app-compact-model-menu-light\s*{[\s\S]*--utility-foreground:\s*var\(--app-transient-text\);/);
  assert.match(css, /\.app-compact-model-menu-light\s*{[\s\S]*--utility-muted-text:\s*var\(--app-transient-muted-text\);/);
  assert.doesNotMatch(css, /--app-compact-model-menu-header-bg/);
  assert.doesNotMatch(css, /--app-compact-model-menu-save-bg/);
});

test('compact model route menu sits above transcript fold controls and uses the shared surface contract', () => {
  const markup = renderToStaticMarkup(createElement(CompactComposerModelMenu, {
    scope: 'chat',
    selection: { mode: 'chat', model: 'openai/gpt-5.1', thinking: 'auto' },
    providerOptions,
    modelOptions,
    defaultOpen: true,
    onSave: () => {},
  }));
  const css = readDesktopShellCss();
  const menuRule = css.match(/\.app-compact-model-menu\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const layerRule = css.match(/\.app-compact-model-menu-layer\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const source = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');

  assert.match(markup, /app-compact-model-menu-layer/);
  assert.doesNotMatch(markup, /\bz-30\b/);
  assert.doesNotMatch(menuRule, /background:/);
  assert.match(layerRule, /position:\s*fixed/);
  assert.match(layerRule, /z-index:\s*2147483000/);
  assert.match(source, /createPortal\(renderMenu\(\), document\.body\)/);
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /closest\('\.kordi-app'\)/);
  assert.match(source, /app-compact-model-menu-light/);
  assert.match(css, /@keyframes\s+app-compact-model-menu-enter/);
  assert.match(layerRule, /animation:\s*app-compact-model-menu-enter/);
  assert.match(menuRule, /--app-divider:\s*var\(--app-transient-divider\)/);
  assert.match(source, /app-transient-surface app-transient-scroll app-compact-model-menu/);
  assert.doesNotMatch(source, /app-transient-row flex min-h-11/);
  assert.match(source, /app-composer-popover-item app-compact-model-menu-option/);
  assert.doesNotMatch(source, /app-compact-model-menu-save/);
});

test('compact model route menu is scoped to group and human contact chats', () => {
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'person', directness: 'direct person chat' })), true);
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'person', directness: 'group chat', id: 'session:group:one' })), true);
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'group' as Conversation['type'], directness: 'group chat', id: 'session:group:one' })), true);
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'owned-agent', directness: 'direct chat' })), false);
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'external-agent', directness: 'agent thread' })), false);
});

test('compact menu stages changes until explicit save', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');
  assert.match(source, /const \[stagedProviderValue, setStagedProviderValue\] = useState/);
  assert.match(source, /const \[stagedModel, setStagedModel\] = useState/);
  assert.match(source, /const \[stagedThinking, setStagedThinking\] = useState/);
  assert.match(source, /const save = \(\) => \{[\s\S]*onSave\(\{ providerOption: stagedProviderOption, model: stagedModel, thinking: stagedThinkingValue \}\);/);
  assert.doesNotMatch(source, /chooseProvider = [\s\S]{0,260}onSave/);
  assert.doesNotMatch(source, /chooseModel = [\s\S]{0,220}onSave/);
});

test('compact model route menu dismisses when users click outside or press escape', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');
  const compactStart = source.indexOf('export function CompactComposerModelMenu');
  const controlsStart = source.indexOf('export function ComposerModelControls', compactStart);
  assert.notEqual(compactStart, -1, 'CompactComposerModelMenu should exist');
  assert.notEqual(controlsStart, -1, 'ComposerModelControls should follow CompactComposerModelMenu');
  const compactSource = source.slice(compactStart, controlsStart);

  assert.match(compactSource, /const menuRef = useRef<HTMLDivElement \| null>\(null\)/, 'compact route popout should keep a ref to its portaled menu');
  assert.match(compactSource, /document\.addEventListener\('pointerdown', handlePointerDown, true\)/, 'compact route popout should listen for outside pointer down in capture phase');
  assert.match(compactSource, /document\.addEventListener\('keydown', handleKeyDown, true\)/, 'compact route popout should support Escape dismissal');
  assert.match(compactSource, /menuRef\.current\?\.contains\(target\)/, 'clicking inside the portaled menu should not close it');
  assert.match(compactSource, /triggerRef\.current\?\.contains\(target\)/, 'clicking the trigger should not be treated as an outside click');
  assert.match(compactSource, /setIsOpen\(false\)/, 'outside interactions should close the compact route popout');
  assert.match(compactSource, /event\.key !== 'Escape'[\s\S]*event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)[\s\S]*triggerRef\.current\?\.focus\(\)/, 'Escape should close the menu and restore trigger focus');
  assert.equal((compactSource.match(/queueMicrotask\(\(\) => triggerRef\.current\?\.focus\(\)\)/g) ?? []).length, 3, 'cancel, save, and Escape should restore trigger focus');
});

test('ChatsPage places compact model route control before attachment and keeps explicit agent controls', () => {
  const source = readFileSync(new URL('../src/pages/chatsPage.mainComposer.tsx', import.meta.url), 'utf8');
  assert.match(source, /<CompactComposerModelMenu[\s\S]*<Button[\s\S]*title="Add attachment"/);
  assert.match(source, /!useCompactRouteMenu[\s\S]*<ComposerModelControls/);
});

test('ChatsPage shows compact model route for group/contact chats even without a bridge routing agent', () => {
  const source = readFileSync(new URL('../src/pages/chatsPage.mainComposer.tsx', import.meta.url), 'utf8');
  assert.match(source, /const useCompactRouteMenu = shouldUseCompactModelRouteMenu\(conversation\)/);
  assert.match(source, /\{useCompactRouteMenu \? \(/);
  assert.doesNotMatch(source, /useCompactRouteMenu && \(!collaborationRouting\.enabled \|\| collaborationRouting\.model\)/);
});
