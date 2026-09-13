import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudDesktopCollaborationState, cloudDirectPersonSessionId } from '../src/features/cloud/cloudCollaborationState';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudSelfAgentMessagesBySession } from '../src/features/cloud/cloudCollaborationMemo';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const account: CloudAccount = {
  accountId: 'acct_owner', displayName: 'Owner', primaryEmail: 'owner@example.com',
  avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: null, passwordSet: true,
};
const contact = cloudContactToContact({
  accountId: 'acct_peer', displayName: 'Contact', avatarUrl: null,
  nodeId: null, createdAt: '2026-09-01T00:00:00Z',
});
const sessionId = cloudDirectPersonSessionId(account.accountId, 'acct_peer');
const reply: CloudMessage = {
  messageId: 'reply', fromAccountId: account.accountId, toAccountId: 'acct_peer',
  sessionId, body: encodeCloudAgentResponse({ requestId: 'request', text: 'Answer in the contact chat.', deliveryState: 'complete' }),
  createdAt: '2026-09-01T00:00:02Z', deliveredAt: null, readAt: null, direction: 'outgoing',
};
const request: CloudMessage = {
  ...reply, messageId: 'request', body: '@Kordi answer here', createdAt: '2026-09-01T00:00:01Z',
};

test('a cached shared reply never creates an agent chat or a second unread badge', () => {
  const input = { account, contacts: [contact], messagesByPeer: { acct_peer: [request, reply] } };
  const expected = buildCloudDesktopCollaborationState(input);
  const actual = buildCloudDesktopCollaborationState({
    ...input,
    messagesByPeer: {
      ...input.messagesByPeer,
      // Older desktop publication acknowledgements used the requester as recipient.
      acct_owner: [{ ...reply, toAccountId: account.accountId }],
    },
  });
  assert.equal(actual.conversations.length, 1);
  assert.deepEqual(actual.conversations, expected.conversations);
  assert.equal(actual.conversations[0].canonicalSessionId, sessionId);
  assert.ok(actual.conversations[0].messages.some(message => message.text === 'Answer in the contact chat.'));
});

test('discarding a misplaced direct reply preserves private chats and their history', () => {
  const legacyPrivate = { ...request, sessionId: null, toAccountId: account.accountId };
  const privateRequest = { ...legacyPrivate, messageId: 'private-request', sessionId: 'private-session' };
  const internalReply = { ...reply, sessionId: ` ${sessionId} `, toAccountId: account.accountId };
  const onlyLegacy = cloudSelfAgentMessagesBySession([legacyPrivate, internalReply]);
  assert.equal(onlyLegacy.hasSessionScopedMessages, false);
  assert.deepEqual([...onlyLegacy.messagesBySessionId], [[null, [legacyPrivate]]]);
  const partition = cloudSelfAgentMessagesBySession([privateRequest, internalReply]);
  assert.equal(partition.hasSessionScopedMessages, true);
  assert.deepEqual([...partition.messagesBySessionId], [['private-session', [privateRequest]]]);
});
