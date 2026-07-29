import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeComposerProviderId,
  resolveComposerModelSelection,
  type ComposerModelOption,
  type ComposerProviderOption,
} from '../src/kordi-app/components/composerModelSelection';

const providerOptions: ComposerProviderOption[] = [
  {
    value: 'openai::team',
    providerId: 'openai',
    label: 'OpenAI team',
    active: false,
  },
  {
    value: 'openai::personal',
    providerId: 'openai',
    label: 'OpenAI personal',
    active: true,
  },
  {
    value: 'anthropic::subscription',
    providerId: 'anthropic',
    label: 'Claude subscription',
    active: true,
  },
];

const modelOptions: ComposerModelOption[] = [
  {
    value: 'openai/gpt-5.6',
    label: 'GPT-5.6',
    provider: 'openai',
  },
  {
    value: 'anthropic/claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'anthropic',
  },
];

test('model metadata resolves the provider and its active auth option', () => {
  const resolved = resolveComposerModelSelection({
    selection: { model: 'openai/gpt-5.6' },
    providerOptions,
    modelOptions,
  });

  assert.equal(resolved.selectedModelOption?.label, 'GPT-5.6');
  assert.equal(resolved.selectedProviderValue, 'openai');
  assert.equal(resolved.selectedProviderOption?.value, 'openai::personal');
  assert.equal(resolved.fallbackModelLabel, 'gpt-5.6');
});

test('explicit auth selection wins over the active provider default', () => {
  const resolved = resolveComposerModelSelection({
    selection: {
      model: 'openai/gpt-5.6',
      authProvider: 'openai',
      authChoice: 'team',
    },
    providerOptions,
    modelOptions,
  });

  assert.equal(resolved.selectedProviderOption?.value, 'openai::team');
});

test('known provider prefixes resolve models missing from the catalog', () => {
  const resolved = resolveComposerModelSelection({
    selection: { model: 'anthropic/claude-future' },
    providerOptions,
    modelOptions,
  });

  assert.equal(resolved.selectedModelOption, undefined);
  assert.equal(resolved.selectedProviderValue, 'anthropic');
  assert.equal(resolved.selectedProviderOption?.value, 'anthropic::subscription');
  assert.equal(resolved.fallbackModelLabel, 'claude-future');
});

test('unknown model prefixes are not treated as providers', () => {
  const resolved = resolveComposerModelSelection({
    selection: { model: 'custom/model' },
    providerOptions,
    modelOptions,
  });

  assert.equal(resolved.selectedProviderValue, '');
  assert.equal(resolved.selectedProviderOption, null);
  assert.equal(resolved.fallbackModelLabel, 'model');
});

test('OpenAI Codex provider aliases normalize to the OpenAI route', () => {
  assert.equal(normalizeComposerProviderId(' OpenAI-Codex '), 'openai');

  const resolved = resolveComposerModelSelection({
    selection: { model: 'openai-codex/gpt-5.6-codex' },
    providerOptions,
    modelOptions,
  });

  assert.equal(resolved.selectedProviderValue, 'openai');
  assert.equal(resolved.selectedProviderOption?.value, 'openai::personal');
});
