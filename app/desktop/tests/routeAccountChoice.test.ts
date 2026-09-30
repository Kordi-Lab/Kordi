import assert from 'node:assert/strict';
import { test } from 'node:test';

import { portableCloudAgentAuthChoice } from '../src/app/useKordiDefaultCloudAgentRuntimeRoute';
import { resolveCloudAgentRuntimeRouteChange } from '../src/features/cloud/cloudAgentRuntimeRouteChange';
import {
  ACCOUNT_UNAVAILABLE_LABEL,
  isAccountAuthChoice,
  publishableAccountLabel,
} from '../src/features/cloud/routeAccountChoice';
import { isRouteAccountUnavailable, resolveComposerModelSelection } from '../src/kordi-app/components/composerModelSelection';

const accountChoices = [
  'profile:work',
  'ios-codex:4b8f2c1e',
  'ios-api-key:9d2a7c3f',
  'cloud-api-key:1f4e8a90',
  'cloud-login:7c1d3b52',
];

test('every account choice prefix is portable unchanged', () => {
  for (const choice of accountChoices) {
    assert.equal(isAccountAuthChoice(choice), true, choice);
    assert.equal(portableCloudAgentAuthChoice(choice, 'OAuth'), choice);
    assert.equal(portableCloudAgentAuthChoice(choice, 'API key'), choice);
    assert.equal(portableCloudAgentAuthChoice(choice, null), choice);
  }
  for (const alias of ['local-active-oauth', 'local-active-api-key', 'ios-api-key']) {
    assert.equal(portableCloudAgentAuthChoice(alias, null), alias);
  }
  assert.equal(isAccountAuthChoice('profile:'), false);
  assert.equal(portableCloudAgentAuthChoice('default', 'OAuth'), 'local-active-oauth');
  assert.equal(portableCloudAgentAuthChoice('default', null), null);
});

test('a route naming a missing account keeps it instead of substituting a local one', () => {
  const localRoute = {
    model: 'openai/gpt-5.5', authProvider: 'openai-codex', authChoice: 'profile:personal', thinking: 'medium',
  };
  const authOptions = [{
    providerId: 'openai-codex', providerLabel: 'ChatGPT', methodLabel: 'OAuth', value: 'profile:personal', label: 'Personal', active: true,
  }];
  for (const choice of accountChoices) {
    const route = resolveCloudAgentRuntimeRouteChange({
      authOptions,
      input: { sessionId: 'session:self-agent:work', model: 'openai/gpt-5.5', authProvider: 'openai-codex', authChoice: choice, thinking: 'high' },
      resolvedLocalRoute: localRoute,
    });
    assert.deepEqual(route, { model: 'openai/gpt-5.5', authProvider: 'openai-codex', authChoice: choice, thinking: 'high' }, choice);
  }
});

test('the composer shows a removed account as unavailable and never another account', () => {
  const providerOptions = [
    { value: 'openai-codex::profile:personal', providerId: 'openai-codex', label: 'ChatGPT', detail: 'Personal', active: true },
  ];
  const selection = { model: 'openai/gpt-5.5', authProvider: 'openai-codex', authChoice: 'profile:work' };
  const resolved = resolveComposerModelSelection({ selection, providerOptions, modelOptions: [] });
  assert.equal(resolved.missingAccount, true);
  assert.equal(resolved.selectedProviderOption?.label, ACCOUNT_UNAVAILABLE_LABEL);
  assert.equal(resolved.selectedProviderOption?.unavailable, true);
  assert.equal(resolved.selectedProviderOption?.value, 'openai-codex::profile:work');
  assert.equal(isRouteAccountUnavailable(selection, providerOptions), true);

  assert.equal(isRouteAccountUnavailable({ ...selection, authChoice: 'profile:personal' }, providerOptions), false);
  // Device-active aliases follow whichever account is active, so they are never "missing".
  assert.equal(isRouteAccountUnavailable({ ...selection, authChoice: 'local-active-oauth' }, providerOptions), false);
});

test('a legacy OpenAI route resolves its exact saved ChatGPT account without changing account choice', () => {
  const saved = { value: 'openai-codex::cloud-login:saved', providerId: 'openai-codex', label: 'ChatGPT', selectionLabel: 'ChatGPT • Saved', active: false };
  const other = { value: 'openai-codex::cloud-login:other', providerId: 'openai-codex', label: 'Other account', active: true };
  const selection = { model: 'openai/gpt-5.6-sol', authProvider: 'openai', authChoice: 'cloud-login:saved' };
  const resolved = resolveComposerModelSelection({ selection, providerOptions: [other, saved], modelOptions: [] });
  assert.equal(resolved.selectedProviderOption, saved);
  assert.equal(resolved.missingAccount, false);
  assert.equal(isRouteAccountUnavailable(selection, [other, saved]), false);
  assert.equal(isRouteAccountUnavailable({ ...selection, authChoice: 'cloud-login:removed' }, [other, saved]), true);

  const exact = { value: 'openai::cloud-login:saved', providerId: 'openai', label: 'OpenAI API key', active: false };
  assert.equal(resolveComposerModelSelection({ selection, providerOptions: [saved, exact], modelOptions: [] }).selectedProviderOption, exact);
  const duplicate = { ...saved, label: 'Duplicate alias' };
  assert.equal(resolveComposerModelSelection({ selection, providerOptions: [saved, duplicate], modelOptions: [] }).missingAccount, true);
});

test('account labels are trimmed to 80 characters before publishing', () => {
  assert.equal(publishableAccountLabel('  Work  '), 'Work');
  assert.equal(publishableAccountLabel('x'.repeat(120))?.length, 80);
  assert.equal([...(publishableAccountLabel('é'.repeat(90)) ?? '')].length, 80);
  assert.equal(publishableAccountLabel(null), null);
});
