import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAuthSnapshotState } from '../src/kordi-app/auth/authSnapshotState';
import { hostedAccountsState, publishHostedProviderSnapshots } from '../src/features/cloud/hostedAccounts';
import type { DisplayAuthSnapshot } from '../src/kordi-app/auth/ompCatalog';

const completed: DisplayAuthSnapshot = {
  snapshotId: 'snap_completed',
  provider: 'openai-codex',
  authChoice: 'cloud-login:opaque',
  label: 'Personal',
  loginMethod: 'sign-in',
  createdAt: '2026-01-01T00:00:00Z',
  revokedAt: null,
};

test('completed login reaches composer accounts even when the follow-up refresh fails', async () => {
  publishHostedProviderSnapshots([]);
  const state = createAuthSnapshotState(publishHostedProviderSnapshots);
  state.complete(completed);
  await assert.rejects(state.refresh(() => Promise.reject(new Error('offline'))));

  assert.deepEqual(state.current(), [completed]);
  assert.deepEqual(hostedAccountsState().accounts.map((account) => ({
    provider: account.provider, authChoice: account.authChoice, label: account.label,
  })), [{ provider: 'openai-codex', authChoice: 'cloud-login:opaque', label: 'Personal' }]);
  publishHostedProviderSnapshots([]);
});

test('an older empty load cannot erase a completed login', async () => {
  let resolveLoad: (value: DisplayAuthSnapshot[]) => void = () => {};
  const state = createAuthSnapshotState(() => {});
  const pending = state.refresh(() => new Promise((resolve) => { resolveLoad = resolve; }));
  state.complete(completed);
  resolveLoad([]);
  await pending;
  assert.deepEqual(state.current(), [completed]);
});
