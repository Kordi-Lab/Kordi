import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AuthSavedAccounts } from '../src/kordi-app/auth/AuthSavedAccounts';
import {
  continueChatProvider, hasActiveAccount, startChatBlockedReason, startChatTarget, withActiveAccount,
} from '../src/kordi-app/auth/authRouteAccounts';
import { CUSTOM_MODEL_REQUIRED, customApiAccountSummary, customModelIdError } from '../src/kordi-app/auth/customApiAccount';
import { buildOmpDisplayProviders, loadPinnedOmpCatalog } from '../src/kordi-app/auth/ompCatalog';
import type { CloudProviderAuthSnapshot } from '../src/features/cloud/cloudAgentRuntimeTypes';
import type { DesktopAuthOption, DesktopAuthProvider } from '../src/kordi-app/types';

function localProvider(id: string, options: DesktopAuthOption[] = [], preferredModel: string | null = null): DesktopAuthProvider {
  return {
    id, label: id, statusSummary: '', loginHint: '', envVar: '', helpUrl: '',
    supportsOAuth: true, supportsApiKey: true, configured: options.length > 0, preferredModel, options,
  };
}

function option(label: string, active: boolean, method: 'OAuth' | 'API key' = 'OAuth'): DesktopAuthOption {
  const profileId = label.toLowerCase();
  return { value: `profile:${profileId}`, profileId, method, source: 'Kordi auth', label, active };
}

function hosted(provider: string, label: string, modelHint: string | null = null): CloudProviderAuthSnapshot {
  return {
    snapshotId: `snap_${label.toLowerCase()}`, provider, authChoice: `cloud-login:${label.toLowerCase()}`,
    label, modelHint, createdAt: '2026-01-01T00:00:00Z', revokedAt: null,
  };
}

const catalog = await loadPinnedOmpCatalog();
const entry = (id: string) => {
  const found = catalog.providers.find((item) => item.id === id);
  assert.ok(found, `${id} is missing from the pinned catalog`);
  return found;
};
const defaultModel = (id: string) => {
  const { models, defaultModel: preferred } = entry(id);
  return preferred && models.includes(preferred) ? preferred : models[0];
};
function display(id: string, locals: DesktopAuthProvider[], snapshots: CloudProviderAuthSnapshot[] = []) {
  const { providers } = buildOmpDisplayProviders({ authPath: '', hasAnyAuth: true, providers: locals }, snapshots, catalog.providers);
  const provider = providers.find((item) => item.id === id);
  assert.ok(provider, `${id} is missing`);
  return provider;
}

test('Start chat opens the active account with its provider default model', () => {
  const openai = display('openai', [localProvider('openai-codex', [option('Work', false), option('Personal', true)])]);
  const target = startChatTarget(openai);
  assert.equal(target?.account.label, 'Personal');
  assert.equal(target?.model, `openai-codex/${defaultModel('openai-codex')}`);
});

test('Start chat prefers the saved preferred model and falls back to the first account', () => {
  const cerebras = entry('cerebras');
  const preferred = cerebras.models.find((model) => model !== defaultModel('cerebras')) ?? cerebras.models[0];
  const provider = display('cerebras', [localProvider('cerebras', [option('Lab', false, 'API key'), option('Home', false, 'API key')], `cerebras/${preferred}`)]);
  assert.equal(hasActiveAccount(provider), false);
  const target = startChatTarget(provider);
  assert.equal(target?.account.label, 'Lab');
  assert.equal(target?.account.hosted, false);
  assert.equal(target?.model, `cerebras/${preferred}`);
});

test('Start chat has nothing to open without a saved account', () => {
  assert.equal(startChatTarget(display('cerebras', [])), null);
});

test('a Custom API account opens custom/<model>, and without a model Start chat says what is missing', () => {
  const withModel = display('custom', [], [hosted('custom', 'Gateway', 'deepseek-chat')]);
  assert.equal(startChatTarget(withModel)?.model, 'custom/deepseek-chat');
  assert.equal(startChatBlockedReason(withModel), null);

  const legacy = display('custom', [], [hosted('custom', 'Gateway')]);
  const target = startChatTarget(legacy);
  assert.equal(target?.account.hosted, true);
  assert.equal(target?.model, null);
  assert.equal(startChatBlockedReason(legacy), CUSTOM_MODEL_REQUIRED);
  assert.equal(startChatBlockedReason(display('cerebras', [])), 'Add an account to start a chat.');
  assert.equal(startChatBlockedReason(display('cerebras', [], [hosted('cerebras', 'Lab')])), null);
});

test('Custom API model IDs are required, short, and free of spaces', () => {
  assert.equal(customModelIdError('deepseek-chat'), null);
  assert.equal(customModelIdError('  '), 'Enter the model ID your endpoint serves.');
  assert.equal(customModelIdError('x'.repeat(121)), 'Use at most 120 characters.');
  assert.equal(customModelIdError('x'.repeat(120)), null);
  assert.equal(customModelIdError('deepseek chat'), 'Model IDs cannot contain spaces.');
  assert.equal(customApiAccountSummary('deepseek-chat'), 'Custom API · deepseek-chat');
  assert.equal(customApiAccountSummary(null), 'Custom API');
});

