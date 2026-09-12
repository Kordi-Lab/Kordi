import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';

const row: CanonicalSessionMessage = {
  id: 'synthetic', sessionId: 'group:test', senderIdentityId: 'human:test', senderRole: 'person',
  messageKind: 'text', contentText: '', content: {}, status: 'received', sequenceNum: 1,
  createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group',
};
test('persisted group envelopes render their text and hide internal model controls', () => {
  const body = encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: 'Synthetic message' });
  assert.equal(mapCanonicalMessage({ ...row, contentText: body }, new Map())?.text, 'Synthetic message');
  assert.equal(mapCanonicalMessage({ ...row, contentText: body, messageKind: 'agent-model-change' }, new Map()), null);
  assert.equal(mapCanonicalMessage({ ...row, contentText: 'Normalized control', content: { synchronizationOnly: true } }, new Map()), null);
  const sync = encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: 'Control', synchronizationOnly: true });
  assert.equal(mapCanonicalMessage({ ...row, contentText: sync }, new Map()), null);
  assert.equal(mapCanonicalMessage({ ...row, contentText: 'kordi-cloud-message:invalid' }, new Map())?.text, 'Unable to display this message.');
});


test('normalized message text is not decoded again when a user shares a protocol-looking string', () => {
  const text = encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: 'Example control payload', synchronizationOnly: true });
  const message = { ...row, contentText: text, content: { schemaVersion: 1, kind: 'message', text } };
  assert.equal(mapCanonicalMessage(message, new Map())?.text, text);
});
