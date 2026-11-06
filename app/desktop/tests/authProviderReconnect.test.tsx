import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { hostedAccountsFromSnapshots } from '../src/features/cloud/hostedAccounts';
import type { CloudProviderAuthSnapshot } from '../src/features/cloud/cloudAgentRuntimeTypes';
import { isOpaqueAccountLabel, readableAccountLabel } from '../src/kordi-app/auth/accountLabel';
import { AuthProviderList } from '../src/kordi-app/auth/AuthProviderList';
import { providerReconnectLabel } from '../src/kordi-app/auth/providerReconnect';
import { buildOmpDisplayProviders, loadPinnedOmpCatalog } from '../src/kordi-app/auth/ompCatalog';

const ACCOUNT_ID = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
const catalog = await loadPinnedOmpCatalog();

function snapshot(authChoice: string, label: string | null, status?: string): CloudProviderAuthSnapshot {
  return {
    snapshotId: `snap_${authChoice.replace(/\W/g, '')}`, provider: 'openai-codex', authChoice, label, modelHint: null,
    createdAt: '2026-10-26T19:33:05Z', revokedAt: null, ...(status ? { status } : {}),
  } as CloudProviderAuthSnapshot;
}

test('an account named only by its provider account ID reads as the provider and the day it was saved', () => {
  assert.equal(isOpaqueAccountLabel(ACCOUNT_ID), true);
  assert.equal(isOpaqueAccountLabel('Work'), false);
  assert.equal(readableAccountLabel(ACCOUNT_ID, 'ChatGPT Plus/Pro (Codex Subscription)', '2026-10-26T19:33:05Z', 'UTC'), 'ChatGPT account · Oct 26');
  assert.equal(readableAccountLabel(ACCOUNT_ID, null, '2026-10-26T19:33:05Z', 'UTC'), 'Saved account · Oct 26');
  assert.equal(readableAccountLabel(ACCOUNT_ID, 'ChatGPT', 'not a date'), 'ChatGPT account');
  assert.equal(readableAccountLabel(' Work ', 'ChatGPT', null), 'Work');
  assert.equal(readableAccountLabel('  ', 'ChatGPT', null), null);
});

test('saved account lists never show a raw account ID as the name', () => {
  const { providers } = buildOmpDisplayProviders({ authPath: '', hasAnyAuth: true, providers: [] },
    [snapshot('profile:openai-codex-a', ACCOUNT_ID), snapshot('cloud-login:b', 'Work')], catalog.providers);
  const labels = providers.flatMap((provider) => provider.methods.flatMap((method) => method.options.map((option) => option.label)));
  assert.ok(labels.includes('Work'));
  assert.ok(!labels.includes(ACCOUNT_ID));
  assert.ok(labels.some((label) => /^ChatGPT account · Oct (26|27)$/.test(label)), labels.join(', '));
  const hosted = hostedAccountsFromSnapshots([snapshot('profile:openai-codex-a', ACCOUNT_ID)]);
  assert.notEqual(hosted[0].label, ACCOUNT_ID);
});

test('the reconnect status reads per provider', () => {
  assert.equal(providerReconnectLabel(0, 2), null);
  assert.equal(providerReconnectLabel(1, 1), 'Needs reconnecting');
  assert.equal(providerReconnectLabel(2, 2), 'All need reconnecting');
  assert.equal(providerReconnectLabel(1, 3), '1 needs reconnecting');
  assert.equal(providerReconnectLabel(2, 3), '2 need reconnecting');
});

test('the providers list shows which provider needs reconnecting', () => {
  const snapshots = [snapshot('profile:openai-codex-a', ACCOUNT_ID, 'needs-reconnect'), snapshot('cloud-login:b', 'Work', 'needs-reconnect')];
  const { providers } = buildOmpDisplayProviders({ authPath: '', hasAnyAuth: true, providers: [] }, snapshots, catalog.providers);
  const render = (needsReconnect: string[]) => renderToStaticMarkup(createElement(AuthProviderList, {
    providers, needsReconnect, onSelectProvider: () => undefined, onRefresh: () => undefined,
  }));
  const html = render(snapshots.map((item) => item.authChoice));
  assert.match(html, /2 accounts saved · <span[^>]*data-auth-provider-reconnect=""[^>]*>All need reconnecting<\/span>/);
  assert.doesNotMatch(render([]), /reconnecting/);
});
