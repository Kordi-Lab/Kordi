import assert from 'node:assert/strict';
import { test } from 'node:test';

import { syncCreatedFork } from '../src/app/useKordiCloudAgentFork';
import type { CloudAccount } from '../src/features/cloud/authClient';

const fork = { forkedSessionId: 'session:fork:new', sourceSessionId: 'session:source', sourceMessageId: 'msg:source' };

test('a new fork reloads the session catalog before recording Cloud lineage', async () => {
  const calls: string[] = [];
  await syncCreatedFork(fork, {
    account: { accountId: 'acct:test' } as CloudAccount,
    refreshCanonicalState: async () => { calls.push('refresh'); },
    recordCloudSessionFork: (async (input: { forkSessionId: string }) => { calls.push(`record:${input.forkSessionId}`); }) as never,
  });
  assert.deepEqual(calls, ['refresh', 'record:session:fork:new']);
});

test('a fork without a Cloud account still reloads the session catalog', async () => {
  const calls: string[] = [];
  await syncCreatedFork(fork, {
    account: null,
    refreshCanonicalState: async () => { calls.push('refresh'); },
    recordCloudSessionFork: (async () => { calls.push('record'); }) as never,
  });
  assert.deepEqual(calls, ['refresh']);
});

test('a failed catalog reload does not block Cloud lineage', async () => {
  const calls: string[] = [];
  await syncCreatedFork(fork, {
    account: { accountId: 'acct:test' } as CloudAccount,
    refreshCanonicalState: async () => { throw new Error('catalog unavailable'); },
    recordCloudSessionFork: (async () => { calls.push('record'); }) as never,
  });
  assert.deepEqual(calls, ['record']);
});
