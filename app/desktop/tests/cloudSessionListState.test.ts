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
    pinnedSessionIds: new Set(['session:one']),
    mutedSessionIds: new Set(['session:one']),
  };
  const next = applyCloudSyncEventsToSessionVisibility('acct_me', initial, [
    {
      ...event('message.upsert', 'session:archived'),
      payload: { sessionId: 'session:archived', message: {} },
    },
    event('session.unhidden', 'session:deleted'),
    event('session.hidden', 'session:one'),
    event('session.deleted', 'session:one'),
  ]);

  assert.deepEqual([...next.hiddenSessionIds], ['session:archived']);
  assert.deepEqual([...next.deletedSessionIds], ['session:one']);
  assert.deepEqual([...next.pinnedSessionIds], []);
  assert.deepEqual([...next.mutedSessionIds], []);
});
