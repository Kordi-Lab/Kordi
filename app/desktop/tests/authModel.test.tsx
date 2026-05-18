import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  authStateHasChatReadyProvider,
  authStateSatisfiesStartupGate,
  buildAuthDisplayProviders,
  providerListSubtitle,
} from '../src/kordi-app/auth/model';
import type { DesktopAuthProvider, DesktopAuthState } from '../src/kordi-app/types';

function authProvider(overrides: Partial<DesktopAuthProvider> = {}): DesktopAuthProvider {
  return {
    id: 'openai',
    label: 'OpenAI',
    statusSummary: '[not authenticated]',
    loginHint: 'Use an API key.',
    envVar: 'OPENAI_API_KEY',
    helpUrl: 'https://platform.openai.com/api-keys',
    supportsOAuth: false,
    supportsApiKey: true,
    configured: false,
    authority: null,
    baseUrl: null,
    preferredModel: null,
    options: [],
    ...overrides,
  };
}

function authOption(method: string) {
  return {
    value: 'default',
    method,
    source: 'kordi auth.json',
    label: 'Default',
    active: true,
  };
}

function authState(overrides: Partial<DesktopAuthState> = {}): DesktopAuthState {
  return {
    authPath: '/tmp/kordi-auth.json',
    hasAnyAuth: false,
    providers: [],
    ...overrides,
  };
}

test('buildAuthDisplayProviders treats a saved LM Studio preferred model as configured', () => {
  const providers = buildAuthDisplayProviders(authState({
    providers: [authProvider({
      id: 'lm-studio',
      label: 'LM Studio',
      statusSummary: '[local endpoint; no API key required]',
      loginHint: 'Run LM Studio locally.',
      envVar: 'LM_STUDIO_API_KEY',
      helpUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
      supportsApiKey: true,
      configured: false,
      baseUrl: 'http://localhost:1234/v1',
      preferredModel: 'lm-studio/google/gemma-4-e4b',
    })],
  }));

  const lmStudio = providers.find((provider) => provider.id === 'lm-studio');

  assert.equal(lmStudio?.configured, true);
  assert.equal(lmStudio?.preferredModel, 'lm-studio/google/gemma-4-e4b');
  assert.equal(lmStudio ? providerListSubtitle(lmStudio) : null, 'Saved local model • google/gemma-4-e4b');
});

test('authStateHasChatReadyProvider accepts discovered local runtime models without saved cloud auth', () => {
  const unauthenticatedState = authState({ hasAnyAuth: false });

  assert.equal(authStateHasChatReadyProvider(unauthenticatedState, [{ provider: 'lm-studio' }]), true);
  assert.equal(authStateHasChatReadyProvider(unauthenticatedState, [{ provider: 'openai' }]), false);
  assert.equal(authStateHasChatReadyProvider(authState({ hasAnyAuth: true }), []), false);
});

test('authStateHasChatReadyProvider requires a configured provider with available models', () => {
  assert.equal(authStateHasChatReadyProvider(authState({
    hasAnyAuth: true,
    providers: [authProvider({ configured: true })],
  }), []), false);
  assert.equal(authStateHasChatReadyProvider(authState({
    hasAnyAuth: true,
    providers: [authProvider({ configured: true, options: [authOption('API key')] })],
  }), [{ provider: 'openai' }]), true);
  assert.equal(authStateHasChatReadyProvider(authState({
    hasAnyAuth: true,
    providers: [authProvider({ id: 'openai-codex', configured: true, options: [authOption('OAuth')] })],
  }), [{ provider: 'openai' }]), true);
});

test('authStateSatisfiesStartupGate ignores unsaved discovered local runtime models', () => {
  assert.equal(authStateSatisfiesStartupGate(authState({ hasAnyAuth: false })), false);
  assert.equal(authStateSatisfiesStartupGate(authState({ hasAnyAuth: true })), true);
  assert.equal(authStateSatisfiesStartupGate(authState({
    hasAnyAuth: false,
    providers: [authProvider({
      id: 'lm-studio',
      label: 'LM Studio',
      envVar: 'LM_STUDIO_API_KEY',
      helpUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
      configured: false,
      baseUrl: 'http://localhost:1234/v1',
      preferredModel: 'lm-studio/google/gemma-4-e4b',
    })],
  })), true);
});
