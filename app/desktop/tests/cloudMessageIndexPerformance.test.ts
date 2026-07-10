import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import {
  CHAT_SCALE,
  buildScaleCloudMessagesByPeer,
  scaleMessageId,
} from './fixtures/chatScale';

test('scale Cloud fixture has deterministic full fanout and valid group envelopes', () => {
  const messagesByPeer = buildScaleCloudMessagesByPeer();
  const peerIds = Object.keys(messagesByPeer);

  assert.equal(peerIds.length, CHAT_SCALE.cloudRecipients);
  assert.deepEqual(peerIds, Array.from(
    { length: CHAT_SCALE.cloudRecipients },
    (_, index) => `acct_scale_${index}`,
  ));

  const allMessages = Object.values(messagesByPeer).flat();
  assert.equal(
    allMessages.length,
    CHAT_SCALE.selectedSessionMessages * CHAT_SCALE.cloudRecipients,
  );
  assert.ok(Object.values(messagesByPeer).every(
    (messages) => messages.length === CHAT_SCALE.selectedSessionMessages,
  ));

  const firstEnvelope = parseCloudGroupControl(messagesByPeer.acct_scale_0?.[0]?.body ?? '');
  const lastEnvelope = parseCloudGroupControl(messagesByPeer.acct_scale_19?.at(-1)?.body ?? '');
  assert.equal(firstEnvelope?.message?.id, scaleMessageId(0, CHAT_SCALE.messagesPerSession));
  assert.equal(
    lastEnvelope?.message?.id,
    scaleMessageId(0, CHAT_SCALE.messagesPerSession + CHAT_SCALE.selectedSessionMessages - 1),
  );
  assert.equal(messagesByPeer.acct_scale_0?.[0]?.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(messagesByPeer.acct_scale_0?.[0]?.direction, 'outgoing');
  assert.equal(messagesByPeer.acct_scale_0?.[0]?.readAt, '2026-01-01T00:00:02.000Z');
});
