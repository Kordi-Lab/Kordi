import assert from 'node:assert/strict';
import { test } from 'node:test';

import { providerAutoSwitchTarget } from '../src/app/useKordiProviderAutoSwitch';
import type { DesktopAuthState } from '../src/kordi-app/types';

function authState(configured: string[], active?: string): DesktopAuthState {
  return {
    authPath: '/redacted/auth.json',
    hasAnyAuth: configured.length > 0,
    providers: ['openai', 'anthropic'].map((id) => ({
      id,
      label: id,
      statusSummary: configured.includes(id) ? 'Connected' : 'Not configured',
      loginHint: '',
      envVar: '',
      helpUrl: '',
      supportsOAuth: true,
      supportsApiKey: true,
      configured: configured.includes(id),
      options: configured.includes(id) ? [{
        value: `profile:${id}`,
        method: id === 'openai' ? 'API key' : 'OAuth',
        source: 'kordi auth.json',
        label: id,
        active: id === active,
      }] : [],
    })),
  };
}

test('provider removal switches to the remaining configured provider', () => {
  assert.equal(providerAutoSwitchTarget({
    activeLoginProviderId: 'openai',
    currentProviderId: 'openai-codex',
    desktopAuthState: authState(['anthropic'], 'anthropic'),
  }), 'anthropic');
});

test('provider removal does not treat stale model catalog entries as authentication', () => {
  assert.equal(providerAutoSwitchTarget({
    activeLoginProviderId: null,
    currentProviderId: 'anthropic',
    desktopAuthState: authState(['openai'], 'openai'),
  }), 'openai');
});

test('removing the last provider has no fallback target', () => {
  assert.equal(providerAutoSwitchTarget({
    activeLoginProviderId: null,
    currentProviderId: 'openai',
    desktopAuthState: authState([]),
  }), null);
});

test('an available current provider does not auto-switch', () => {
  assert.equal(providerAutoSwitchTarget({
    activeLoginProviderId: 'anthropic',
    currentProviderId: 'openai-codex',
    desktopAuthState: authState(['openai', 'anthropic'], 'anthropic'),
  }), null);
});

test('a session on a hosted account keeps its route although this Mac lacks the provider', () => {
  for (const authChoice of ['cloud-login:synthetic', 'cloud-api-key:synthetic', 'ios-codex:synthetic', 'ios-api-key:synthetic']) {
    assert.equal(providerAutoSwitchTarget({
      activeLoginProviderId: 'anthropic',
      currentProviderId: 'openai-codex',
      desktopAuthState: authState(['anthropic'], 'anthropic'),
      sessionRoutes: [{ model: 'openai-codex/gpt-5.6-sol', authProvider: 'openai-codex', authChoice }],
    }), null, authChoice);
  }
});

test('a session route on an equivalent configured provider does not auto-switch', () => {
  assert.equal(providerAutoSwitchTarget({
    activeLoginProviderId: 'anthropic',
    currentProviderId: 'stale-provider',
    desktopAuthState: authState(['openai', 'anthropic'], 'anthropic'),
    sessionRoutes: [null, { model: 'openai-codex/gpt-5.6-sol', authChoice: 'profile:openai' }],
  }), null);
});

test('a local session route on an unavailable provider still switches', () => {
  assert.equal(providerAutoSwitchTarget({
    activeLoginProviderId: 'anthropic',
    currentProviderId: 'openai-codex',
    desktopAuthState: authState(['anthropic'], 'anthropic'),
    sessionRoutes: [{ model: 'openai-codex/gpt-5.6-sol', authProvider: 'openai-codex', authChoice: 'profile:openai' }],
  }), 'anthropic');
});
