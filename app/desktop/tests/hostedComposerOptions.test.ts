import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveDefaultCloudAgentRuntimeRoute } from '../src/app/useKordiDefaultCloudAgentRuntimeRoute';
import {
  hostedAuthOptions,
  hostedModelOptions,
  hostedProviderOptions,
  hostedRouteAccounts,
  hostedRouteForChoice,
  hostedRouteForModel,
  KORDI_CLOUD_ACCOUNT_DETAIL,
  RECONNECT_ACCOUNT_REASON,
} from '../src/features/chat/hostedComposerOptions';
import { composerRouteDecision } from '../src/features/chat/useHostedComposerRouting';
import { preferredModelValueForProviderFromOptions } from '../src/features/chat/useComposerViewModel';
import { hostedAccountsFromSnapshots } from '../src/features/cloud/hostedAccounts';
import { setHostedAccountChoices, setLocalAccountChoices } from '../src/features/cloud/hostedAccountRegistry';
import { isHostedOnlyAccountChoice } from '../src/features/cloud/routeAccountChoice';
import { routeRunsOnKordiCloud } from '../src/features/cloud/cloudAgentRuntimeRoute';
import { loadPinnedOmpCatalog } from '../src/kordi-app/auth/ompCatalog';
import { resolveComposerModelSelection } from '../src/kordi-app/components/composerModelSelection';
import type { CloudProviderAuthSnapshot } from '../src/features/cloud/cloudAgentRuntimeTypes';
import type { DesktopAuthState } from '../src/kordi-app/types';

function snapshot(authChoice: string, label: string, provider: string, modelHint: string | null, overrides: Partial<CloudProviderAuthSnapshot> = {}): CloudProviderAuthSnapshot {
  return { snapshotId: `snap_${label}`, provider, authChoice, label, modelHint, createdAt: '2026-01-01T00:00:00Z', revokedAt: null, ...overrides };
}

const catalog = (await loadPinnedOmpCatalog()).providers;
const entry = (id: string) => {
  const found = catalog.find((item) => item.id === id);
  assert.ok(found, `${id} is missing`);
  return found;
};
const cerebrasDefault = entry('cerebras').defaultModel ?? entry('cerebras').models[0];

const snapshots = [
  snapshot('cloud-api-key:bai', 'bai', 'custom', 'deepseek-chat'),
  snapshot('cloud-api-key:lab', 'Lab', 'custom', 'qwen-plus'),
  snapshot('cloud-api-key:research', 'Research', 'cerebras', null),
  snapshot('cloud-login:team', 'Team', 'openai-codex', 'gpt-5.5'),
  snapshot('cloud-login:old', 'Old laptop', 'openai-codex', null, { status: 'needs-reconnect' }),
  snapshot('profile:work', 'Work', 'openai-codex', null),
  snapshot('cloud-api-key:gone', 'Gone', 'custom', 'gone', { revokedAt: '2026-02-01T00:00:00Z' }),
];
// Work is saved on this Mac too, so it stays a local account.
const accounts = hostedRouteAccounts(hostedAccountsFromSnapshots(snapshots), catalog, new Set(['profile:work']));
const account = (label: string) => {
  const found = accounts.find((item) => item.label === label);
  assert.ok(found, `${label} is missing`);
  return found;
};

// The owner has an OpenAI key on this Mac; a hosted route must never borrow it.
const openAiState: DesktopAuthState = {
  authPath: '', hasAnyAuth: true,
  providers: [{
    id: 'openai', label: 'OpenAI', statusSummary: '', loginHint: '', envVar: '', helpUrl: '',
    supportsOAuth: false, supportsApiKey: true, configured: true,
    options: [{ value: 'profile:key', profileId: 'key', method: 'API key', source: 'Kordi auth', label: 'Key', active: true }],
  }],
};
const openAiAuth = { providerId: 'openai', providerLabel: 'OpenAI', methodLabel: 'API key', value: 'profile:key', label: 'Key', active: true };

test('the composer lists every hosted account the provider page lists, and no local or revoked one', () => {
  assert.deepEqual(accounts.map((item) => [item.label, item.providerId]), [
    ['bai', 'custom'], ['Lab', 'custom'], ['Research', 'cerebras'], ['Team', 'openai-codex'], ['Old laptop', 'openai-codex'],
  ]);
  const providers = hostedProviderOptions(accounts, 'cloud-login:team');
  assert.deepEqual(providers.map((option) => [option.label, option.detail, Boolean(option.active), Boolean(option.disabled)]), [
    ['bai', `Custom API · ${KORDI_CLOUD_ACCOUNT_DETAIL}`, false, false],
    ['Lab', `Custom API · ${KORDI_CLOUD_ACCOUNT_DETAIL}`, false, false],
    ['Research', `${account('Research').providerLabel} · ${KORDI_CLOUD_ACCOUNT_DETAIL}`, false, false],
    ['Team', `${account('Team').providerLabel} · ${KORDI_CLOUD_ACCOUNT_DETAIL}`, true, false],
    ['Old laptop', `${account('Old laptop').providerLabel} · ${RECONNECT_ACCOUNT_REASON}`, false, true],
  ]);
  assert.equal(providers[4].disabledReason, RECONNECT_ACCOUNT_REASON);
  assert.deepEqual(hostedAuthOptions(accounts, null).map((option) => option.label), ['bai', 'Lab', 'Research', 'Team'], 'a reconnect-only account cannot be chosen');
});

