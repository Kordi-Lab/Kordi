import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import type { CloudAgentDefinition } from '../src/features/cloud/cloudAgents';
import {
  applyCloudSyncEventsToMessagesByPeer,
  applyCloudSyncEventsToSessionActivity,
  applyCloudSyncEventsToSessionForks,
  applyCloudSyncEventsToSessionPins,
  applyCloudSyncEventsToSessionTitles,
  cloudSessionVisibilityStorageKey,
  cloudSyncCursorStorageKey,
  loadCloudSessionVisibility,
  loadCloudSyncCursor,
  mergeCloudMessageMonotonicState,
  saveCloudSessionVisibility,
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

test('session title sync events restore explicit source and revision metadata', () => {
  const titles = applyCloudSyncEventsToSessionTitles({}, [{
    eventId: '12',
    eventType: 'session.title.updated',
    peerAccountId: 'session:self-agent:one',
    messageId: 'msg_seed',
    payload: {
      sessionTitle: {
        sessionId: 'session:self-agent:one',
        title: 'Diagnose high Node CPU',
        titleSource: 'manual',
        titleRevision: 3,
        titlePolicyVersion: 1,
        titleGeneratedFromMessageId: 'msg_seed',
        updatedAtMs: 123,
        updatedByAccountId: 'acct_me',
        updatedAt: '2026-07-16T00:00:00Z',
      },
    },
    occurredAt: '2026-07-16T00:00:00Z',
  }]);

  assert.equal(titles['session:self-agent:one']?.title, 'Diagnose high Node CPU');
  assert.equal(titles['session:self-agent:one']?.titleSource, 'manual');
  assert.equal(titles['session:self-agent:one']?.titleRevision, 3);
});

test('historical message upserts cannot regress authoritative delivery and read receipts', () => {
  const authoritative: CloudMessage = {
    ...incoming,
    deliveredAt: '2026-05-13T00:02:00Z',
    readAt: '2026-05-13T00:03:00Z',
  };
  const staleEvent: CloudSyncEvent = {
    eventId: '9',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: incoming.messageId,
    payload: {
      message: {
        ...incoming,
        deliveredAt: null,
        readAt: null,
      },
    },
    occurredAt: '2026-05-13T00:00:00Z',
  };

  const result = applyCloudSyncEventsToMessagesByPeer(
    'acct_me',
    { acct_peer: [authoritative] },
    [staleEvent],
  );

  assert.equal(result.acct_peer?.[0]?.deliveredAt, authoritative.deliveredAt);
  assert.equal(result.acct_peer?.[0]?.readAt, authoritative.readAt);
  assert.equal(mergeCloudMessageMonotonicState(authoritative, {
    ...incoming,
    deliveredAt: '2026-05-13T00:01:00Z',
    readAt: '2026-05-13T00:01:30Z',
  }).readAt, authoritative.readAt);
});

test('message diff events preserve bounded previews but discard local original-file state', () => {
  const result = applyCloudSyncEventsToMessagesByPeer('acct_me', {}, [{
    eventId: '11',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: 'msg_preview',
    payload: {
      message: {
        ...incoming,
        messageId: 'msg_preview',
        attachments: [{
          attachmentId: 'att_original',
          previewAttachmentId: 'att_preview',
          name: 'photo.png',
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: 100,
          previewUrl: 'data:image/webp;base64,legacy',
          localPath: '/tmp/original.png',
        }],
      },
    },
    occurredAt: '2026-05-13T00:01:00Z',
  }]);

  assert.deepEqual(result.acct_peer?.[0]?.attachments, [{
    attachmentId: 'att_original',
    previewAttachmentId: 'att_preview',
    name: 'photo.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 100,
    previewUrl: 'data:image/webp;base64,legacy',
  }]);
});

test('applyCloudSyncEventsToMessagesByPeer revives a removed session when a new message arrives', () => {
  const removedMessage: CloudMessage = {
    ...incoming,
    messageId: 'msg_removed_update',
    sessionId: 'session:removed',
  };

  const result = applyCloudSyncEventsToMessagesByPeer('acct_me', {}, [{
    eventId: '12',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: 'msg_removed_update',
    payload: { message: removedMessage },
    occurredAt: '2026-05-13T00:02:00Z',
  }], new Set(), new Set(['session:removed']));

  assert.deepEqual(result, { acct_peer: [removedMessage] });
});

test('applyCloudSyncEventsToMessagesByPeer removes cached messages for deleted sessions', () => {
  const deletedMessage: CloudMessage = {
    ...incoming,
    messageId: 'msg_deleted',
    sessionId: 'session:deleted',
  };

  const result = applyCloudSyncEventsToMessagesByPeer('acct_me', { acct_peer: [deletedMessage] }, [{
    eventId: '13',
    eventType: 'session.deleted',
    peerAccountId: 'session:deleted',
    messageId: null,
    payload: { sessionId: 'session:deleted', deletedAt: '2026-05-13T00:03:00Z' },
    occurredAt: '2026-05-13T00:03:00Z',
  }], new Set(), new Set());

  assert.deepEqual(result, {});
});

test('applyCloudSyncEventsToMessagesByPeer shows updates that arrive after a remove event in the same sync batch', () => {
  const updatedMessage: CloudMessage = {
    ...incoming,
    messageId: 'msg_batch_update',
    sessionId: 'session:batch-removed',
  };

  const result = applyCloudSyncEventsToMessagesByPeer('acct_me', {}, [{
    eventId: '14',
    eventType: 'session.deleted',
    peerAccountId: 'session:batch-removed',
    messageId: null,
    payload: { sessionId: 'session:batch-removed', deletedAt: '2026-05-13T00:04:00Z' },
    occurredAt: '2026-05-13T00:04:00Z',
  }, {
    eventId: '15',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: 'msg_batch_update',
    payload: { message: updatedMessage },
    occurredAt: '2026-05-13T00:04:01Z',
  }], new Set(), new Set());

  assert.deepEqual(result, { acct_peer: [updatedMessage] });
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

test('cloud diff sync applies shared session pin update events', () => {
  const next = applyCloudSyncEventsToSessionPins({}, [{
    eventId: '20',
    eventType: 'session.pin.updated',
    peerAccountId: 'session:group:1',
    messageId: 'msg:group:visible',
    occurredAt: '2026-06-11T20:00:00Z',
    payload: {
      sessionId: 'session:group:1',
      messageId: 'msg:group:visible',
      scope: 'shared',
      updatedByAccountId: 'acct_a',
      updatedAt: '2026-06-11T20:00:00Z',
    },
  }]);

  assert.deepEqual(next['session:group:1'], {
    sessionId: 'session:group:1',
    sharedMessageId: 'msg:group:visible',
    privateMessageId: null,
    effectiveMessageId: 'msg:group:visible',
    updatedAt: '2026-06-11T20:00:00Z',
  });
});

test('cloud diff sync applies shared session unpin update events', () => {
  const next = applyCloudSyncEventsToSessionPins({
    'session:group:1': {
      sessionId: 'session:group:1',
      sharedMessageId: 'msg:old',
      privateMessageId: null,
      effectiveMessageId: 'msg:old',
      updatedAt: '2026-06-11T19:00:00Z',
    },
  }, [{
    eventId: '21',
    eventType: 'session.pin.updated',
    peerAccountId: 'session:group:1',
    messageId: null,
    occurredAt: '2026-06-11T20:01:00Z',
    payload: {
      sessionId: 'session:group:1',
      messageId: null,
      scope: 'shared',
      updatedByAccountId: 'acct_a',
      updatedAt: '2026-06-11T20:01:00Z',
    },
  }]);

  assert.deepEqual(next['session:group:1'], {
    sessionId: 'session:group:1',
    sharedMessageId: null,
    privateMessageId: null,
    effectiveMessageId: null,
    updatedAt: '2026-06-11T20:01:00Z',
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

test('cloud session visibility storage is per account and restores removed sessions synchronously', () => {
  const storage = memoryStorage();
  saveCloudSessionVisibility('acct_me', {
    hiddenSessionIds: new Set(['session:hidden']),
    deletedSessionIds: new Set(['session:removed']),
  }, storage);
  saveCloudSessionVisibility('acct_other', {
    hiddenSessionIds: new Set(),
    deletedSessionIds: new Set(['session:other']),
  }, storage);

  assert.equal(cloudSessionVisibilityStorageKey('acct_me'), 'kordi.cloud.sessionVisibility.v1:acct_me');
  assert.deepEqual([...loadCloudSessionVisibility('acct_me', storage).hiddenSessionIds], ['session:hidden']);
  assert.deepEqual([...loadCloudSessionVisibility('acct_me', storage).deletedSessionIds], ['session:removed']);
  assert.deepEqual([...loadCloudSessionVisibility('acct_other', storage).deletedSessionIds], ['session:other']);
});

test('cloud sync cursor storage is per account', () => {
  const storage = memoryStorage();
  saveCloudSyncCursor('acct_me', '42', storage);
  saveCloudSyncCursor('acct_other', '7', storage);

  assert.equal(cloudSyncCursorStorageKey('acct_me'), 'kordi.cloud.syncCursor.v1:acct_me');
  assert.equal(cloudSyncCursorStorageKey('acct_other'), 'kordi.cloud.syncCursor.v1:acct_other');
  assert.equal(loadCloudSyncCursor('acct_me', storage), '42');
  assert.equal(loadCloudSyncCursor('acct_other', storage), '7');
  saveCloudSyncCursor('acct_me', '84', storage);
  assert.equal(loadCloudSyncCursor('acct_me', storage), '84');
  assert.equal(loadCloudSyncCursor('acct_other', storage), '7');
});

test('syncCloudDiffOnce returns updated hidden and deleted visibility sets', async () => {
  const storage = memoryStorage();
  const result = await syncCloudDiffOnce({
    accountId: 'acct_me',
    cursorStorage: storage,
    messagesByPeer: {},
    fetchEvents: async () => ({
      cursor: '12',
      hasMore: false,
      events: [{
        eventId: '11',
        eventType: 'session.hidden',
        peerAccountId: 'session:hidden',
        messageId: null,
        payload: { sessionId: 'session:hidden', hiddenAt: '2026-05-13T00:04:00Z' },
        occurredAt: '2026-05-13T00:04:00Z',
      }, {
        eventId: '12',
        eventType: 'session.deleted',
        peerAccountId: 'session:deleted',
        messageId: null,
        payload: { sessionId: 'session:deleted', deletedAt: '2026-05-13T00:05:00Z' },
        occurredAt: '2026-05-13T00:05:00Z',
      }],
    }),
  });

  assert.equal(loadCloudSyncCursor('acct_me', storage), '12');
  assert.deepEqual([...result.hiddenSessionIds], ['session:hidden']);
  assert.deepEqual([...result.deletedSessionIds], ['session:deleted']);
});

test('syncCloudDiffOnce clears removed visibility when a later message update arrives', async () => {
  const storage = memoryStorage();
  const updatedMessage: CloudMessage = {
    ...incoming,
    messageId: 'msg_removed_later',
    sessionId: 'session:removed-later',
  };

  const result = await syncCloudDiffOnce({
    accountId: 'acct_me',
    cursorStorage: storage,
    messagesByPeer: {},
    deletedSessionIds: new Set(['session:removed-later']),
    fetchEvents: async () => ({
      cursor: '13',
      hasMore: false,
      events: [{
        eventId: '13',
        eventType: 'message.upsert',
        peerAccountId: 'acct_peer',
        messageId: 'msg_removed_later',
        payload: { message: updatedMessage },
        occurredAt: '2026-05-13T00:06:00Z',
      }],
    }),
  });

  assert.deepEqual(result.messagesByPeer, { acct_peer: [updatedMessage] });
  assert.deepEqual([...result.deletedSessionIds], []);
});

test('syncCloudDiffOnce applies cloud agent definition events', async () => {
  const storage = memoryStorage();
  const cloudAgent: CloudAgentDefinition = {
    agentId: 'cloud_agent_abc',
    ownerAccountId: 'acct_me',
    accessScope: 'private',
    status: 'active',
    name: 'Docs Helper',
    role: 'Technical Support Agent',
    description: null,
    systemPrompt: 'Use docs only.',
    sourceSummary: 'Docs helper',
    boundaries: [],
    resources: [],
    skills: [],
    modelRouting: {},
    createdAt: '2026-06-18T00:00:00Z',
    updatedAt: '2026-06-18T00:00:00Z',
    archivedAt: null,
  };

  const result = await syncCloudDiffOnce({
    accountId: 'acct_me',
    cursorStorage: storage,
    messagesByPeer: {},
    cloudAgentsById: {},
    fetchEvents: async () => ({
      cursor: '31',
      hasMore: false,
      events: [{
        eventId: '30',
        eventType: 'agent.definition.upserted',
        peerAccountId: null,
        messageId: null,
        payload: { agent: cloudAgent },
        occurredAt: '2026-06-18T00:01:00Z',
      }],
    }),
  });

  assert.equal(result.cloudAgentsById.cloud_agent_abc?.name, 'Docs Helper');
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

test('syncCloudDiffOnce does not advance a cursor after its account generation expires', async () => {
  const storage = memoryStorage();
  const result = await syncCloudDiffOnce({
    accountId: 'acct_old',
    cursorStorage: storage,
    messagesByPeer: {},
    shouldSaveCursor: () => false,
    fetchEvents: async () => ({ cursor: '10', hasMore: false, events: [] }),
  });

  assert.equal(result.cursor, '10');
  assert.equal(loadCloudSyncCursor('acct_old', storage), '0');
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
