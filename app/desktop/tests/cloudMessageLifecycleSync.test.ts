import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { applyCloudSyncEventsToMessagesByPeer } from '../src/features/cloud/cloudDiffSyncMessages';

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
