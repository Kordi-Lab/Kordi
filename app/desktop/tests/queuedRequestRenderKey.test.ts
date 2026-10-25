import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { transcriptMessageRenderKey } from '../src/features/chat/transcriptRenderKeys';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';

const queuedId = 'queued-local-chat:session:synthetic:1';
const queued: CanonicalSessionMessage = {
  id: queuedId, sessionId: 'session:synthetic', senderIdentityId: 'human:owner', senderRole: 'user',
  messageKind: 'text', contentText: 'Also check the login test',
  content: { deliveryState: 'queued', queuedMessage: true, queueState: 'queued', attachments: [], mentions: [] },
  status: 'queued', sequenceNum: 3, createdAtMs: 10, updatedAtMs: 10,
  sourceTransport: 'desktop-chat-ui', sourceEventId: `desktop-chat-ui:${queuedId}`,
};

test('a queued request keeps one row key when it is sent', () => {
  const waiting = mapCanonicalMessage(queued, new Map(), 'human:owner');
  const sent = mapCanonicalMessage({ ...queued, status: 'sent', content: { ...(queued.content as object), deliveryState: 'sent', queueState: 'sent' } }, new Map(), 'human:owner');
  assert.ok(waiting && sent);
  // The runtime merge and the optimistic copy give the sent row this client id.
  const merged = { ...sent, clientMessageId: queuedId };
  assert.equal(transcriptMessageRenderKey(waiting, 0), transcriptMessageRenderKey(merged, 0));
  assert.equal(transcriptMessageRenderKey(waiting, 0), transcriptMessageRenderKey(sent, 0));
});

test('rows that did not come from this window keep their plain key', () => {
  const synced = mapCanonicalMessage({ ...queued, id: 'cloud-row', sourceTransport: 'cloud-self-agent', content: { deliveryState: 'sent' } }, new Map(), 'human:owner');
  assert.equal(synced?.clientMessageId, undefined);
  assert.equal(transcriptMessageRenderKey(synced!, 0), 'message:cloud-row');
});
