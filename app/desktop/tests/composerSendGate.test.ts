import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composerSendGate, ROUTE_ACCOUNT_UNAVAILABLE_NOTICE } from '../src/features/chat/composerSendGate';
import type { ComposerModelSelection, ComposerProviderOption } from '../src/kordi-app/components/composerModelSelection';

const providerOptions: ComposerProviderOption[] = [
  { value: 'openai-codex::cloud-login:work', providerId: 'openai-codex', label: 'Work', hosted: true },
];
const removedRoute: ComposerModelSelection = {
  mode: 'My agent', model: 'openai-codex/gpt-6-sol', thinking: 'medium', authProvider: 'openai-codex', authChoice: 'cloud-login:removed',
};
const presentRoute: ComposerModelSelection = { ...removedRoute, authChoice: 'cloud-login:work' };
const base = { canConfigureModelRoute: true, selection: removedRoute, providerOptions, accountListsLoaded: true };

test('the notice names the unavailable account', () => {
  assert.equal(ROUTE_ACCOUNT_UNAVAILABLE_NOTICE, 'Account unavailable. Choose another account to continue.');
});

test('a people chat sends even when the agent route account is unavailable', () => {
  assert.deepEqual(composerSendGate({ ...base, paneKind: 'human' }), { blocked: false, notice: null });
});

test('a chat without a pane kind never blocks', () => {
  assert.deepEqual(composerSendGate({ ...base, paneKind: null }), { blocked: false, notice: null });
});

test('an agent chat with an unavailable route account blocks with a notice', () => {
  assert.deepEqual(composerSendGate({ ...base, paneKind: 'agent' }), { blocked: true, notice: ROUTE_ACCOUNT_UNAVAILABLE_NOTICE });
});

test('an agent chat does not block while the account lists are loading', () => {
  assert.deepEqual(
    composerSendGate({ ...base, paneKind: 'agent', accountListsLoaded: false }),
    { blocked: false, notice: null },
  );
});

test('an agent chat whose route account is listed sends', () => {
  assert.deepEqual(
    composerSendGate({ ...base, paneKind: 'agent', selection: presentRoute }),
    { blocked: false, notice: null },
  );
});

test('a chat that cannot configure a route never blocks', () => {
  assert.deepEqual(
    composerSendGate({ ...base, paneKind: 'agent', canConfigureModelRoute: false }),
    { blocked: false, notice: null },
  );
});
