import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { applyCloudSyncEventsToMessagesByPeer } from '../src/features/cloud/cloudDiffSyncMessages';
import { mergeCloudMessagesByPeerSnapshot } from '../src/features/cloud/cloudMessageSyncState';

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

test('chat sync keeps message lifecycle metadata for in-place call updates', () => {
  const updated = applyCloudSyncEventsToMessagesByPeer('acct_me', {}, [{
    eventId: 'event-call-ended',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: 'msg_call',
    occurredAt: '2026-05-11T10:00:00Z',
    payload: {
      message: {
        ...message,
        messageId: 'msg_call',
        sessionId: 'session:group:friends',
        conversationId: 'conversation-call',
        conversationSequence: 6,
        clientMessageId: 'call-id',
        messageKind: 'call.ended.call-id',
        version: 2,
      },
    },
  }]);

  assert.deepEqual(updated.acct_peer?.[0], {
    ...message,
    messageId: 'msg_call',
    sessionId: 'session:group:friends',
    conversationId: 'conversation-call',
    conversationSequence: 6,
    clientMessageId: 'call-id',
    messageKind: 'call.ended.call-id',
    version: 2,
  });
});

test('chat sync removes deleted messages without disturbing their peers', () => {
  const current = {
    acct_peer: [message, { ...message, messageId: 'msg_keep', body: 'keep' }],
  };
  const updated = applyCloudSyncEventsToMessagesByPeer('acct_me', current, [{
    eventId: 'event-delete',
    eventType: 'message.deleted',
    peerAccountId: 'acct_peer',
    messageId: message.messageId,
    occurredAt: '2026-05-11T10:01:00Z',
    payload: { messageId: message.messageId },
  }]);

  assert.deepEqual(updated.acct_peer?.map((item) => item.messageId), ['msg_keep']);
});

test('published sync state does not merge a remotely deleted message back in', () => {
  const current = {
    acct_peer: [message, { ...message, messageId: 'msg_keep', body: 'keep' }],
  };
  const incoming = {
    acct_peer: [{ ...message, messageId: 'msg_keep', body: 'keep' }],
  };

  const merged = mergeCloudMessagesByPeerSnapshot(
    current,
    incoming,
    new Set([message.messageId]),
  );

  assert.deepEqual(merged.acct_peer?.map((item) => item.messageId), ['msg_keep']);
});
