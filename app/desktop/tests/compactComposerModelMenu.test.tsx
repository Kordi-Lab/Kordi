import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
  assert.match(markup, /bg-\[rgba\(43,43,46,0\.82\)\]/);
  assert.match(markup, /backdrop-blur-2xl/);
  assert.match(markup, /bg-white\/8/);
  assert.match(markup, /bg-slate-200/);
  assert.doesNotMatch(markup, /data-compact-model-trigger="bare"[\s\S]{0,240}rounded-full/);
  assert.doesNotMatch(markup, /data-compact-model-trigger="bare"[\s\S]{0,260}bg-emerald/);
  assert.doesNotMatch(markup, /text-sky|bg-sky|ring-sky|hover:text-sky|hover:bg-sky/);
  assert.equal((markup.match(/<details/g) ?? []).length, 3);
  assert.doesNotMatch(markup, /<details open=""/);
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

test('compact model route menu is scoped to group and human contact chats', () => {
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'person', directness: 'direct person chat' })), true);
  assert.equal(shouldUseCompactModelRouteMenu(conversation({ type: 'person', directness: 'group chat', id: 'session:group:one' })), true);
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
