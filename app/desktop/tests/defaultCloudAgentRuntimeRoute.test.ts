import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveDefaultCloudAgentRuntimeRoute } from '../src/app/useKordiDefaultCloudAgentRuntimeRoute';
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
    authChoice: 'profile-1',
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
    authChoice: 'profile-1',
    thinking: '',
  });
});
