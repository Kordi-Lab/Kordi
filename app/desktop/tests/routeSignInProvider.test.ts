import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeWithSignInProvider } from '../src/features/cloud/routeSignInProvider';

const chatGpt = {
  providerId: 'openai-codex', providerLabel: 'ChatGPT', methodLabel: 'Saved account',
  value: 'cloud-login:work', label: 'Work', active: true,
};

test('a named sign-in restores its own provider within the same family', () => {
  const route = { model: 'openai-codex/gpt-6.1-sol', authProvider: 'openai', authChoice: 'cloud-login:work' };
  assert.deepEqual(routeWithSignInProvider(route, [chatGpt]), { ...route, authProvider: 'openai-codex' });
});

test('routes stay as recorded without a matching named sign-in', () => {
  const shared = { model: 'openai/gpt-6.1-sol', authProvider: 'openai', authChoice: 'local-active-oauth' };
  assert.equal(routeWithSignInProvider(shared, [{ ...chatGpt, value: 'local-active-oauth' }]), shared);
  const otherFamily = { model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic', authChoice: 'cloud-login:work' };
  assert.equal(routeWithSignInProvider(otherFamily, [chatGpt]), otherFamily);
  const unknown = { model: 'openai/gpt-6.1-sol', authProvider: 'openai', authChoice: 'cloud-login:other' };
  assert.equal(routeWithSignInProvider(unknown, [chatGpt]), unknown);
  assert.equal(routeWithSignInProvider(null, [chatGpt]), null);
});
