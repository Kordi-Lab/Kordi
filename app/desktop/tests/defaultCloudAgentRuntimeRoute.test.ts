import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  portableCloudAgentAuthChoice,
  resolveDefaultCloudAgentRuntimeRoute,
} from '../src/app/useKordiDefaultCloudAgentRuntimeRoute';
import type { DesktopAuthProvider, DesktopAuthState } from '../src/kordi-app/types';

function openAiProvider(): DesktopAuthProvider {
  return {
    id: 'openai',
    label: 'OpenAI',
    statusSummary: 'configured',
    loginHint: 'Use an API key.',
    envVar: 'OPENAI_API_KEY',
    helpUrl: 'https://platform.openai.com/api-keys',
    supportsOAuth: false,
    supportsApiKey: true,
    configured: true,
    authority: null,
    baseUrl: null,
    preferredModel: null,
    options: [{
      value: 'profile-1',
      profileId: 'profile-1',
      method: 'API key',
      source: 'kordi auth.json',
      label: 'Saved key',
      active: true,
    }],
  };
}

function authState(providers: DesktopAuthProvider[]): DesktopAuthState {
  return {
    authPath: '/tmp/kordi-auth.json',
    hasAnyAuth: providers.length > 0,
    providers,
  };
}

const activeOpenAiAuthOption = {
  providerId: 'openai',
  providerLabel: 'OpenAI',
  methodLabel: 'OpenAI API key',
  value: 'profile-1',
  label: 'Saved key',
  active: true,
};

test('portable cloud routes keep explicit profile selectors', () => {
  assert.equal(portableCloudAgentAuthChoice('profile:chatgpt', 'OAuth'), 'profile:chatgpt');
  assert.equal(portableCloudAgentAuthChoice('profile:api-key', 'OpenAI API key'), 'profile:api-key');
});

test('default cloud agent route stays disabled outside the native shell', () => {
  assert.equal(resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai',
    authOptions: [activeOpenAiAuthOption],
    chatModelOptions: [{ value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: false,
    preferredModelValueForProvider: () => 'openai/gpt-5.6-sol',
    resolveComposerProviderId: () => 'openai',
    selectedModel: 'openai/gpt-5.6-sol',
    selectedThinking: 'medium',
  }), null);
});

test('default cloud agent route preserves a configured selected model and auth choice', () => {
  assert.deepEqual(resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai',
    authOptions: [activeOpenAiAuthOption],
    chatModelOptions: [{ value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: true,
    preferredModelValueForProvider: () => null,
    resolveComposerProviderId: () => 'openai',
    selectedModel: 'openai/gpt-5.6-sol',
    selectedThinking: 'medium',
  }), {
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai',
    authChoice: 'local-active-api-key',
    thinking: 'medium',
  });
});

test('default cloud agent route falls back to the active configured provider', () => {
  assert.deepEqual(resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai',
    authOptions: [activeOpenAiAuthOption],
    chatModelOptions: [],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: true,
    preferredModelValueForProvider: (providerId) => (
      providerId === 'openai' ? 'openai/gpt-5.6-sol' : null
    ),
    resolveComposerProviderId: () => '',
    selectedModel: '',
    selectedThinking: '',
  }), {
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai',
    authChoice: 'local-active-api-key',
    thinking: '',
  });
});

test('a new session without a provider on this Mac starts on a usable Kordi Cloud account', async () => {
  const { publishHostedProviderSnapshots } = await import('../src/features/cloud/hostedAccounts');
  const args = {
    activeLoginProviderId: null,
    authOptions: [],
    chatModelOptions: [],
    desktopAuthState: authState([]),
    isNativeShell: true,
    preferredModelValueForProvider: () => null,
    resolveComposerProviderId: () => 'anthropic',
    selectedModel: 'anthropic/claude-fable-5',
    selectedThinking: 'medium',
  };
  // The Kordi Cloud list has not arrived: an account may still exist, so no route yet.
  assert.equal(resolveDefaultCloudAgentRuntimeRoute(args), null);
  publishHostedProviderSnapshots([{ snapshotId: 'synthetic-work', provider: 'openai-codex', authChoice: 'cloud-login:work',
    label: 'Work', modelHint: 'gpt-6-sol', createdAt: '2026-01-01T00:00:00Z', revokedAt: null }]);
  try {
    assert.deepEqual(resolveDefaultCloudAgentRuntimeRoute(args),
      { model: 'openai-codex/gpt-6-sol', authProvider: 'openai-codex', authChoice: 'cloud-login:work', thinking: 'medium' });
    assert.equal(resolveDefaultCloudAgentRuntimeRoute({ ...args, desktopAuthState: null }), null, 'Not while this Mac\'s accounts load');
  } finally {
    publishHostedProviderSnapshots([]);
  }
  assert.equal(resolveDefaultCloudAgentRuntimeRoute(args), null, 'No usable account anywhere keeps the no-provider state');
});

test('default cloud agent route moves the model into the chosen account namespace', () => {
  assert.deepEqual(resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai',
    authOptions: [{
      providerId: 'openai-codex', providerLabel: 'OpenAI', methodLabel: 'Saved account',
      value: 'cloud-login:x', label: 'Work', active: false,
    }],
    chatModelOptions: [
      { value: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { value: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    ],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: true,
    preferredModelValueForProvider: () => null,
    resolveComposerProviderId: () => 'openai',
    selectedModel: 'openai/gpt-6.1-sol',
    selectedThinking: 'medium',
  }), {
    model: 'openai-codex/gpt-6.1-sol',
    authProvider: 'openai-codex',
    authChoice: 'cloud-login:x',
    thinking: 'medium',
  });
});

test('with an OpenAI key and a ChatGPT sign-in both active, a ChatGPT model keeps the sign-in', () => {
  const args = {
    activeLoginProviderId: 'openai',
    authOptions: [
      { providerId: 'openai', providerLabel: 'OpenAI', methodLabel: 'API key', value: 'profile:key', label: 'Key', active: true },
      { providerId: 'openai-codex', providerLabel: 'OpenAI', methodLabel: 'OAuth', value: 'profile:chatgpt', label: 'ChatGPT', active: true },
    ],
    chatModelOptions: [
      { value: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { value: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    ],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: true,
    preferredModelValueForProvider: () => null,
    resolveComposerProviderId: () => 'openai',
    selectedThinking: 'medium',
  };
  const chatgpt = resolveDefaultCloudAgentRuntimeRoute({ ...args, selectedModel: 'openai-codex/gpt-6.1-sol' });
  assert.equal(chatgpt?.model, 'openai-codex/gpt-6.1-sol');
  assert.equal(chatgpt?.authProvider, 'openai-codex');
  assert.equal(chatgpt?.authChoice, 'profile:chatgpt');
  const key = resolveDefaultCloudAgentRuntimeRoute({ ...args, selectedModel: 'openai/gpt-6.1-sol' });
  assert.equal(key?.model, 'openai/gpt-6.1-sol');
  assert.equal(key?.authChoice, 'profile:key');
});
