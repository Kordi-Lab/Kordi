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
    bridges: ['cloud'],
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
  assert.match(markup, /app-compact-model-menu-save/);
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
  assert.match(markup, />Agent Model</);
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

  assert.match(css, /\.app-compact-model-menu\s*{[\s\S]*background:\s*var\(--app-compact-model-menu-bg\);/);
  assert.match(css, /\.app-compact-model-menu-save\s*{[\s\S]*background:\s*var\(--app-compact-model-menu-save-bg\);/);
  assert.match(css, /\.app-compact-model-menu details\[open\] \.app-compact-model-menu-chevron\s*{[\s\S]*transform:\s*rotate\(180deg\);/);
  assert.match(css, /\.bridge-app\.theme-light \.app-compact-model-menu\s*{[\s\S]*--app-compact-model-menu-bg:\s*rgba\(255, 255, 255, 0\.72\);/);
  assert.match(css, /\.bridge-app\.theme-light \.app-compact-model-menu\s*{[\s\S]*--app-compact-model-menu-save-bg:\s*rgb\(15 23 42\);/);
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

test('ChatsPage places compact model route control before attachment and keeps explicit agent controls', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /<CompactComposerModelMenu[\s\S]*<Button[\s\S]*title="Add attachment"/);
  assert.match(source, /!shouldUseCompactModelRouteMenu\(activeConv\)[\s\S]*<ComposerModelControls/);
});

test('ChatsPage shows compact model route for group/contact chats even without a bridge routing agent', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /\{shouldUseCompactModelRouteMenu\(activeConv\) \? \(/);
  assert.doesNotMatch(source, /shouldUseCompactModelRouteMenu\(activeConv\) && \(!activeConversationIsBridge \|\| selectedBridgeRoutingAgent\)/);
});
