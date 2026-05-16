import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import {
  applyCloudSyncEventsToMessagesByPeer,
  applyCloudSyncEventsToSessionActivity,
  applyCloudSyncEventsToSessionForks,
  cloudSyncCursorStorageKey,
  loadCloudSyncCursor,
  saveCloudSyncCursor,
  syncCloudDiffOnce,
  type CloudSyncEvent,
} from '../src/features/cloud/cloudDiffSync';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  };
}

const incoming: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello',
  createdAt: '2026-05-13T00:00:00Z',
  deliveredAt: '2026-05-13T00:00:00Z',
  readAt: null,
  direction: 'incoming',
};

test('applyCloudSyncEventsToMessagesByPeer upserts messages idempotently by messageId', () => {
  const event: CloudSyncEvent = {
    eventId: '10',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: 'msg_1',
    payload: { message: incoming },
    occurredAt: '2026-05-13T00:00:00Z',
  };

  const once = applyCloudSyncEventsToMessagesByPeer('acct_me', {}, [event]);
  const twice = applyCloudSyncEventsToMessagesByPeer('acct_me', once, [event]);

  assert.deepEqual(twice, { acct_peer: [incoming] });
});

test('applyCloudSyncEventsToMessagesByPeer applies read receipts to cached messages', () => {
  const result = applyCloudSyncEventsToMessagesByPeer('acct_me', { acct_peer: [incoming] }, [{
    eventId: '11',
    eventType: 'message.read',
    peerAccountId: 'acct_peer',
    messageId: null,
    payload: {
      readerAccountId: 'acct_peer',
      messageIds: ['msg_1'],
      readAt: '2026-05-13T00:01:00Z',
    },
    occurredAt: '2026-05-13T00:01:00Z',
  }]);

  assert.equal(result.acct_peer[0]?.readAt, '2026-05-13T00:01:00Z');
  assert.equal(result.acct_peer[0]?.deliveredAt, '2026-05-13T00:00:00Z');
});

test('cloud diff sync applies session fork events', () => {
  const next = applyCloudSyncEventsToSessionForks({}, [{
    eventId: '1',
    eventType: 'session-forked',
    peerAccountId: null,
    messageId: null,
    occurredAt: '2026-05-16T08:41:00Z',
    payload: {
      forkSessionId: 'session:fork:child',
      parentSessionId: 'session:parent',
      parentMessageId: 'msg:parent',
      createdByAccountId: 'acct_me',
      createdAt: '2026-05-16T08:41:00Z',
    },
  }]);

  assert.deepEqual(next['session:fork:child'], {
    forkSessionId: 'session:fork:child',
    parentSessionId: 'session:parent',
    parentMessageId: 'msg:parent',
    createdByAccountId: 'acct_me',
    createdAt: '2026-05-16T08:41:00Z',
  });
});

test('cloud diff sync applies task and artifact upsert events', () => {
  const next = applyCloudSyncEventsToSessionActivity({ tasksBySessionId: {}, artifactsBySessionId: {} }, [{
    eventId: '1',
    eventType: 'task.upsert',
    peerAccountId: null,
    messageId: null,
    occurredAt: '2026-05-15T10:00:00Z',
    payload: { task: { taskActivityId: 'taskact_1', sessionId: 'session:group:1', taskId: 'task-1', title: 'Review', summary: null, status: 'active', createdByAccountId: 'acct_a', targetAccountId: null, participants: [], artifactIds: [], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null } },
  }, {
    eventId: '2',
    eventType: 'artifact.upsert',
    peerAccountId: null,
    messageId: null,
    occurredAt: '2026-05-15T10:00:00Z',
    payload: { artifact: { artifactActivityId: 'artifactact_1', sessionId: 'session:group:1', artifactId: 'docs/a.md', name: 'a.md', path: 'docs/a.md', kind: 'document', category: 'artifact', summary: null, createdByAccountId: 'acct_a', sourceMessageId: null, attachmentId: null, contentType: null, sizeBytes: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null } },
  }]);

  assert.equal(next.tasksBySessionId['session:group:1']?.[0]?.taskId, 'task-1');
  assert.equal(next.artifactsBySessionId['session:group:1']?.[0]?.artifactId, 'docs/a.md');
});

test('cloud sync cursor storage is per account', () => {
  const storage = memoryStorage();
  saveCloudSyncCursor('acct_me', '42', storage);

  assert.equal(cloudSyncCursorStorageKey('acct_me'), 'kordi.cloud.syncCursor.v1:acct_me');
  assert.equal(loadCloudSyncCursor('acct_me', storage), '42');
  assert.equal(loadCloudSyncCursor('acct_other', storage), '0');
});

test('syncCloudDiffOnce advances cursor only after applying events', async () => {
  const storage = memoryStorage();
  const calls: string[] = [];
  const result = await syncCloudDiffOnce({
    accountId: 'acct_me',
    cursorStorage: storage,
    messagesByPeer: {},
    fetchEvents: async (cursor) => {
      calls.push(cursor);
      return {
        cursor: '10',
        hasMore: false,
        events: [{
          eventId: '10',
          eventType: 'message.upsert',
          peerAccountId: 'acct_peer',
          messageId: 'msg_1',
          payload: { message: incoming },
          occurredAt: '2026-05-13T00:00:00Z',
        }, {
          eventId: '11',
          eventType: 'task.upsert',
          peerAccountId: null,
          messageId: null,
          payload: { task: { taskActivityId: 'taskact_1', sessionId: 'session:group:1', taskId: 'task-1', title: 'Review', summary: null, status: 'active', createdByAccountId: 'acct_a', targetAccountId: null, participants: [], artifactIds: [], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null } },
          occurredAt: '2026-05-15T10:00:00Z',
        }],
      };
    },
  });

  assert.deepEqual(calls, ['0']);
  assert.equal(loadCloudSyncCursor('acct_me', storage), '10');
  assert.deepEqual(result.messagesByPeer, { acct_peer: [incoming] });
  assert.equal(result.sessionActivity.tasksBySessionId['session:group:1']?.[0]?.taskId, 'task-1');
  assert.equal(result.fallbackRequired, false);
});

test('syncCloudDiffOnce requests fallback for invalid cursors without advancing local cursor', async () => {
  const storage = memoryStorage();
  saveCloudSyncCursor('acct_me', '42', storage);

  const result = await syncCloudDiffOnce({
    accountId: 'acct_me',
    cursorStorage: storage,
    messagesByPeer: {},
    fetchEvents: async () => ({ cursor: '0', hasMore: false, events: [] }),
  });

  assert.equal(result.fallbackRequired, true);
  assert.equal(loadCloudSyncCursor('acct_me', storage), '42');
});
