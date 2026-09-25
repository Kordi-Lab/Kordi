import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addMethodsSummary, buildAddMethods } from '../src/kordi-app/auth/authAddMethods';
import { buildOmpDisplayProviders, loadPinnedOmpCatalog, ompLoginMethods } from '../src/kordi-app/auth/ompCatalog';
import {
  hostedLoginKind,
  loginMethodFallbackDescriptions,
  loginMethodTitles,
  loginMethodVerbs,
  methodRowTitle,
  providerListDescription,
  providerShortName,
  splitProviderName,
} from '../src/kordi-app/auth/providerCopy';
import type { DesktopAuthProvider } from '../src/kordi-app/types';

function localProvider(id: string, label: string): DesktopAuthProvider {
  return {
    id, label, statusSummary: '', loginHint: '', envVar: '', helpUrl: '',
    supportsOAuth: true, supportsApiKey: true, configured: false, options: [],
  };
}

// The pinned catalog is its own chunk; load it once for every case.
const pinnedOmpCatalog = await loadPinnedOmpCatalog();
const { providers } = buildOmpDisplayProviders(
  { authPath: '', hasAnyAuth: false, providers: [localProvider('openai-codex', 'ChatGPT'), localProvider('openai', 'OpenAI'), localProvider('anthropic', 'Claude')] },
  [],
  pinnedOmpCatalog.providers,
);
const display = (id: string) => {
  const provider = providers.find((item) => item.id === id);
  assert.ok(provider, `${id} is missing`);
  return provider;
};

test('short names drop the trailing qualifier and plan tiers', () => {
  assert.deepEqual(splitProviderName('Antigravity (Gemini 3, Claude, GPT-OSS)'), { short: 'Antigravity', qualifier: 'Gemini 3, Claude, GPT-OSS' });
  assert.equal(providerShortName('Anthropic (Claude Pro/Max)'), 'Anthropic');
  assert.deepEqual(splitProviderName('ChatGPT Plus/Pro (Codex Subscription)'), { short: 'ChatGPT', qualifier: 'Plus/Pro, Codex Subscription' });
  assert.equal(providerShortName('ChatGPT Plus/Pro (Codex, headless/device)'), 'ChatGPT');
  assert.deepEqual(splitProviderName('Google Gemini'), { short: 'Google Gemini', qualifier: null });
  assert.equal(providerShortName('Z.AI (GLM Coding Plan)'), 'Z.AI');
});

test('method rows are named by how you connect, never by the provider', () => {
  const kinds = new Map(pinnedOmpCatalog.providers.map((entry) => [entry.id, entry.login]));
  const hosted = (id: string, mode?: 'device') => hostedLoginKind({ providerId: id, mode, login: kinds.get(id)!, displayName: id });
  assert.equal(hosted('google-antigravity'), 'browser');
  assert.equal(hosted('kimi-code'), 'device');
  assert.equal(hosted('openai-codex-device', 'device'), 'device');
  assert.equal(hostedLoginKind({ providerId: 'anthropic', method: 'api-key', login: kinds.get('anthropic')!, displayName: 'Anthropic' }), 'api-key');
  assert.equal(hosted('groq'), 'api-key');
  assert.equal(hosted('cerebras'), 'api-key');
  assert.equal(hosted('cloudflare-ai-gateway'), 'vendor-token');
  assert.deepEqual(Object.values(loginMethodTitles), ['Browser sign-in', 'Device code', 'API key', 'Vendor token', 'On this Mac']);
  assert.deepEqual(Object.values(loginMethodVerbs), ['Sign in', 'Show code', 'Save key', 'Continue', 'Sign in']);

  const openai = display('openai');
  assert.deepEqual(openai.methods.map((method) => methodRowTitle(openai, method)), ['ChatGPT browser sign-in', 'API key']);
  assert.equal(methodRowTitle(openai, openai.methods[0], 'local'), 'ChatGPT on this Mac');
  const anthropic = display('anthropic');
  assert.deepEqual(anthropic.methods.map((method) => methodRowTitle(anthropic, method)), ['Browser sign-in', 'API key']);
  const antigravity = display('google-antigravity');
  assert.deepEqual(antigravity.methods.map((method) => methodRowTitle(antigravity, method)), ['Browser sign-in']);
});

