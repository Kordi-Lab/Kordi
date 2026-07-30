import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CanonicalSessionState,
} from '../src/kordi-app/types';
import {
  patchCanonicalCloudUnreadCounts,
} from '../src/features/cloud/cloudUnreadReconciliation';

function stateWithUnread(
  cloudUnreadCount?: number,
): CanonicalSessionState {
  return {
    sessions: [{
      id: 'session:one',
      kind: 'group',
      title: 'One',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 1,
      metadata:
        cloudUnreadCount === undefined
          ? { stable: true }
          : { stable: true, cloudUnreadCount },
    }],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp',
      humanIdentityId: 'human:me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;
}

test('unread reconciliation preserves state identity when unchanged', () => {
  const state = stateWithUnread(3);
  assert.equal(
    patchCanonicalCloudUnreadCounts(
      state,
      { 'session:one': 3 },
    ),
    state,
  );
});

test('unread reconciliation updates and clears only Cloud unread metadata', () => {
  const state = stateWithUnread();
  const unread = patchCanonicalCloudUnreadCounts(
    state,
    { 'session:one': 4 },
  );
  assert.deepEqual(
    unread?.sessions[0]?.metadata,
    { stable: true, cloudUnreadCount: 4 },
  );

  const cleared = patchCanonicalCloudUnreadCounts(unread, {});
  assert.deepEqual(
    cleared?.sessions[0]?.metadata,
    { stable: true },
  );
});
