import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPresenceSnapshot,
  cloudPresenceChangedFromWsPayload,
  mergePresenceEvent,
  presenceStatusForAccount,
  shouldRefreshPresenceForWsSubject,
} from '../src/features/cloud/presence';

test('presence snapshot stores account statuses by account id', () => {
  const snapshot = applyPresenceSnapshot({}, {
    accounts: [
      { accountId: 'acct_1', status: 'online', updatedAt: '2026-05-23T00:00:00Z' },
      { accountId: 'acct_2', status: 'offline', updatedAt: '2026-05-23T00:01:00Z' },
    ],
  });
  assert.equal(presenceStatusForAccount(snapshot, 'acct_1'), 'online');
  assert.equal(presenceStatusForAccount(snapshot, 'acct_2'), 'offline');
  assert.equal(presenceStatusForAccount(snapshot, 'acct_missing'), 'offline');
});

test('presence websocket event updates a single account', () => {
  const next = mergePresenceEvent({}, { accountId: 'acct_1', status: 'online', updatedAt: '2026-05-23T00:00:00Z' });
  assert.equal(next.acct_1?.status, 'online');
});

test('presence subject and payload parser recognize account changes', () => {
  assert.equal(shouldRefreshPresenceForWsSubject('kordi.events.presence.account.acct_1'), true);
  assert.equal(shouldRefreshPresenceForWsSubject('kordi.events.message.arrived.acct_1'), false);
  assert.deepEqual(cloudPresenceChangedFromWsPayload({ account_id: 'acct_1', status: 'online', occurred_at: 'now' }), {
    accountId: 'acct_1',
    status: 'online',
    updatedAt: 'now',
  });
});
