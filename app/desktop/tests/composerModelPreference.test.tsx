import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as composerViewModel from '../src/features/chat/useComposerViewModel';

test('OpenAI auth routes prefer the shared GPT-5.6 Sol runtime default', () => {
  const preferredModel = (
    composerViewModel as typeof composerViewModel & {
      preferredModelValueForProviderFromOptions?: (
        providerId: string,
        modelOptions: Array<{ value: string; label: string; provider?: string | null }>,
        authProviders: [],
        preferredRuntimeRoute: { provider: string; model: string },
      ) => string | null;
    }
  ).preferredModelValueForProviderFromOptions;

  assert.equal(typeof preferredModel, 'function');
  if (!preferredModel) return;

  const modelOptions = [
    { value: 'openai/gpt-5.6-luna', label: 'gpt-5.6-luna', provider: 'openai' },
    { value: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol', provider: 'openai' },
    { value: 'openai/gpt-5.5', label: 'gpt-5.5', provider: 'openai' },
    { value: 'openai/gpt-5.4', label: 'gpt-5.4', provider: 'openai' },
  ];

  const preferredRuntimeRoute = { provider: 'openai', model: 'gpt-5.6-sol' };
  assert.equal(preferredModel('openai-codex', modelOptions, [], preferredRuntimeRoute), 'openai/gpt-5.6-sol');
  assert.equal(preferredModel('openai', modelOptions, [], preferredRuntimeRoute), 'openai/gpt-5.6-sol');
});

test('an explicit root runtime model matches the exact model id before fuzzy fallbacks', () => {
  const modelOptions = [
    { value: 'openai/gpt-5.4-mini', label: 'gpt-5.4-mini', provider: 'openai' },
    { value: 'openai/gpt-5.4', label: 'gpt-5.4', provider: 'openai' },
    { value: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol', provider: 'openai' },
  ];

  assert.equal(
    composerViewModel.preferredModelValueForProviderFromOptions(
      'openai',
      modelOptions,
      [],
      { provider: 'openai', model: 'gpt-5.4' },
    ),
    'openai/gpt-5.4',
  );
});
