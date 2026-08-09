import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import {
  applyCloudSyncEventsToMessagesByPeer,
  type CloudSyncEvent,
} from '../src/features/cloud/cloudDiffSync';

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

test('message upsert replay preserves the Cloud message store identity', () => {
  const event: CloudSyncEvent = {
    eventId: '10',
    eventType: 'message.upsert',
    peerAccountId: 'acct_peer',
    messageId: incoming.messageId,
    payload: { message: incoming },
    occurredAt: incoming.createdAt,
  };
  const once = applyCloudSyncEventsToMessagesByPeer('acct_me', {}, [event]);
  const twice = applyCloudSyncEventsToMessagesByPeer('acct_me', once, [event]);

  assert.deepEqual(twice, { acct_peer: [incoming] });
  assert.equal(twice, once);
  assert.equal(twice.acct_peer, once.acct_peer);
  assert.equal(twice.acct_peer[0], once.acct_peer[0]);
});

test('duplicate and stale read receipts preserve the Cloud message store identity', () => {
  const readMessage: CloudMessage = { ...incoming, readAt: '2026-05-13T00:02:00Z' };
  const current = { acct_peer: [readMessage] };
  const receipt = (eventId: string, readAt: string): CloudSyncEvent => ({
    eventId,
    eventType: 'message.read',
    peerAccountId: 'acct_peer',
    messageId: null,
    payload: { readerAccountId: 'acct_peer', messageIds: ['msg_1'], readAt },
    occurredAt: readAt,
  });
  const duplicate = applyCloudSyncEventsToMessagesByPeer(
    'acct_me',
    current,
    [receipt('12', readMessage.readAt!)],
  );
  const stale = applyCloudSyncEventsToMessagesByPeer(
    'acct_me',
    duplicate,
    [receipt('13', '2026-05-13T00:01:00Z')],
  );

  assert.equal(duplicate, current);
  assert.equal(stale, current);
  assert.equal(stale.acct_peer, current.acct_peer);
  assert.equal(stale.acct_peer[0], readMessage);
});

test('deleting an unknown session preserves the Cloud message store identity', () => {
  const current = { acct_peer: [incoming] };
  const result = applyCloudSyncEventsToMessagesByPeer('acct_me', current, [{
    eventId: '14',
    eventType: 'session.deleted',
    peerAccountId: 'session:missing',
    messageId: null,
    payload: { sessionId: 'session:missing', deletedAt: '2026-05-13T00:03:00Z' },
    occurredAt: '2026-05-13T00:03:00Z',
  }]);

  assert.equal(result, current);
});

test('large Cloud history replay stays within the startup processing budget', () => {
  const messageCount = 10_000;
  const events: CloudSyncEvent[] = Array.from(
    { length: messageCount },
    (_, index) => {
      const sequence = messageCount - index;
      const suffix = String(sequence).padStart(5, '0');
      return {
        eventId: `event_${suffix}`,
        eventType: 'message.upsert',
        peerAccountId: 'acct_peer',
        messageId: `msg_${suffix}`,
        payload: {
          message: {
            ...incoming,
            messageId: `msg_${suffix}`,
            createdAt: `2026-05-13T00:00:${suffix}Z`,
          },
        },
        occurredAt: `2026-05-13T00:00:${suffix}Z`,
      };
    },
  );

  const startedAt = performance.now();
  const result = applyCloudSyncEventsToMessagesByPeer(
    'acct_me',
    {},
    events,
  );
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.acct_peer.length, messageCount);
  assert.equal(result.acct_peer[0]?.messageId, 'msg_00001');
  assert.equal(result.acct_peer.at(-1)?.messageId, 'msg_10000');
  assert.ok(
    elapsedMs < 2_000,
    `expected 10,000 replay events to settle within 2s, received ${elapsedMs.toFixed(1)}ms`,
  );
});
