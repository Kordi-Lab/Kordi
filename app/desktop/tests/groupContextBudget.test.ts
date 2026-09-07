import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { cloudGroupNativeContextMessages } from '../src/features/cloud/cloudGroupAgentPolicy';
import { encodeCloudGroupControl, type CloudGroupParticipant } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';

test('large groups disclose only recent previews and the actual requester initially', () => {
  const participants: CloudGroupParticipant[] = Array.from({ length: 100 }, (_, index) => ({
    accountId: `acct_person_${index}`, displayName: `Member ${index}`, avatarUrl: null, role: 'person',
  }));
  const messages: CloudMessage[] = Array.from({ length: 101 }, (_, index) => ({
    messageId: `wire-${index}`, fromAccountId: 'acct_person_1', toAccountId: 'acct_person_2',
    createdAt: new Date(index * 1000).toISOString(), deliveredAt: null, readAt: null,
    direction: 'incoming', sessionId: 'session:group:context-budget',
    body: encodeCloudGroupControl({
      kind: 'group-message', groupId: 'session:group:context-budget', groupSpaceId: 'session:group:context-budget', groupTitle: 'Example',
      createdByAccountId: 'acct_person_0', actor: participants[1], participants,
      message: { id: `message-${index}`, senderAccountId: 'acct_person_1', senderKind: 'human',
        text: index === 100 ? '@Kordi help' : `history-${index} ${'x'.repeat(2000)}`, createdAtMs: index * 1000 },
    }),
  }));
  const index = buildCloudMessageIndex('acct_person_2', { 'acct_person_1': messages });
  assert.equal(index.groupRows.length, 101);
  const context = cloudGroupNativeContextMessages({ groupRows: index.groupRows, groupId: 'session:group:context-budget',
    requestMessageId: 'message-100', requestCreatedAtMs: 100_000, respondingAccountId: 'acct_person_2' });
  const history = context.filter((message) => !message.contextRole || message.contextRole === 'history');
  assert.equal(history.length, 8);
  assert.equal(history[0].id, 'message-92');
  assert.equal(history.at(-1)?.id, 'message-99');
  assert.ok(history.every((message) => Array.from(message.text).length <= 800));
  const initial = context.filter((message) => message.contextRole !== 'resource').map((message) => message.text).join('\n');
  assert.ok(initial.includes('"accountId":"acct_person_1"'));
  assert.ok(!initial.includes('Member 99'));
  assert.ok(!initial.includes('history-91'));
  assert.ok(context.find((message) => message.contextRole === 'resource')?.text.includes('Member 99'));
});
