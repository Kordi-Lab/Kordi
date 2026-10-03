import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { cloudAgentNativeContextMessagesFromDirectCloudSession } from '../src/features/cloud/cloudAgentMessages';
import { cloudGroupNativeContextMessages } from '../src/features/cloud/cloudGroupAgentPolicy';
import { encodeCloudGroupControl, type CloudGroupParticipant } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';

// A current Mac uses its local history wherever the server sends no filtered
// history, so the local history must leave AI access notices out as well.
const notice = 'Morgan turned on "Don\'t let AI use my messages" in this conversation.';

test('group agent context leaves AI access notices out', () => {
  const groupId = 'session:group:notices';
  const participants: CloudGroupParticipant[] = ['owner', 'morgan', 'riley'].map((name) => ({
    accountId: `acct_${name}`, displayName: name, avatarUrl: null, role: 'person',
  }));
  const row = (index: number, sender: string, text: string, messageKind?: string): CloudMessage => ({
    messageId: `wire-${index}`, fromAccountId: `acct_${sender}`, toAccountId: 'acct_owner',
    createdAt: new Date(index * 1000).toISOString(), deliveredAt: null, readAt: null,
    direction: 'incoming', sessionId: groupId, messageKind,
    body: encodeCloudGroupControl({
      kind: 'group-message', groupId, groupSpaceId: groupId, groupTitle: 'Example',
      createdByAccountId: 'acct_owner', actor: participants[1], participants,
      message: { id: `message-${index}`, senderAccountId: `acct_${sender}`, senderKind: 'human', text, createdAtMs: index * 1000 },
    }),
  });
  const index = buildCloudMessageIndex('acct_owner', {
    acct_morgan: [row(1, 'morgan', 'Lunch at noon?'), row(2, 'morgan', notice, 'ai-access-notice')],
    acct_riley: [row(3, 'riley', '@Kordi summarize')],
  });
  const history = cloudGroupNativeContextMessages({
    groupRows: index.groupRows, groupId, requestMessageId: 'message-3', requestCreatedAtMs: 3000, respondingAccountId: 'acct_owner',
  }).filter((message) => !message.contextRole || message.contextRole === 'history');
  assert.deepEqual(history.map((message) => message.text), ['Lunch at noon?']);
});

test('direct agent context leaves AI access notices out', () => {
  const sessionId = 'session:direct-person:acct_me:acct_peer';
  const message = (id: string, from: string, body: string, minute: number, messageKind?: string): CloudMessage => ({
    messageId: id, fromAccountId: from, toAccountId: from === 'acct_me' ? 'acct_peer' : 'acct_me', body,
    createdAt: `2026-05-11T10:0${minute}:00Z`, deliveredAt: null, readAt: null,
    direction: from === 'acct_me' ? 'outgoing' : 'incoming', sessionId, messageKind,
  });
  const request = message('request', 'acct_me', '@Kordi recap', 3);
  const context = cloudAgentNativeContextMessagesFromDirectCloudSession({
    localAccountId: 'acct_me',
    requestMessage: request,
    messages: [
      message('hello', 'acct_peer', 'Hi there', 1),
      message('notice', 'acct_peer', notice, 2, 'ai-access-notice'),
      request,
    ],
  });
  assert.deepEqual(context.map((entry) => entry.text), ['Hi there']);
});