test('a hosted account offers its stored model plus its catalog models; Custom API offers only its own model', () => {
  assert.deepEqual(account('bai').models, ['deepseek-chat']);
  assert.deepEqual(account('Research').models, entry('cerebras').models);
  assert.equal(account('Team').models[0], 'gpt-5.5');
  assert.deepEqual(new Set(account('Team').models), new Set(['gpt-5.5', ...entry('openai-codex').models]));
  const models = hostedModelOptions(accounts);
  assert.ok(models.some((option) => option.value === 'custom/deepseek-chat'));
  assert.ok(models.some((option) => option.value === `cerebras/${cerebrasDefault}`));
  assert.equal(models.filter((option) => option.value.startsWith('custom/')).length, 2);
  assert.equal(preferredModelValueForProviderFromOptions('custom', models, []), 'custom/deepseek-chat');
});

test('choosing a hosted account applies its Kordi Cloud route; its stored model or the catalog default', () => {
  assert.deepEqual(hostedRouteForChoice(account('bai')), { model: 'custom/deepseek-chat', authProvider: 'custom', authChoice: 'cloud-api-key:bai', thinking: null });
  assert.deepEqual(hostedRouteForChoice(account('Research'), { catalog }), { model: `cerebras/${cerebrasDefault}`, authProvider: 'cerebras', authChoice: 'cloud-api-key:research', thinking: null });
  assert.equal(hostedRouteForChoice(account('Team'), { model: 'openai-codex/not-a-model' })?.model, 'openai-codex/gpt-5.5');
  assert.equal(hostedRouteForChoice(account('Old laptop')), null, 'an account that needs reconnecting cannot run');
  for (const label of ['bai', 'Research', 'Team']) assert.equal(routeRunsOnKordiCloud(hostedRouteForChoice(account(label), { catalog })), true, label);
});

test('a model choice keeps the session hosted account, and a local provider keeps the local runtime', () => {
  const teamRoute = hostedRouteForChoice(account('Team'));
  const nextCodexModel = entry('openai-codex').models.find((model) => model !== 'gpt-5.5') ?? 'gpt-5.5';
  assert.equal(hostedRouteForModel({ accounts, model: `openai-codex/${nextCodexModel}`, currentRoute: teamRoute })?.authChoice, 'cloud-login:team');
  assert.equal(hostedRouteForModel({ accounts, model: 'custom/qwen-plus' })?.authChoice, 'cloud-api-key:lab');
  assert.equal(hostedRouteForModel({ accounts, model: `cerebras/${cerebrasDefault}` })?.authChoice, 'cloud-api-key:research', 'no local Cerebras account');
  assert.equal(hostedRouteForModel({ accounts, model: `cerebras/${cerebrasDefault}`, localProviderIds: new Set(['cerebras']) }), null, 'a local account runs here');
  assert.equal(hostedRouteForModel({ accounts, model: 'openai-codex/gpt-5.5', localProviderIds: new Set(['openai-codex']) }), null);
});

test('composer changes apply the cloud route like Start chat, and a local account returns to this Mac', () => {
  const context = { accounts, currentRoute: null, localProviderIds: new Set(['openai-codex']), catalog };
  const toResearch = composerRouteDecision({ model: null, thinking: 'medium', choice: { providerId: 'cerebras', authChoice: 'cloud-api-key:research' } }, context);
  assert.deepEqual(toResearch, { route: { model: `cerebras/${cerebrasDefault}`, authProvider: 'cerebras', authChoice: 'cloud-api-key:research', thinking: 'medium' }, leavesCloud: false });
  const onCloud = { ...context, currentRoute: toResearch?.route ?? null };
  assert.deepEqual(
    composerRouteDecision({ model: 'openai-codex/gpt-5.5', thinking: 'medium', choice: { providerId: 'openai-codex', authChoice: 'profile:work' } }, onCloud),
    { route: { model: 'openai-codex/gpt-5.5', authProvider: 'openai-codex', authChoice: 'profile:work', thinking: 'medium' }, leavesCloud: true },
  );
  assert.equal(composerRouteDecision({ model: 'openai-codex/gpt-5.5', thinking: 'medium', choice: { providerId: 'openai-codex', authChoice: 'profile:work' } }, context), null, 'already local');
  assert.equal(composerRouteDecision({ model: null, thinking: null, choice: { providerId: 'openai-codex', authChoice: 'cloud-login:old' } }, context), null, 'reconnect first');
  assert.deepEqual(composerRouteDecision({ model: null, thinking: 'high' }, onCloud)?.route.thinking, 'high');
});