test('list descriptions carry the qualifier, the method and the model count', () => {
  const antigravity = display('google-antigravity');
  const models = pinnedOmpCatalog.providers.find((entry) => entry.id === 'google-antigravity')?.models.length;
  assert.equal(providerListDescription(antigravity), `Gemini 3, Claude, GPT-OSS · Browser sign-in · ${models} models`);
  assert.match(providerListDescription(display('groq')), /^API key · \d+ models$/);
});

test('generic copy never names the provider or says sign in twice in one sentence', () => {
  for (const text of Object.values(loginMethodFallbackDescriptions)) {
    for (const sentence of text.split(/[.;]\s*/)) {
      assert.ok((sentence.match(/sign[\s-]in/gi) ?? []).length <= 1, `"${sentence}" repeats sign in`);
    }
    assert.doesNotMatch(text, /OpenAI|ChatGPT|Anthropic|Antigravity/);
  }
  for (const verb of Object.values(loginMethodVerbs)) assert.ok(verb.split(' ').length <= 2, verb);
});

test('OMP offers an API key row wherever it takes a key', () => {
  const login = (id: string) => {
    const entry = pinnedOmpCatalog.providers.find((item) => item.id === id)?.login;
    assert.ok(entry, `${id} has no login`);
    return entry;
  };
  assert.deepEqual(ompLoginMethods(login('anthropic')), ['sign-in', 'api-key']);
  assert.deepEqual(ompLoginMethods(login('openrouter')), ['sign-in', 'api-key']);
  assert.deepEqual(ompLoginMethods(login('openai-codex')), ['sign-in']);
  assert.deepEqual(ompLoginMethods(login('groq')), ['api-key']);
  assert.deepEqual(ompLoginMethods({ ...login('google-antigravity'), acceptsApiKeyMethod: true }), ['sign-in', 'api-key']);

  const anthropic = display('anthropic');
  assert.deepEqual(anthropic.methods.map((method) => [methodRowTitle(anthropic, method), method.hostedLogin?.method ?? null]), [
    ['Browser sign-in', null],
    ['API key', 'api-key'],
  ]);
  const openrouter = display('openrouter');
  assert.deepEqual(openrouter.methods.map((method) => methodRowTitle(openrouter, method)), ['Browser sign-in', 'API key']);
});

test('the method picker lists every way to connect, with Kordi on this Mac where it is in use', () => {
  const localAccount = { value: 'profile:work', profileId: 'work', method: 'OAuth', source: 'Kordi auth', label: 'Work', active: true };
  const { authState, providers: withLocal } = buildOmpDisplayProviders(
    { authPath: '', hasAnyAuth: true, providers: [
      { ...localProvider('openai-codex', 'ChatGPT'), configured: true, options: [localAccount] },
      localProvider('openai', 'OpenAI'), localProvider('anthropic', 'Claude'), localProvider('groq', 'Groq'),
    ] },
    [],
    pinnedOmpCatalog.providers,
  );
  const methods = (id: string) => buildAddMethods(withLocal.find((item) => item.id === id)!, authState?.providers ?? []);
  assert.deepEqual(methods('openai').map((method) => method.title), ['ChatGPT browser sign-in', 'ChatGPT device code', 'ChatGPT on this Mac', 'API key']);
  assert.deepEqual(methods('openai').map((method) => method.pageTitle), ['Browser sign-in · ChatGPT', 'Device code · ChatGPT', 'On this Mac · ChatGPT', 'API key · OpenAI']);
  assert.equal(addMethodsSummary(methods('openai')), 'Browser sign-in, device code, on this Mac, API key');
  assert.deepEqual(methods('anthropic').map((method) => method.title), ['Browser sign-in', 'API key']);
  assert.deepEqual(methods('groq').map((method) => [method.title, method.hosted?.method]), [['API key', 'api-key']]);
  assert.deepEqual(methods('openai').find((method) => method.kind === 'device')?.hosted?.providerId, 'openai-codex-device');
});
