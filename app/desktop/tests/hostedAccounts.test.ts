import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudProviderAuthSnapshot } from '../src/features/cloud/cloudAgentRuntimeTypes';
import { hostedAccountsState, publishHostedProviderSnapshots, reloadHostedAccounts } from '../src/features/cloud/hostedAccounts';

const snapshot: CloudProviderAuthSnapshot = {
  snapshotId: 'snapshot-1',
  provider: 'openai-codex',
  authChoice: 'cloud-login:work',
  label: 'Work',
  modelHint: null,
  createdAt: '2026-01-01T00:00:00Z',
  revokedAt: null,
};

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

test('a failed hosted account load retries with backoff until the list arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { publishHostedProviderSnapshots([]); });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return calls <= 2 ? null : [snapshot];
  };

  await reloadHostedAccounts(loader);
  assert.equal(calls, 1);
  assert.equal(hostedAccountsState().hasLoaded, true);
  assert.equal(hostedAccountsState().listed, false);
  assert.deepEqual(hostedAccountsState().accounts, []);

  t.mock.timers.tick(4_999);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  assert.equal(hostedAccountsState().listed, false);

  t.mock.timers.tick(14_999);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 3);
  assert.equal(hostedAccountsState().listed, true);
  assert.deepEqual(hostedAccountsState().accounts.map((account) => account.authChoice), ['cloud-login:work']);

  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(calls, 3);
});

test('a publish from the Authentication page cancels a pending retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { publishHostedProviderSnapshots([]); });
  let calls = 0;
  await reloadHostedAccounts(async () => { calls += 1; return null; });
  publishHostedProviderSnapshots([snapshot]);
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(calls, 1);
  assert.equal(hostedAccountsState().listed, true);
});
