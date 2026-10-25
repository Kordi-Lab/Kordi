import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composerRouteDecision } from '../src/features/chat/useHostedComposerRouting';
import { routeWithAccountNamespace } from '../src/features/cloud/routeAccountNamespace';
import {
  modelInAccountNamespace,
  resolveComposerRoutePick,
  type ComposerModelOption,
  type ComposerProviderOption,
} from '../src/kordi-app/components/composerModelSelection';

const modelOptions: ComposerModelOption[] = [
  { value: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', thinkingLevels: ['low', 'medium', 'high'] },
  { value: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai-codex', thinkingLevels: ['low', 'medium', 'high'] },
];
const codexAccount: ComposerProviderOption = {
  value: 'openai-codex::cloud-login:work', providerId: 'openai-codex', label: 'Work', hosted: true,
};
const apiKeyAccount: ComposerProviderOption = { value: 'openai::profile:key', providerId: 'openai', label: 'Key', active: true };

test('an account pick moves an OpenAI model into the ChatGPT account namespace', () => {
  const pick = resolveComposerRoutePick({
    selection: { model: 'openai/gpt-6.1-sol', thinking: 'medium', authProvider: 'openai', authChoice: 'profile:key' },
    providerOptions: [apiKeyAccount, codexAccount],
    modelOptions,
    pick: { type: 'provider', option: codexAccount },
  });
  assert.equal(pick?.providerOption?.value, codexAccount.value);
  assert.equal(pick?.model, 'openai-codex/gpt-6.1-sol');
  assert.equal(pick?.thinking, 'medium');
});

test('an account pick keeps the model when the account namespace has no such model', () => {
  const pick = resolveComposerRoutePick({
    selection: { model: 'openai/gpt-6.1-sol', thinking: 'medium' },
    providerOptions: [apiKeyAccount, codexAccount],
    modelOptions: modelOptions.slice(0, 1),
    pick: { type: 'provider', option: codexAccount },
  });
  assert.equal(pick?.model, 'openai/gpt-6.1-sol');
});

test('a pinned account choice rewrites the model namespace within the provider family', () => {
  const context = { accounts: [], currentRoute: null, pinLocalAccount: true };
  assert.deepEqual(
    composerRouteDecision({ model: 'openai/gpt-6.1-sol', thinking: 'high', choice: { providerId: 'openai-codex', authChoice: 'profile:work' } }, context),
    { route: { model: 'openai-codex/gpt-6.1-sol', authProvider: 'openai-codex', authChoice: 'profile:work', thinking: 'high' }, leavesCloud: false },
  );
  assert.equal(
    composerRouteDecision({ model: 'anthropic/claude-fable-5', thinking: 'high', choice: { providerId: 'openai-codex', authChoice: 'profile:work' } }, context)?.route.model,
    'anthropic/claude-fable-5',
    'another provider family is left alone',
  );
});

test('a model in another namespace of the family moves into the account namespace', () => {
  assert.equal(modelInAccountNamespace('openai/gpt-6.1-sol', 'openai-codex'), 'openai-codex/gpt-6.1-sol');
  assert.equal(modelInAccountNamespace('openai-codex/gpt-6.1-sol', 'openai'), 'openai/gpt-6.1-sol');
  assert.equal(modelInAccountNamespace('openai/gpt-6.1-sol', 'openai-codex', modelOptions), 'openai-codex/gpt-6.1-sol');
  assert.equal(modelInAccountNamespace('openai/gpt-6.1-sol', 'openai-codex', modelOptions.slice(0, 1)), 'openai/gpt-6.1-sol', 'not in the catalog');
  assert.equal(modelInAccountNamespace('anthropic/claude-fable-5', 'openai-codex'), 'anthropic/claude-fable-5', 'another family');
  assert.equal(modelInAccountNamespace('gpt-6.1-sol', 'openai-codex'), 'gpt-6.1-sol', 'no namespace');
  assert.equal(modelInAccountNamespace('openai/gpt-6.1-sol', null), 'openai/gpt-6.1-sol', 'no account');
});

test('a model change on a pinned account keeps the model in the account namespace', () => {
  const currentRoute = { model: 'openai-codex/gpt-6-sol', authProvider: 'openai-codex', authChoice: 'profile:work', thinking: 'high' };
  assert.deepEqual(
    composerRouteDecision({ model: 'openai/gpt-6.1-sol', thinking: 'medium' }, { accounts: [], currentRoute, pinLocalAccount: true }),
    { route: { ...currentRoute, model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' }, leavesCloud: false },
  );
  const listed = (models: ComposerModelOption[]) => composerRouteDecision(
    { model: 'openai/gpt-6.1-sol', thinking: 'medium' }, { accounts: [], currentRoute, pinLocalAccount: true, modelOptions: models },
  )?.route.model;
  assert.equal(listed(modelOptions), 'openai-codex/gpt-6.1-sol');
  assert.equal(listed(modelOptions.slice(0, 1)), 'openai/gpt-6.1-sol', 'the chat model list has no such model');
});

test('a stored route runs the account namespace model when the catalog offers it', () => {
  const stored = { model: 'openai/gpt-6.1-sol', authProvider: 'openai-codex', authChoice: 'cloud-login:work', thinking: 'medium' };
  assert.deepEqual(routeWithAccountNamespace(stored, modelOptions), { ...stored, model: 'openai-codex/gpt-6.1-sol' });
});

test('a stored route stays as it is when namespaces match, families differ, or the option is absent', () => {
  const matching = { model: 'openai-codex/gpt-6.1-sol', authProvider: 'openai-codex', authChoice: 'cloud-login:work' };
  assert.equal(routeWithAccountNamespace(matching, modelOptions), matching);
  const otherFamily = { model: 'anthropic/gpt-6.1-sol', authProvider: 'openai-codex', authChoice: 'cloud-login:work' };
  assert.equal(routeWithAccountNamespace(otherFamily, [...modelOptions, { value: 'openai-codex/gpt-6.1-sol' }]), otherFamily);
  const absent = { model: 'openai/gpt-6.1-sol', authProvider: 'openai-codex', authChoice: 'cloud-login:work' };
  assert.equal(routeWithAccountNamespace(absent, modelOptions.slice(0, 1)), absent);
  const noAccount = { model: 'openai/gpt-6.1-sol' };
  assert.equal(routeWithAccountNamespace(noAccount, modelOptions), noAccount);
  assert.equal(routeWithAccountNamespace(null, modelOptions), null);
});
