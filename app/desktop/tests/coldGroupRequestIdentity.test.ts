import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudDesktopCollaborationState } from '../src/features/cloud/cloudCollaborationState';
import { encodeCloudGroupControl, parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { cloudSelfAgentMessagesBySession } from '../src/features/cloud/cloudCollaborationMemo';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const group = 'session:group:synthetic';
const account: CloudAccount = {
  accountId: 'acct_owner', primaryEmail: 'owner@example.invalid', displayName: 'Owner',
  nodeId: null, avatar: cloudAccountAvatarFixture, avatarUrl: null, passwordSet: true,
};
const canonical = {
  profile: { id: 'profile', humanIdentityId: 'human:owner' },
  identities: [{ id: 'human:owner', kind: 'human', displayName: 'Owner', source: 'cloud' }],
  sessions: [{ id: group, kind: 'group', title: 'Synthetic group', status: 'active', createdAtMs: 1000, updatedAtMs: 2000, metadata: {} }],
  participants: [],
  messages: [{
    id: 'history', sessionId: group, senderIdentityId: 'human:owner', senderRole: 'user',
    messageKind: 'text', contentText: 'Existing history', content: {}, status: 'received',
    sequenceNum: 1, createdAtMs: 1000, updatedAtMs: 1000,
  }],
  delegatedExchanges: [], presence: [], contextSnapshots: [],
} as unknown as CanonicalSessionState;
const wire: CloudMessage = {
  messageId: 'wire', fromAccountId: 'acct_owner', toAccountId: 'acct_owner',
  conversationId: group, sessionId: group, createdAt: new Date(2000).toISOString(),
  direction: 'outgoing', deliveredAt: null, readAt: null,
  body: encodeCloudGroupControl({
    kind: 'group-message', groupId: group, groupTitle: 'Synthetic group', createdByAccountId: 'acct_owner',
    actor: { accountId: 'acct_owner', displayName: 'Owner', role: 'person' },
    participants: [{ accountId: 'acct_owner', displayName: 'Owner', role: 'person' }],
    message: {
      id: 'processing', senderAccountId: 'acct_owner', senderKind: 'agent', text: '',
      deliveryState: 'processing', requestId: 'request', createdAtMs: 2000,
    },
  }),
};
assert.ok(parseCloudGroupControl(wire.body), 'the fixture must be a valid group control');
const cloud = buildCloudDesktopCollaborationState({ account, contacts: [], messagesByPeer: { acct_owner: [wire] } });
const read = createCanonicalSessionReadModel(canonical)!;
const cold = read.buildChatConversations([], () => '');
const mapped = cloud.conversations.map(conversation => mapCollaborationConversationToViewModel(conversation, cloud.hosts[0], 'Agent'));
const warm = read.buildChatConversations(mapped, () => '');

test('group processing controls do not create a private self-agent conversation', () => {
  assert.equal(cloud.conversations.some(conversation => conversation.canonicalSessionId === group), false);
});

test('the first group request preserves the cold-open conversation identity', () => {
  assert.equal(warm[0].id, cold[0].id);
  assert.equal(warm[0].canonicalSessionId, group);
});

test('excluding group controls preserves private sessions and scopes the partition cache', () => {
  const privateMessage = { ...wire, messageId: 'private-message', sessionId: 'private-session', body: 'Synthetic private request' };
  const messages = [wire, privateMessage];
  const excluded = new Set(['wire']);
  const before = cloudSelfAgentMessagesBySession(messages);
  assert.equal(before.messagesBySessionId.size, 2);
  const partition = cloudSelfAgentMessagesBySession(messages, excluded);
  assert.deepEqual([...partition.messagesBySessionId.keys()], ['private-session']);
  assert.equal(cloudSelfAgentMessagesBySession(messages, excluded), partition);
  assert.equal(cloudSelfAgentMessagesBySession(messages).messagesBySessionId.size, 2);
});
