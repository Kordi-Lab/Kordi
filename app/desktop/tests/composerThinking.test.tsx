import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
    ComposerModelControls,
    composerThinkingLabel,
    fallbackComposerThinkingValue,
} from '../src/kordi-app/components';

test('composer defaults to medium thinking when the selected model supports effort levels', () => {
  assert.equal(fallbackComposerThinkingValue(['off', 'medium', 'high'], 'default'), 'medium');
  assert.equal(fallbackComposerThinkingValue(['off', 'low', 'medium', 'high', 'xhigh'], 'default'), 'medium');
});

test('composer shows default thinking for models without thinking effort controls', () => {
  assert.equal(fallbackComposerThinkingValue(['off'], 'default'), 'default');
});

test('composer labels max and falls back through the nearest high effort', () => {
  assert.equal(composerThinkingLabel('max'), 'Max');
  assert.equal(fallbackComposerThinkingValue(['off', 'high', 'xhigh'], 'max'), 'xhigh');
  assert.equal(fallbackComposerThinkingValue(['off', 'high'], 'max'), 'high');
});

test('composer model controls display medium instead of off for default selection on effort models', () => {
  const markup = renderToStaticMarkup(createElement(ComposerModelControls, {
    scope: 'chat',
    selection: { mode: 'My agent', model: 'openai/gpt-5.5', thinking: 'default' },
    openSelector: null,
    onToggleSelector: () => undefined,
    onSelectValue: () => undefined,
    authLabel: 'ChatGPT account',
    authOptions: [],
    onSelectAuthChoice: () => undefined,
    onSelectProviderChoice: () => undefined,
    providerOptions: [{ value: 'openai-codex::profile', providerId: 'openai-codex', label: 'ChatGPT account', active: true }],
    modelOptions: [{
      value: 'openai/gpt-5.5',
      label: 'gpt-5.5',
      provider: 'openai',
      providerLabel: 'OpenAI',
      thinkingLevels: ['off', 'medium', 'high'],
    }],
  }));

  assert.match(markup, />Medium</);
  assert.doesNotMatch(markup, />Off</);
});

test('composer model controls display default for no-effort models', () => {
  const markup = renderToStaticMarkup(createElement(ComposerModelControls, {
    scope: 'chat',
    selection: { mode: 'My agent', model: 'openai/gpt-4.1', thinking: 'default' },
    openSelector: null,
    onToggleSelector: () => undefined,
    onSelectValue: () => undefined,
    authLabel: 'OpenAI',
    authOptions: [],
    onSelectAuthChoice: () => undefined,
    onSelectProviderChoice: () => undefined,
    providerOptions: [{ value: 'openai::api-key', providerId: 'openai', label: 'OpenAI', active: true }],
    modelOptions: [{
      value: 'openai/gpt-4.1',
      label: 'gpt-4.1',
      provider: 'openai',
      providerLabel: 'OpenAI',
      thinkingLevels: ['off'],
    }],
  }));

  assert.match(markup, />Default</);
  assert.doesNotMatch(markup, />Off</);
});

test('composer model controls show the explicit no-provider state after removal', () => {
  const markup = renderToStaticMarkup(createElement(ComposerModelControls, {
    scope: 'chat',
    selection: { mode: 'My agent', model: 'openai/gpt-5.6-sol', thinking: 'medium' },
    openSelector: { scope: 'chat', type: 'model' },
    onToggleSelector: () => undefined,
    onSelectValue: () => undefined,
    authLabel: 'No auth',
    authOptions: [],
    onSelectAuthChoice: () => undefined,
    onSelectProviderChoice: () => undefined,
    providerOptions: [],
    modelOptions: [{
      value: 'openai/gpt-5.6-sol',
      label: 'gpt-5.6-sol',
      provider: 'openai',
      providerLabel: 'OpenAI',
      thinkingLevels: ['medium'],
    }],
  }));

  assert.match(markup, />No Provider</);
  assert.equal((markup.match(/>-<\/span>/g) ?? []).length, 2);
  assert.equal((markup.match(/disabled=""/g) ?? []).length, 2);
  assert.equal((markup.match(/lucide-chevron-down/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /app-composer-model-menu-layer/);
  assert.doesNotMatch(markup, />OpenAI</);
});
