import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostedModelOptions, hostedRouteAccounts, hostedRouteForChoice } from '../src/features/chat/hostedComposerOptions';
import { preferredModelValueForProviderFromOptions } from '../src/features/chat/useComposerViewModel';
import { CLAUDE_DEFAULT_MODEL, withClaudeModelCatalog } from '../src/features/cloud/claudeModelCatalog';
import { hostedAccountsFromSnapshots } from '../src/features/cloud/hostedAccounts';
import { catalogModelThinkingLevels } from '../src/features/cloud/modelThinkingLevels';
import { loadPinnedOmpCatalog, refreshOmpCatalog } from '../src/kordi-app/auth/ompCatalog';
import { fallbackComposerThinkingValue } from '../src/kordi-app/components/composerThinking';
import { modelDisplayName } from '../src/lib/modelDisplayName';
import type { CloudProviderAuthSnapshot } from '../src/features/cloud/cloudAgentRuntimeTypes';

const catalog = (await loadPinnedOmpCatalog()).providers;

function hostedSnapshot(provider: string, authChoice: string, modelHint: string | null): CloudProviderAuthSnapshot {
  return {
    snapshotId: `snap_${provider}`, provider, authChoice, label: provider,
    modelHint, createdAt: '2026-01-01T00:00:00Z', revokedAt: null,
  };
}

const hostedAccount = (provider: string, authChoice: string, modelHint: string | null) => {
  const [account] = hostedRouteAccounts(hostedAccountsFromSnapshots([hostedSnapshot(provider, authChoice, modelHint)]), catalog);
  assert.ok(account);
  return account;
};
const claudeAccount = (modelHint: string | null) => hostedAccount('anthropic', 'cloud-api-key:claude', modelHint);

/** This Mac's model options as the composer labels them, with display names. */
const localOptions = (modelIds: string[]) => modelIds.map((modelId) => {
  const value = `anthropic/${modelId}`;
  return { value, label: modelDisplayName(value, modelId), provider: 'anthropic' };
});

