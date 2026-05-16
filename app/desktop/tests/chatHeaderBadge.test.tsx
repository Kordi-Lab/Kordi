import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudSelfAgentSyncStatusLabel, shouldShowConversationTypeBadge } from '../src/pages/ChatsPage';

test('chat header hides the My agent badge for canonical group sessions', () => {
  assert.equal(shouldShowConversationTypeBadge({
    id: 'session:group:342f31b1-534d-4f3b-b4bd-855072767854',
    canonicalSessionId: 'session:group:342f31b1-534d-4f3b-b4bd-855072767854',
    type: 'owned-agent',
  }), false);
});

test('chat header hides the My agent badge for forks of canonical group sessions', () => {
  assert.equal(shouldShowConversationTypeBadge({
    id: 'session:fork:606437914b634d4490e509a7916fbb72',
    canonicalSessionId: 'session:fork:606437914b634d4490e509a7916fbb72',
    type: 'owned-agent',
    forkedFromSessionId: 'session:group:c0865259-a991-48bf-9752-56daf674e4f9',
  }), false);
});

test('chat header keeps the My agent badge for true self-agent sessions', () => {
  assert.equal(shouldShowConversationTypeBadge({
    id: '4367e286-afb4-4941-b0cb-7d644b0f6ce6',
    canonicalSessionId: '4367e286-afb4-4941-b0cb-7d644b0f6ce6',
    type: 'owned-agent',
  }), true);
});

test('chat header cloud self-agent sync label is concise and stable', () => {
  assert.equal(cloudSelfAgentSyncStatusLabel(undefined), null);
  assert.equal(cloudSelfAgentSyncStatusLabel({ state: 'syncing', pendingCount: 2 }), 'Syncing 2');
  assert.equal(cloudSelfAgentSyncStatusLabel({ state: 'synced' }), 'Synced');
  assert.equal(cloudSelfAgentSyncStatusLabel({ state: 'error', message: 'network failed' }), 'Sync issue');
});
