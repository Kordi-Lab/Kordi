import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostedRouteAccounts } from '../src/features/chat/hostedComposerOptions';
import { CHATGPT_DEFAULT_MODEL, orderChatGptModels, withChatGptModelCatalog } from '../src/features/cloud/chatgptModelCatalog';
import { catalogModelThinkingLevels } from '../src/features/cloud/modelThinkingLevels';
import { loadPinnedOmpCatalog, refreshOmpCatalog } from '../src/kordi-app/auth/ompCatalog';

const pickerOrder = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

test('ChatGPT models list the newest first, keep unranked ids in order, and drop daybreak ids', () => {
  assert.deepEqual(
    orderChatGptModels(['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-daybreak-blue-latest', 'gpt-6.1-sol', 'gpt-5.4']),
    [...pickerOrder, 'gpt-5.5', 'gpt-5.4'],
  );
});

test('the pinned ChatGPT catalog offers GPT-6.1 Sol first and as its default', async () => {
  const catalog = await loadPinnedOmpCatalog();
  const codex = catalog.providers.find((entry) => entry.id === 'openai-codex');
  assert.ok(codex);
  assert.equal(codex.defaultModel, CHATGPT_DEFAULT_MODEL);
  assert.deepEqual(codex.models.slice(0, pickerOrder.length), pickerOrder);
  assert.ok(codex.models.every((model) => !model.includes('daybreak')));
  const openai = catalog.providers.find((entry) => entry.id === 'openai');
  assert.ok(openai?.models.every((model) => !model.includes('daybreak')));
  assert.equal(openai?.models[0], 'gpt-6.1-sol');
});

test('other providers keep their catalog order', () => {
  const entry = { id: 'anthropic', models: ['claude-b', 'claude-a'], defaultModel: 'claude-a' };
  assert.equal(withChatGptModelCatalog(entry), entry);
});

test('a hosted ChatGPT account lists the newest model first and never its stored daybreak model', async () => {
  const catalog = await loadPinnedOmpCatalog();
  const base = { authChoice: 'cloud-login:chatgpt', label: 'Work', provider: 'openai-codex', needsReconnect: false };
  const [stored] = hostedRouteAccounts([{ ...base, model: 'gpt-5.5' }], catalog.providers);
  assert.equal(stored.models[0], 'gpt-6.1-sol');
  assert.ok(stored.models.includes('gpt-5.5'));
  const [daybreak] = hostedRouteAccounts([{ ...base, model: 'gpt-daybreak-blue-latest' }], catalog.providers);
  assert.equal(daybreak.model, null);
  assert.ok(daybreak.models.every((model) => !model.includes('daybreak')));
});

test('the pinned catalog carries OMP thinking levels per model, across ChatGPT provider ids', async () => {
  const { providers } = await loadPinnedOmpCatalog();
  const full = ['low', 'medium', 'high', 'xhigh', 'max'];
  for (const provider of ['openai-codex', 'openai', 'codex']) {
    assert.deepEqual(catalogModelThinkingLevels(providers, provider, 'gpt-6-sol'), full, provider);
    assert.deepEqual(catalogModelThinkingLevels(providers, provider, 'gpt-6.1-sol'), full, provider);
  }
  assert.deepEqual(catalogModelThinkingLevels(providers, 'openai-codex', 'gpt-6-astra'), full);
  assert.deepEqual(catalogModelThinkingLevels(providers, 'openai-codex', 'gpt-5.6-sol'), full);
  assert.deepEqual(catalogModelThinkingLevels(providers, 'openai-codex', 'gpt-5.5'), ['low', 'medium', 'high', 'xhigh']);
  for (const model of ['claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-4-8']) {
    assert.deepEqual(catalogModelThinkingLevels(providers, 'anthropic', model), full, model);
  }
  assert.deepEqual(catalogModelThinkingLevels(providers, 'anthropic', 'claude-haiku-4-5'), ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(catalogModelThinkingLevels(providers, 'openai-codex', 'not-a-model'), null);
  assert.equal(catalogModelThinkingLevels(providers, 'unknown-provider', 'gpt-6-sol'), null);
  assert.equal(catalogModelThinkingLevels([], 'openai-codex', 'gpt-6-sol'), null);
});

test('a hosted catalog refresh keeps the pinned thinking levels', async () => {
  const pinned = await loadPinnedOmpCatalog();
  const refreshed = await refreshOmpCatalog(pinned, async () => ({
    providers: [{ id: 'openai-codex', models: ['gpt-6-sol'], modelThinking: { 'gpt-6-sol': 'p1' } as never }],
  }));
  assert.deepEqual(catalogModelThinkingLevels(refreshed.providers, 'openai-codex', 'gpt-6-sol'), ['low', 'medium', 'high', 'xhigh', 'max']);
});
