import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { messageActionSourceFromMessage, quoteMessageAction } from '../src/features/chat/messageActionMetadata';
import { cloudMessageActionFromRecord } from '../src/features/cloud/cloudMessageActionCodec';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

const identities = new Map<string, CanonicalIdentity>([
  ['local', { id: 'local', kind: 'human', displayName: 'Local Profile', source: 'local', avatarKey: 'local', createdAtMs: 1, updatedAtMs: 1 }],
  ['maya', { id: 'maya', kind: 'human', displayName: 'Maya', source: 'cloud', avatarKey: 'maya', createdAtMs: 1, updatedAtMs: 1 }],
]);
function row(overrides: Partial<CanonicalSessionMessage> = {}): CanonicalSessionMessage {
  return {
    id: 'source', sessionId: 'group', senderIdentityId: 'local', senderRole: 'user', messageKind: 'text',
    contentText: 'Synthetic edited source', content: { sender: 'Maya' }, status: 'sent', sequenceNum: 1,
    createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group', ...overrides,
  };
}

for (const own of [true, false]) {
  test(`quotes persist the original account name for ${own ? 'own' : 'received'} group messages`, () => {
    const original = mapCanonicalMessage(row(own ? {} : { senderIdentityId: 'maya', senderRole: 'person' }), identities, 'local');
    assert.ok(original);
    const source = messageActionSourceFromMessage(original, 'group');
    assert.ok(source);
    assert.equal(source.senderLabel, 'Maya');
    const wire = cloudMessageActionFromRecord(JSON.parse(JSON.stringify(quoteMessageAction(source))));
    for (const viewer of ['local', 'maya']) {
      const reply = mapCanonicalMessage(row({ id: 'quote', contentText: 'Synthetic reply', content: { sender: 'Alex', messageAction: wire } }), identities, viewer);
      assert.equal(reply?.messageAction?.source.senderLabel, 'Maya');
      assert.equal(reply?.sourceMessage?.senderLabel, 'Maya');
      assert.equal(reply?.sourceMessage?.text, 'Synthetic edited source');
      assert.equal(reply?.sourceMessage?.messageId, 'source');
    }
  });
}

test('relative source sender names resolve through the source identity before quoting', () => {
  const original = mapCanonicalMessage(row({ senderIdentityId: 'maya', senderRole: 'person', content: { sender: 'Me' } }), identities, 'local');
  assert.ok(original);
  assert.equal(messageActionSourceFromMessage(original, 'group')?.senderLabel, 'Maya');
});