test('Continue to chat opens a hosted-only owner in their Custom API model', () => {
  const custom = display('custom', [], [hosted('custom', 'Gateway', 'deepseek-chat')]);
  const legacy = display('custom', [], [hosted('custom', 'Gateway')]);
  const openai = display('openai', [localProvider('openai-codex', [option('Work', true)])]);
  assert.equal(continueChatProvider([custom])?.provider.id, 'custom');
  assert.equal(continueChatProvider([custom])?.blocked, false);
  assert.deepEqual(continueChatProvider([legacy])?.blocked, true, 'a custom account without a model opens its page instead');
  assert.equal(continueChatProvider([custom, openai]), null, 'accounts on this Mac keep the current chat');
});

test('a new hosted account becomes active only when the provider had no active account', () => {
  const added = display('cerebras', [], [hosted('cerebras', 'Research'), hosted('cerebras', 'Billing')]);
  const withBilling = withActiveAccount(added, 'cloud-login:billing');
  assert.equal(startChatTarget(withBilling)?.account.label, 'Billing');
  assert.equal(withActiveAccount(added, 'cloud-login:missing'), added);

  const openai = display('openai', [localProvider('openai-codex', [option('Work', true)])], [hosted('openai', 'Team')]);
  assert.equal(withActiveAccount(openai, 'cloud-login:team'), openai);
  assert.equal(startChatTarget(openai)?.account.label, 'Work');
});

test('an active hosted account shows Active, and other hosted accounts show Hosted', () => {
  const provider = withActiveAccount(display('cerebras', [], [hosted('cerebras', 'Research'), hosted('cerebras', 'Billing')]), 'cloud-login:research');
  const markup = renderToStaticMarkup(createElement(AuthSavedAccounts, {
    provider,
    recentlyAdded: ['cloud-login:research'],
    onSelectAuthChoice: () => {},
    onRemoveAuthProfile: () => {},
  }));
  const research = markup.slice(markup.indexOf('aria-label="Research"'), markup.indexOf('aria-label="Billing"'));
  const billing = markup.slice(markup.indexOf('aria-label="Billing"'));
  assert.match(research, />Added</);
  assert.match(research, />Active</);
  assert.doesNotMatch(research, />Hosted</);
  assert.match(billing, />Hosted</);
  assert.doesNotMatch(billing, />Active</);
});

test('adding an account returns to the provider page instead of staying on the form', () => {
  const read = (file: string) => readFileSync(new URL(`../src/kordi-app/auth/${file}`, import.meta.url), 'utf8');
  const customApi = read('AuthCustomApiSetup.tsx');
  const loginPage = read('AuthLoginPage.tsx');
  const detail = read('AuthProviderDetail.tsx');
  const page = read('AuthPage.tsx');
  assert.doesNotMatch(customApi, /Key saved|Choose a model below/);
  assert.match(customApi, /onSaved\?\.\(authChoice, \{ edited: Boolean\(account\) \}\)/);
  assert.match(customApi, /aria-label="Model ID" placeholder="deepseek-chat"/);
  assert.match(customApi, /payload: \{ apiKey: apiKey\.trim\(\), baseUrl: baseUrl\.trim\(\), model: model\.trim\(\) \}/);
  assert.match(detail, /onSaved=\{\(authChoice, \{ edited \}\) => \{ if \(!edited\) onAccountAdded\?\.\(authChoice\); navigate\(null\); \}\}/);
  // A finished sign-in shows its result briefly with Start chat and Done, then returns.
  assert.match(loginPage, /window\.setTimeout\(\(\) => onDoneRef\.current\(\), LOGIN_RETURN_DELAY_MS\)/);
  assert.match(loginPage, />Start chat<\/AuthActionButton>[\s\S]*>Done<\/AuthActionButton>/);
  // The provider page header carries Start chat; the gate also closes.
  assert.match(page, /detailHeader[\s\S]*Start chat/);
  assert.match(page, /if \(showHero\) onDismissGate\?\.\(\);[\s\S]*void onEnterChat\(chat\.model \?\? undefined, route\);/);
  // A hosted-only account's chat carries its route, so the turn runs on Kordi Cloud.
  assert.match(page, /chat\.model && chat\.account\.hosted\s*\? \{ model: chat\.model, authProvider: chat\.account\.providerId, authChoice: chat\.account\.value \}/);
  assert.doesNotMatch(detail, /Start chatting|Enter chat/);
});

test('a Custom API row shows its model, or asks for one with an edit action', () => {
  const provider = display('custom', [], [hosted('custom', 'Gateway', 'deepseek-chat'), hosted('custom', 'Legacy')]);
  const markup = renderToStaticMarkup(createElement(AuthSavedAccounts, {
    provider,
    onEdit: () => {},
    onSelectAuthChoice: () => {},
    onRemoveAuthProfile: () => {},
  }));
  const gateway = markup.slice(markup.indexOf('aria-label="Gateway"'), markup.indexOf('aria-label="Legacy"'));
  const legacy = markup.slice(markup.indexOf('aria-label="Legacy"'));
  assert.match(gateway, /Custom API · deepseek-chat · Hosted in your Kordi account/);
  assert.doesNotMatch(gateway, new RegExp(CUSTOM_MODEL_REQUIRED));
  assert.match(gateway, />Edit</);
  assert.match(legacy, new RegExp(CUSTOM_MODEL_REQUIRED));
  assert.match(legacy, />Edit</);
});