test('the pinned catalog opens Claude on Sonnet 5.5 and lists it first, keeping every model', async () => {
  const anthropic = catalog.find((entry) => entry.id === 'anthropic');
  assert.ok(anthropic);
  assert.equal(CLAUDE_DEFAULT_MODEL, 'claude-sonnet-5-5');
  assert.equal(anthropic.defaultModel, 'claude-sonnet-5-5');
  assert.equal(anthropic.models[0], 'claude-sonnet-5-5');
  assert.equal(anthropic.models.filter((model) => model === 'claude-sonnet-5-5').length, 1);
  assert.ok(anthropic.models.includes('claude-opus-5-5'));
  assert.deepEqual(catalogModelThinkingLevels(catalog, 'anthropic', 'claude-sonnet-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);

  const refreshed = await refreshOmpCatalog({ version: null, providers: catalog }, async () => ({
    providers: [{ id: 'anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' }],
  }));
  assert.equal(refreshed.providers[0]?.defaultModel, 'claude-sonnet-5-5', 'a hosted catalog refresh keeps the Kordi default');
});

test('a catalog without Sonnet 5.5, and other providers, keep their own default', () => {
  const older = { id: 'anthropic', models: ['claude-opus-4-8', 'claude-sonnet-5'], defaultModel: 'claude-opus-4-8' };
  assert.equal(withClaudeModelCatalog(older), older);
  const bedrock = { id: 'amazon-bedrock', models: ['claude-sonnet-5-5'], defaultModel: 'us.anthropic.claude-opus-5-5' };
  assert.equal(withClaudeModelCatalog(bedrock), bedrock);
});

test('a fresh hosted Claude account opens on Sonnet 5.5 and leaves its effort to the runtime', () => {
  const fresh = claudeAccount(null);
  assert.equal(fresh.models[0], 'claude-sonnet-5-5');
  const options = hostedModelOptions([fresh], catalog);
  assert.equal(options[0]?.value, 'anthropic/claude-sonnet-5-5', 'the picker default row and first model');
  // No effort leaves the runner's default for Sonnet 5.5, which is Medium.
  assert.deepEqual(hostedRouteForChoice(fresh, { catalog }), {
    model: 'anthropic/claude-sonnet-5-5', authProvider: 'anthropic', authChoice: 'cloud-api-key:claude', thinking: null,
  });
  for (const thinking of ['off', 'default', 'minimal', 'medium', 'xhigh']) {
    assert.equal(hostedRouteForChoice(fresh, { thinking, catalog })?.thinking, thinking, `${thinking} passes through`);
  }
});

test('choosing a hosted account never rewrites the effort, for any provider', () => {
  const cases = [
    { account: hostedAccount('openai-codex', 'cloud-login:chatgpt', 'gpt-6.1-sol'), model: 'openai-codex/gpt-6.1-sol' },
    { account: claudeAccount('claude-opus-4-8'), model: 'anthropic/claude-opus-4-8' },
    { account: hostedAccount('google', 'cloud-api-key:gemini', 'gemini-3.1-pro-preview'), model: 'google/gemini-3.1-pro-preview' },
  ];
  for (const { account, model } of cases) {
    for (const thinking of ['default', 'off', 'minimal', null]) {
      const route = hostedRouteForChoice(account, { thinking, catalog });
      assert.equal(route?.model, model, model);
      assert.equal(route?.thinking, thinking, `${model} keeps ${String(thinking)}`);
      assert.equal(hostedRouteForChoice(account, { model, thinking, catalog })?.thinking, thinking, `${model} chosen by model keeps ${String(thinking)}`);
    }
  }
});

test('a stored Claude model and effort are never replaced', () => {
  const stored = claudeAccount('claude-opus-4-8');
  assert.equal(hostedRouteForChoice(stored, { catalog })?.model, 'anthropic/claude-opus-4-8');
  assert.equal(hostedRouteForChoice(stored, { model: 'anthropic/claude-sonnet-5', thinking: 'high', catalog })?.model, 'anthropic/claude-sonnet-5');
  assert.equal(hostedRouteForChoice(stored, { thinking: 'high', catalog })?.thinking, 'high');
  const runtimeRoute = { provider: 'anthropic', model: 'claude-opus-4-8' };
  assert.equal(
    preferredModelValueForProviderFromOptions('anthropic', localOptions(['claude-opus-4-8', 'claude-sonnet-5-5']), [], runtimeRoute),
    'anthropic/claude-opus-4-8',
    "this Mac's saved default model wins",
  );
});

test("this Mac's Claude account opens on Sonnet 5.5 at medium effort, matched by model id", () => {
  const options = localOptions(['claude-fable-5-1', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-5-5']);
  assert.equal(options[3]?.label, 'Claude Sonnet 5.5');
  assert.equal(preferredModelValueForProviderFromOptions('anthropic', options, []), 'anthropic/claude-sonnet-5-5');
  assert.equal(
    preferredModelValueForProviderFromOptions('anthropic', localOptions(['claude-fable-5-1', 'claude-sonnet-5']), []),
    'anthropic/claude-sonnet-5',
    'without Sonnet 5.5 the previous Sonnet opens',
  );
  assert.equal(
    preferredModelValueForProviderFromOptions('anthropic', localOptions(['claude-fable-5-1', 'claude-sonnet-5-5-preview']), []),
    'anthropic/claude-fable-5-1',
    'only the exact Sonnet 5.5 id matches',
  );
  // Switching this Mac's composer to Sonnet 5.5 moves a level it lacks to Medium.
  const levels = catalogModelThinkingLevels(catalog, 'anthropic', 'claude-sonnet-5-5') ?? [];
  for (const current of ['off', 'default']) assert.equal(fallbackComposerThinkingValue(levels, current), 'medium', current);
});