test('the selected hosted account shows as the route account in the menu', () => {
  const providers = hostedProviderOptions(accounts, 'cloud-api-key:lab');
  const selection = resolveComposerModelSelection({
    selection: { model: 'custom/qwen-plus', authProvider: 'custom', authChoice: 'cloud-api-key:lab' },
    providerOptions: providers,
    modelOptions: hostedModelOptions(accounts),
  });
  assert.equal(selection.selectedProviderValue, 'custom');
  assert.equal(selection.selectedProviderOption?.label, 'Lab');
  assert.equal(selection.selectedModelOption?.label, 'qwen-plus');
  assert.equal(selection.missingAccount, false);
});

test('a custom route runs on its hosted account and never falls back to another provider', () => {
  const route = (selectedModel: string, hosted = accounts) => resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai',
    authOptions: [openAiAuth, ...hostedAuthOptions(hosted, selectedModel === 'custom/qwen-plus' ? 'cloud-api-key:lab' : null)],
    chatModelOptions: [{ value: 'openai/gpt-5.5', label: 'gpt-5.5', provider: 'openai' }, ...hostedModelOptions(hosted)],
    desktopAuthState: openAiState,
    isNativeShell: true,
    preferredModelValueForProvider: () => 'openai/gpt-5.5',
    resolveComposerProviderId: (_, model) => model.split('/')[0] ?? 'openai',
    selectedModel,
    selectedThinking: 'off',
  });
  assert.deepEqual(route('custom/qwen-plus'), { model: 'custom/qwen-plus', authProvider: 'custom', authChoice: 'cloud-api-key:lab', thinking: 'off' });
  assert.equal(route('custom/deepseek-chat')?.authChoice, 'cloud-api-key:bai');
  assert.equal(route(`cerebras/${cerebrasDefault}`)?.authChoice, 'cloud-api-key:research', 'a provider with only hosted accounts');
  assert.equal(route('custom/deepseek-chat', []), null, 'without a hosted account there is no route, not an OpenAI one');
  assert.equal(route('openai/gpt-5.5')?.authProvider, 'openai');
  assert.equal(routeRunsOnKordiCloud(route('custom/qwen-plus')), true, 'the hosted account runs on Kordi Cloud');
  assert.equal(routeRunsOnKordiCloud(route('openai/gpt-5.5')), false, 'the local account keeps the local runtime');
});

test('hosted-only accounts: every hosted prefix, and hosted copies with no local counterpart', () => {
  for (const choice of ['cloud-api-key:bai', 'cloud-login:team', 'ios-codex:phone', 'ios-api-key:phone-key']) {
    assert.equal(isHostedOnlyAccountChoice(choice), true, choice);
    assert.equal(isHostedOnlyAccountChoice(` ${choice} `), true, `${choice} with spaces`);
  }
  for (const choice of ['cloud-api-key:', 'cloud-login:', 'ios-codex:', 'ios-api-key:', 'ios-api-key', 'local-active-oauth', 'profile:key', '', null, undefined]) {
    assert.equal(isHostedOnlyAccountChoice(choice), false, String(choice));
  }
  // A profile published from another Mac is hosted-only here; the same profile on this Mac is local.
  assert.equal(isHostedOnlyAccountChoice('profile:other-mac', { hostedChoices: ['profile:other-mac'], localChoices: ['profile:key'] }), true);
  assert.equal(isHostedOnlyAccountChoice('profile:key', { hostedChoices: ['profile:key'], localChoices: ['profile:key'] }), false);
  assert.equal(isHostedOnlyAccountChoice('profile:unknown', { hostedChoices: [], localChoices: [] }), false);
});

test('until this Mac has loaded its accounts, no hosted copy of them counts as hosted-only', () => {
  // The desktop auth state is null (a load error, or the reload after a Kordi session change).
  assert.equal(isHostedOnlyAccountChoice('profile:work', { hostedChoices: ['profile:work'], localChoices: null }), false);
  assert.equal(isHostedOnlyAccountChoice('cloud-login:team', { hostedChoices: ['cloud-login:team'], localChoices: null }), true, 'a hosted-only prefix needs no local list');
  const offered = hostedRouteAccounts(hostedAccountsFromSnapshots(snapshots), catalog, null).map((item) => item.authChoice);
  assert.equal(offered.includes('profile:work'), false, 'the composer does not label this Mac\'s account "Runs on Kordi Cloud"');
  assert.ok(offered.includes('cloud-api-key:bai') && offered.includes('cloud-login:team'));

  setHostedAccountChoices(['profile:work']);
  setLocalAccountChoices(null);
  try {
    const copied = { model: 'openai-codex/gpt-5.5', authProvider: 'openai-codex', authChoice: 'profile:work', thinking: 'medium' };
    assert.equal(routeRunsOnKordiCloud(copied), false, 'the turn stays on this Mac instead of being claimed for Kordi Cloud');
    setLocalAccountChoices([]);
    assert.equal(routeRunsOnKordiCloud(copied), true, 'once loaded without it, the copy runs on Kordi Cloud');
  } finally {
    setHostedAccountChoices([]);
    setLocalAccountChoices(null);
  }
});
