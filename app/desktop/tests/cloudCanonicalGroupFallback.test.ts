import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudMessageFromChatSync, type ChatSyncConversation, type ChatSyncMessage, type CloudAccount } from '../src/features/cloud/authClient';
import { cloudFallbackRunClaimsForMessages } from '../src/features/cloud/cloudAgentFallbackClaims';
import { encodeCloudGroupControl, type CloudGroupControlEnvelope } from '../src/features/cloud/cloudGroupMessages';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const account: CloudAccount = { accountId: 'acct_sender', displayName: 'Sender', primaryEmail: null, avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: null, passwordSet: true };
const now = '2026-09-09T12:00:00Z';
const participants = ['sender', 'transport', 'target'].map((name) => ({ accountId: `acct_${name}`, displayName: name[0].toUpperCase() + name.slice(1), avatarUrl: null, role: 'person' as const }));
const envelope: CloudGroupControlEnvelope = {
  kind: 'group-message', groupId: 'session:group:canonical-fallback', groupTitle: 'Group', createdByAccountId: account.accountId, actor: participants[0], participants,
  message: { id: 'logical-request', senderAccountId: account.accountId, senderKind: 'human', text: '@KordiTarget test', createdAtMs: Date.parse(now), targetCloudAgentId: 'cloud-agent:acct_target', targetCloudAgentOwnerAccountId: 'acct_target' },
};
const conversation: ChatSyncConversation = {
  id: 'canonical-conversation', kind: 'group', shared_title: 'Group', version: 1, created_by_account_id: account.accountId, legacy_session_id: envelope.groupId, latest_message_sequence: 1, created_at: now, updated_at: now,
  members: participants.map((p) => ({ account_id: p.accountId, display_name: p.displayName, role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 1, last_read_sequence: 1, joined_at: now, left_at: null })),
  preferences: { conversation_id: 'canonical-conversation', account_id: account.accountId, personal_title: null, version: 1 },
};
function wire(value = envelope, id = 'canonical-wire-request') {
  const message: ChatSyncMessage = {
    id, client_message_id: `client-${id}`, conversation_id: conversation.id, conversation_sequence: 1, sender_account_id: value.message!.senderAccountId,
    kind: 'text', content: { schema: 1, blocks: [{ type: 'text', text: encodeCloudGroupControl(value) }] }, reply_to_message_id: null, attachment_ids: [], version: 1, generation_status: null, provider_response_id: null, created_at: now, edited_at: null, deleted_at: null,
  };
  return cloudMessageFromChatSync(message, conversation, account.accountId);
}

test('a canonical group row claims the mentioned owner even when its transport peer is someone else', () => {
  const request = wire();
  assert.equal(request.toAccountId, 'acct_transport');
  const claims = cloudFallbackRunClaimsForMessages({ account, contacts: [], messagesByPeer: { acct_transport: [request] } });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].ownerAccountId, 'acct_target');
  assert.equal(claims[0].requestMessageId, 'logical-request');
});

test('canonical and legacy group copies share one fallback claim and a terminal response stops it', () => {
  const request = wire();
  const legacyCopy = { ...request, messageId: 'legacy-target-copy', toAccountId: 'acct_target' };
  const messagesByPeer = { acct_transport: [request], acct_target: [legacyCopy] };
  assert.equal(cloudFallbackRunClaimsForMessages({ account, contacts: [], messagesByPeer }).length, 1);
  const response = wire({ ...envelope, message: { id: 'answer', senderAccountId: 'acct_target', senderKind: 'agent', text: 'Done', createdAtMs: Date.parse(now), requestId: 'logical-request', deliveryState: 'complete' } }, 'answer-wire');
  assert.deepEqual(cloudFallbackRunClaimsForMessages({ account, contacts: [], messagesByPeer: { ...messagesByPeer, acct_target: [legacyCopy, response] } }), []);
});

test('observers, stale requests, forwarded messages and deleted rows do not start fallback', () => {
  const request = wire();
  assert.deepEqual(cloudFallbackRunClaimsForMessages({ account: { ...account, accountId: 'acct_transport' }, contacts: [], messagesByPeer: { acct_sender: [request] } }), []);
  assert.deepEqual(cloudFallbackRunClaimsForMessages({ account, contacts: [], messagesByPeer: { acct_transport: [request] }, recentSinceMs: Date.parse(now) + 1 }), []);
  const forwarded = wire({ ...envelope, message: { ...envelope.message!, messageAction: { schemaVersion: 1, kind: 'forward', source: { sourceSessionId: 'session:source', sourceMessageId: 'source', senderLabel: 'Person', textPreview: '@KordiTarget test', attachmentCount: 0 } } } });
  assert.deepEqual(cloudFallbackRunClaimsForMessages({ account, contacts: [], messagesByPeer: { acct_transport: [forwarded] } }), []);
  assert.deepEqual(cloudFallbackRunClaimsForMessages({ account, contacts: [], messagesByPeer: { acct_transport: [{ ...request, deletedAt: now }] } }), []);
});

test('an agent handoff on a canonical group row claims only its target owner', () => {
  const request = wire({ ...envelope, message: { ...envelope.message!, senderKind: 'agent', senderAgentId: 'cloud-agent:acct_sender', agentMentionDepth: 1 } });
  const claims = cloudFallbackRunClaimsForMessages({ account, contacts: [], messagesByPeer: { acct_transport: [request] } });
  assert.deepEqual(claims.map((c) => c.ownerAccountId), ['acct_target']);
});
