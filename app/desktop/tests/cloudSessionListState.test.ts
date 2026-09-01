import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyCloudSyncEventsToSessionVisibility,
  type CloudSessionVisibilityState,
} from '../src/features/cloud/cloudDiffSync';
import type { CloudSyncEvent } from '../src/features/cloud/authClient';

function event(eventType: string, sessionId: string): CloudSyncEvent {
  return {
    eventId: `${eventType}:${sessionId}`,
    eventType,
    peerAccountId: null,
    messageId: null,
    payload: { sessionId },
    occurredAt: '2026-08-31T00:00:00Z',
  };
}

test('session list events keep archive stable and isolate preference transitions', () => {
  const initial: CloudSessionVisibilityState = {
    hiddenSessionIds: new Set(['session:archived']),
    deletedSessionIds: new Set(['session:deleted']),
    unreadSessionIds: new Set(['session:one']),
    pinnedSessionIds: new Set(['session:one']),
    mutedSessionIds: new Set(['session:one']),
    pinnedGroupSpaceIds: new Set(),
  };
  const next = applyCloudSyncEventsToSessionVisibility('acct_me', initial, [
    {
      ...event('message.upsert', 'session:archived'),
      payload: { sessionId: 'session:archived', message: {} },
    },
    event('session.unhidden', 'session:deleted'),
    event('session.hidden', 'session:one'),
    event('session.deleted', 'session:one'),
    event('group_space.pinned', 'session:group:mobile'),
  ]);

  assert.deepEqual([...next.hiddenSessionIds], ['session:archived']);
  assert.deepEqual([...next.deletedSessionIds], ['session:one']);
  assert.deepEqual([...next.pinnedSessionIds], []);
  assert.deepEqual([...next.mutedSessionIds], []);
  assert.deepEqual([...next.unreadSessionIds], []);
  assert.deepEqual([...next.pinnedGroupSpaceIds], ['session:group:mobile']);
});

test('manual unread and group pin events synchronize account preferences', () => {
  const empty: CloudSessionVisibilityState = {
    hiddenSessionIds: new Set(),
    deletedSessionIds: new Set(),
    unreadSessionIds: new Set(),
    pinnedSessionIds: new Set(),
    mutedSessionIds: new Set(),
    pinnedGroupSpaceIds: new Set(),
  };
  const selected = applyCloudSyncEventsToSessionVisibility('acct_me', empty, [
    event('session.marked_unread', 'session:one'),
    event('group_space.pinned', 'session:group:mobile'),
  ]);
  assert.deepEqual([...selected.unreadSessionIds], ['session:one']);
  assert.deepEqual([...selected.pinnedGroupSpaceIds], ['session:group:mobile']);

  const cleared = applyCloudSyncEventsToSessionVisibility('acct_me', selected, [
    event('session.unmarked_unread', 'session:one'),
    event('group_space.unpinned', 'session:group:mobile'),
  ]);
  assert.deepEqual([...cleared.unreadSessionIds], []);
  assert.deepEqual([...cleared.pinnedGroupSpaceIds], []);
});
