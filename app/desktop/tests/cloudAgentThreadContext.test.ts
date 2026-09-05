import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudAgentContextMessageIds } from '../src/features/cloud/cloudAgentTriggerPolicy';
import { cloudAgentNativeContextMessagesFromDirectCloudSession, cloudDirectAgentReplyThreadAction, encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudGroupNativeContextMessages } from '../src/features/cloud/cloudGroupAgentPolicy';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import type { CloudMessage } from '../src/features/cloud/authClient';
import type { MessageActionMetadata } from '../src/kordi-app/types/message';

const action = (root: string): MessageActionMetadata => ({
  schemaVersion: 1, kind: 'thread',
  source: { sourceSessionId: 'chat', sourceMessageId: root, senderLabel: 'Member', textPreview: 'Root', attachmentCount: 0 },
});

test('context follows the request thread, including inherited replies and reconciled aliases', () => {
  const rows = [
    { id: 'root' },
    { id: 'request-a', replyAliasIds: ['wire-a'], messageAction: action('root') },
    { id: 'reply-a', replyToMessageId: 'wire-a' },
    { id: 'other-root' },
    { id: 'reply-b', messageAction: action('other-root') },
    { id: 'main-request' },
    { id: 'orphan-result', replyToMessageId: 'missing-old-request' },
  ];
  assert.deepEqual([...cloudAgentContextMessageIds(rows, 'main-request')], ['root', 'other-root', 'main-request']);
  assert.deepEqual([...cloudAgentContextMessageIds(rows, 'request-a')], ['root', 'request-a', 'reply-a']);
});

const wire = (id: string, body: string, sequence: number, sessionId = 'chat'): CloudMessage => ({
  messageId: id, fromAccountId: 'owner', toAccountId: 'peer', direction: 'outgoing',
  body, sessionId, conversationSequence: sequence, createdAt: new Date(sequence * 1000).toISOString(),
  deliveredAt: null, readAt: null,
});

test('contact main context excludes thread results and other sessions, but thread follow-ups retain their result', () => {
  const root = wire('root', 'Root', 1);
  const result = wire('result', encodeCloudAgentResponse({ requestId: 'root', text: 'THREAD_ONLY', messageAction: action('root') }), 2);
  const other = wire('other', 'OTHER_SESSION', 1, 'other-chat');
  const main = wire('main', 'Main request', 3);
  const followup = wire('followup', encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: 'Continue', messageAction: action('root') }), 4);
  const messages = [root, result, other, main, followup];
  const context = (requestMessage: CloudMessage) => cloudAgentNativeContextMessagesFromDirectCloudSession({ messages, requestMessage, localAccountId: 'owner' });
  assert.deepEqual(context(main).map(row => row.id), ['root']);
  assert.deepEqual(context(followup).map(row => row.id), ['root', 'result']);
});

test('a resumed request keeps the owner-published thread instead of routing back to main', () => {
  const request = wire('root', 'Research', 1);
  const progress = wire('progress', encodeCloudAgentResponse({ requestId: 'root', text: '', deliveryState: 'processing', messageAction: action('root') }), 2);
  const restored = cloudDirectAgentReplyThreadAction([request, progress], request, 'owner');
  assert.equal(restored?.source.sourceMessageId, 'root');
  assert.equal(cloudDirectAgentReplyThreadAction([request, progress], request, 'different-owner'), null);
  assert.equal(cloudDirectAgentReplyThreadAction([request, { ...progress, sessionId: 'other' }], request, 'owner'), null);
});

test('group main context excludes thread results and separate threads', () => {
  const rows = [
    { id: 'root', text: 'Root', createdAtMs: 1000 },
    { id: 'result', text: 'THREAD_ONLY', createdAtMs: 2000, messageAction: action('root') },
    { id: 'main', text: 'Main request', createdAtMs: 3000 },
    { id: 'followup', text: 'Continue', createdAtMs: 4000, messageAction: action('root') },
  ].map((message, index) => wire(message.id, encodeCloudGroupControl({
    kind: 'group-message', groupId: 'session:group:chat', groupSpaceId: 'session:group:space', groupTitle: null,
    createdByAccountId: 'acct_owner', actor: { accountId: 'acct_owner', displayName: 'Owner', role: 'person' },
    participants: [{ accountId: 'acct_owner', displayName: 'Owner', role: 'person' }],
    message: { ...message, senderAccountId: 'acct_owner', senderKind: 'human' },
  }), index + 1));
  const groupRows = buildCloudMessageIndex('owner', { peer: rows }).groupRows;
  const context = (id: string) => cloudGroupNativeContextMessages({ groupRows, groupId: 'session:group:chat', requestMessageId: id, requestCreatedAtMs: id === 'main' ? 3000 : 4000, respondingAccountId: 'owner' }).filter(row => ['root', 'result', 'main', 'followup'].includes(row.id));
  assert.deepEqual(context('main').map(row => row.id), ['root']);
  assert.deepEqual(context('followup').map(row => row.id), ['root', 'result']);
});
