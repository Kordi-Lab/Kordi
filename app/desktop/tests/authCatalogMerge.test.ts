import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildOmpDisplayProviders,
  mergeOmpAuthState,
  loadPinnedOmpCatalog,
  refreshOmpCatalog,
  type OmpCatalog,
} from '../src/kordi-app/auth/ompCatalog';
import { BUNDLED_CATALOG_FALLBACK_NOTICE, CATALOG_UNAVAILABLE_NOTICE, loadAuthOmpCatalog } from '../src/kordi-app/auth/useAuthOmpCatalog';
import type { CloudProviderAuthSnapshot } from '../src/features/cloud/cloudAgentRuntimeTypes';
import type { DesktopAuthOption, DesktopAuthProvider, DesktopAuthState } from '../src/kordi-app/types';

const pinnedPayload = JSON.parse(readFileSync(
  new URL('../../../shared/omp-catalog/omp-provider-catalog.json', import.meta.url),
  'utf8',
)) as { version: string; providers: Array<{ id: string; models: string[]; auth: { name: string } }> };

function localProvider(overrides: Partial<DesktopAuthProvider>): DesktopAuthProvider {
  return {
    id: 'openai',
    label: 'OpenAI',
    statusSummary: '[not authenticated]',
    loginHint: 'Use a saved account or key.',
    envVar: '',
    helpUrl: '',
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

function savedOption(label: string, method: 'OAuth' | 'API key', profileId: string): DesktopAuthOption {
  return { value: `profile:${profileId}`, profileId, method, source: 'Kordi auth', label, active: true };
}

function authState(providers: DesktopAuthProvider[]): DesktopAuthState {
  return { authPath: '', hasAnyAuth: providers.some((provider) => provider.options.length > 0), providers };
}

function snapshot(provider: string, authChoice: string, label: string): CloudProviderAuthSnapshot {
  return { snapshotId: `snap_${label.toLowerCase()}`, provider, authChoice, label, createdAt: '2026-01-01T00:00:00Z', revokedAt: null };
}

// The pinned catalog is its own chunk; load it once for every case.
const pinnedOmpCatalog = await loadPinnedOmpCatalog();
const ompWithModels = pinnedOmpCatalog.providers.filter((entry) => entry.models.length > 0);

test('the bundled catalog is the pinned OMP export, loaded once', async () => {
  assert.equal(await loadPinnedOmpCatalog(), pinnedOmpCatalog, 'repeated loads share one catalog');
  assert.equal(pinnedOmpCatalog.version, pinnedPayload.version);
  assert.deepEqual(pinnedOmpCatalog.providers.map((entry) => entry.id), pinnedPayload.providers.map((entry) => entry.id));
  assert.ok(ompWithModels.length >= 60, `expected at least 60 OMP providers with models, got ${ompWithModels.length}`);
});

test('every pinned provider with a model appears, plus Custom API and the local model servers', () => {
  const { providers } = buildOmpDisplayProviders(authState([]), [], pinnedOmpCatalog.providers);
  const ids = new Set(providers.flatMap((provider) => [provider.id, ...provider.methods.map((method) => method.providerId)]));
  for (const entry of ompWithModels) assert.ok(ids.has(entry.id), `${entry.id} is missing`);
  for (const entry of pinnedOmpCatalog.providers.filter((item) => item.models.length === 0)) {
    assert.equal(ids.has(entry.id), false, `${entry.id} has no models and must stay hidden`);
  }
  assert.ok(ids.has('custom'));
  assert.equal(providers.find((provider) => provider.id === 'custom')?.label, 'Custom API');
  assert.equal(providers.length, 72, 'OMP rows (ChatGPT folded into OpenAI) plus custom, lm-studio, and ollama');
  assert.equal(providers.length, ompWithModels.length - 1 + 3);
  assert.equal(providers.some((provider) => provider.id === 'openai-codex'), false);
});

test('one OpenAI row spans ChatGPT sign-in and API keys with per-method OMP models', () => {
  const state = authState([
    localProvider({ id: 'openai-codex', label: 'ChatGPT', supportsOAuth: true, configured: true, options: [savedOption('Work', 'OAuth', 'work')] }),
    localProvider({ id: 'openai', label: 'OpenAI API', configured: true, options: [savedOption('Billing key', 'API key', 'billing')] }),
  ]);
  const { providers } = buildOmpDisplayProviders(state, [], pinnedOmpCatalog.providers);
  const openAi = providers.find((provider) => provider.id === 'openai');
  assert.equal(openAi?.label, 'OpenAI');
  assert.deepEqual(openAi?.methods.map((method) => [method.mode, method.providerId]), [['oauth', 'openai-codex'], ['api-key', 'openai']]);
  assert.deepEqual(openAi?.methods.map((method) => method.options.map((option) => option.label)), [['Work'], ['Billing key']]);
  const codexModels = pinnedPayload.providers.find((entry) => entry.id === 'openai-codex')?.models;
  const apiModels = pinnedPayload.providers.find((entry) => entry.id === 'openai')?.models;
  assert.deepEqual(openAi?.methods[0].modelIds, codexModels);
  assert.deepEqual(openAi?.methods[1].modelIds, apiModels);
  assert.notDeepEqual(codexModels, apiModels);
});

test('an overlapping provider takes its name, models, and auth policy from OMP', () => {
  const omp = pinnedPayload.providers.find((entry) => entry.id === 'groq');
  assert.ok(omp);
  const state = authState([
    localProvider({ id: 'groq', label: 'Legacy Groq label', supportsOAuth: true }),
    localProvider({ id: 'openai', label: 'Legacy OpenAI label', supportsOAuth: true }),
  ]);
  const { authState: merged, providers } = buildOmpDisplayProviders(state, [], pinnedOmpCatalog.providers);
  const display = providers.find((provider) => provider.id === 'groq');
  assert.equal(display?.label, omp.auth.name);
  assert.deepEqual(display?.modelIds, omp.models);
  assert.equal(display?.ompAuth?.kind, 'api-key');
  const raw = merged?.providers.find((provider) => provider.id === 'openai');
  assert.equal(raw?.label, pinnedPayload.providers.find((entry) => entry.id === 'openai')?.auth.name);
  assert.deepEqual(raw?.options, []);
  assert.equal(raw?.supportsOAuth, false, 'OMP api-key providers have no Kordi sign-in adapter');
  assert.equal(raw?.supportsApiKey, true);
});

test('saved accounts attach to the OMP entry through the provider alias table', () => {
  const state = authState([
    localProvider({ id: 'openai-codex', label: 'ChatGPT', supportsOAuth: true, configured: true, options: [savedOption('Work', 'OAuth', 'work')] }),
    localProvider({ id: 'google-gemini', label: 'Gemini', configured: true, options: [savedOption('Gemini key', 'API key', 'gemini')] }),
  ]);
  const snapshots = [
    snapshot('openai', 'ios-codex:personal', 'Personal'),
    snapshot('codex', 'ios-codex:team', 'Team'),
    snapshot('openai-codex', 'profile:work', 'Work duplicate'),
  ];
  const merged = mergeOmpAuthState(state, snapshots, pinnedOmpCatalog.providers);
  const codex = merged?.providers.find((provider) => provider.id === 'openai-codex');
  assert.equal(codex?.label, pinnedPayload.providers.find((entry) => entry.id === 'openai-codex')?.auth.name);
  assert.deepEqual(codex?.options.map((option) => option.label), ['Work', 'Personal', 'Team']);
  assert.equal(codex?.supportsOAuth, true);
  assert.equal(codex?.supportsApiKey, false, 'a vendor token variable is not an API key');
  assert.deepEqual(merged?.providers.find((provider) => provider.id === 'google')?.options.map((option) => option.label), ['Gemini key']);
  assert.equal(merged?.providers.some((provider) => provider.id === 'google-gemini' || provider.id === 'codex'), false);
});

test('lm-studio and ollama stay local and are never merged into similar OMP entries', () => {
  const state = authState([
    localProvider({ id: 'ollama', label: 'Ollama', configured: true, baseUrl: 'http://localhost:11434/v1', preferredModel: 'ollama/qwen3' }),
    localProvider({ id: 'lm-studio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' }),
  ]);
  const { authState: merged, providers } = buildOmpDisplayProviders(state, [], pinnedOmpCatalog.providers);
  assert.equal(merged?.providers.find((provider) => provider.id === 'ollama')?.label, 'Ollama');
  assert.equal(merged?.providers.find((provider) => provider.id === 'lm-studio')?.label, 'LM Studio');
  assert.equal(providers.find((provider) => provider.id === 'ollama')?.localBaseUrl, 'http://localhost:11434/v1');
  assert.equal(providers.find((provider) => provider.id === 'ollama-cloud')?.configured, false);
  assert.equal(providers.some((provider) => provider.id === 'local'), false);
});

test('anthropic offers both subscription sign-in and an API key', () => {
  const omp = pinnedOmpCatalog.providers.find((entry) => entry.id === 'anthropic');
  assert.ok(omp?.auth?.envVars.includes('ANTHROPIC_API_KEY'));
  const { authState: merged, providers } = buildOmpDisplayProviders(
    authState([localProvider({ id: 'anthropic', label: 'Claude Pro/Max', supportsOAuth: true })]),
    [],
    pinnedOmpCatalog.providers,
  );
  const raw = merged?.providers.find((provider) => provider.id === 'anthropic');
  assert.equal(raw?.supportsOAuth, true);
  assert.equal(raw?.supportsApiKey, true);
  const display = providers.find((provider) => provider.id === 'anthropic');
  assert.equal(display?.label, omp.auth?.name);
  assert.deepEqual(display?.methods.map((method) => method.mode), ['oauth', 'api-key']);
  assert.equal(display?.ompAuth?.acceptsApiKey, true);
});

test('a hosted catalog replaces the pinned one and any failure silently keeps it', async () => {
  const hosted = { providers: [{ id: 'hosted-only', models: ['hosted-model'], defaultModel: 'hosted-model' }] };
  const replaced = await refreshOmpCatalog(pinnedOmpCatalog, () => Promise.resolve(hosted));
  assert.deepEqual(replaced, { version: null, providers: [{ ...hosted.providers[0], login: null }] } satisfies OmpCatalog);
  const groq = pinnedOmpCatalog.providers.find((entry) => entry.id === 'groq');
  const withoutLogin = await refreshOmpCatalog(pinnedOmpCatalog, () => Promise.resolve({ providers: [{ id: 'groq', models: ['m'] }] }));
  assert.deepEqual(withoutLogin.providers[0].login, groq?.login, 'older servers keep the pinned login steps');

  const kept = await refreshOmpCatalog(pinnedOmpCatalog, () => Promise.reject(new Error('offline')));
  assert.equal(kept, pinnedOmpCatalog);
  assert.equal(await refreshOmpCatalog(pinnedOmpCatalog, () => Promise.resolve({ providers: [] })), pinnedOmpCatalog);
  assert.equal(await refreshOmpCatalog(pinnedOmpCatalog, null), pinnedOmpCatalog);
});

test('without this Mac\'s accounts the list still comes from the catalog', () => {
  const { providers } = buildOmpDisplayProviders(null, [snapshot('groq', 'cloud-api-key:team', 'Team')], pinnedOmpCatalog.providers);
  assert.equal(providers.length, buildOmpDisplayProviders(authState([]), [], pinnedOmpCatalog.providers).providers.length);
  assert.equal(providers.find((provider) => provider.id === 'groq')?.configured, true, 'hosted accounts still show');
});

test('a failed catalog chunk falls back to the server catalog with a notice', async () => {
  const hosted = { version: 'server', providers: [{ id: 'groq', models: ['m'] }] };
  const chunkFailed = () => Promise.reject(new Error('chunk failed'));
  const fromServer = await loadAuthOmpCatalog(chunkFailed, () => Promise.resolve(hosted));
  assert.equal(fromServer.notice, BUNDLED_CATALOG_FALLBACK_NOTICE);
  assert.deepEqual(fromServer.catalog.providers.map((entry) => entry.id), ['groq']);

  const nothing = await loadAuthOmpCatalog(chunkFailed, () => Promise.reject(new Error('offline')));
  assert.equal(nothing.notice, CATALOG_UNAVAILABLE_NOTICE);
  assert.deepEqual(nothing.catalog.providers, []);
  assert.equal((await loadAuthOmpCatalog(chunkFailed, null)).notice, CATALOG_UNAVAILABLE_NOTICE);

  let shown: OmpCatalog | null = null;
  const pinned = await loadAuthOmpCatalog(() => Promise.resolve(pinnedOmpCatalog), null, (catalog) => { shown = catalog; });
  assert.equal(shown, pinnedOmpCatalog, 'the pinned catalog shows before the refresh');
  assert.deepEqual(pinned, { catalog: pinnedOmpCatalog, notice: null });
});
