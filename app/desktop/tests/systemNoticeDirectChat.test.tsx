import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conversation, host } from './helpers/collaborationTranscriptFixtures';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { cloudMessageFromChatSync, type ChatSyncConversation, type ChatSyncMessage } from '../src/features/cloud/authClient';
import { cloudAvatarImageUrl } from '../src/features/cloud/avatar';
import { generatedAvatarMarker } from '../src/features/cloud/canonicalAvatar';
import { conversationPeer } from '../src/features/cloud/chatSyncMapping';
import { normalizePlanCardSnapshot } from '../src/features/cloud/planCardSnapshot';
import { isBuiltInIdentity, KORDI_SYSTEM_ACCOUNT_ID, KORDI_SYSTEM_AVATAR_URL } from '../src/features/systemAgent/systemAgentIdentity';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

const planCardBlock = {
  type: 'plan_card', eventId: 'plan_meet', title: 'Coffee', state: 'polling', revision: 3, view: 'event',
  participants: [
    { participantId: 'acct_me', displayName: 'Me', organizer: true, rsvp: 'yes' },
    { participantId: 'acct_sam', displayName: 'Sam', organizer: false, rsvp: 'pending' },
    { participantId: KORDI_SYSTEM_ACCOUNT_ID, displayName: 'System', organizer: false, rsvp: 'pending' },
  ],
};

function member(accountId: string, lastRead: number) {
  return { account_id: accountId, role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 4, last_read_sequence: lastRead, joined_at: '2026-10-21T09:00:00Z', left_at: null };
}

const direct = {
  id: 'conversation:direct', kind: 'direct', shared_title: null, version: 1, created_by_account_id: 'acct_me',
  legacy_session_id: 'session:direct', latest_message_sequence: 4, created_at: '2026-10-21T09:00:00Z', updated_at: '2026-10-21T09:00:00Z',
  members: [member('acct_me', 4), member(KORDI_SYSTEM_ACCOUNT_ID, 4), member('acct_sam', 0)],
  preferences: { conversation_id: 'conversation:direct', account_id: 'acct_me', personal_title: null, version: 1 },
} as unknown as ChatSyncConversation;

function chatMessage(senderAccountId: string, kind: string): ChatSyncMessage {
  return {
    id: `message:${senderAccountId}:${kind}`, client_message_id: null, conversation_id: direct.id, conversation_sequence: 4,
    sender_account_id: senderAccountId, kind,
    content: { blocks: [{ type: 'text', text: 'Pick a time for coffee.' }, planCardBlock] },
    reply_to_message_id: null, attachment_ids: [], version: 1, generation_status: null, provider_response_id: null,
    created_at: '2026-10-21T09:04:00Z', edited_at: null, deleted_at: null,
  } as unknown as ChatSyncMessage;
}

test('a direct-chat plan card notice from the organizer shows as System, not an own bubble', () => {
  const cloud = cloudMessageFromChatSync(chatMessage('acct_me', 'system-notice'), direct);
  assert.equal(cloud.messageKind, 'system-notice');
  assert.equal(cloud.planCard?.eventId, 'plan_meet');
  assert.deepEqual(cloud.planCard?.participants.map((participant) => participant.participantId), ['acct_me', 'acct_sam']);
  assert.deepEqual(cloud.readByAccountIds ?? [], []);

  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: cloud.messageId, direction: 'outbound', sender: 'Me', text: 'Pick a time for coffee.', timeLabel: '09:04', timestampMs: 4,
      deliveryState: 'read', messageKind: cloud.messageKind, planCard: cloud.planCard,
    }],
  }), host(), 'My Kordi');
  const message = view.messages[0];
  assert.ok(message);
  assert.equal(message.role, 'person');
  assert.equal(message.isOwnMessage, false);
  assert.equal(message.sender, 'System');
  assert.equal(message.senderProfileImageUrl, KORDI_SYSTEM_AVATAR_URL);
  assert.equal(message.showSenderMeta, true);
  assert.deepEqual(message.statusChips, []);
  assert.equal(message.planCard?.eventId, 'plan_meet');

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message, onOpenSenderProfile: () => {} }));
  assert.match(markup, />System</);
  assert.match(markup, /kordi-system-avatar\.svg/);
  assert.match(markup, /app-plan-card/);
  assert.doesNotMatch(markup, /app-chat-bubble-user/);
});

test('ordinary direct messages keep their own identity', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{ id: 'own', direction: 'outbound', sender: 'Me', text: 'hi', timeLabel: '09:04', timestampMs: 4, messageKind: 'text' }],
  }), host(), 'My Kordi');
  assert.equal(view.messages[0]?.role, 'user');
  assert.equal(view.messages[0]?.isOwnMessage, true);
});

test('a group notice posted by the viewer is not an own bubble', () => {
  const me = { id: 'human:me', kind: 'human', displayName: 'Me', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_me', humanId: 'acct_me', createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
  const row: CanonicalSessionMessage = {
    id: 'group-message:notice', sessionId: 'session:group:one', senderIdentityId: me.id, senderRole: 'user', messageKind: 'system-notice',
    contentText: 'Sam joined.', content: { schema: 1, blocks: [{ type: 'text', text: 'Sam joined.' }] }, status: 'received',
    sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group',
  };
  const message = mapCanonicalMessage(row, new Map([[me.id, me]]), me.id);
  if (!message) throw new Error('expected a mapped message');
  assert.equal(message.role, 'person');
  assert.equal(message.isOwnMessage, false);
  assert.equal(message.sender, 'System');
  assert.equal(message.readReceiptSummary, null);
});

test('the system account is hidden like the System agent', () => {
  const fromSystem = cloudMessageFromChatSync(chatMessage(KORDI_SYSTEM_ACCOUNT_ID, 'text'), direct);
  assert.equal(fromSystem.messageKind, 'system-notice');
  assert.equal(conversationPeer(direct, 'acct_me', KORDI_SYSTEM_ACCOUNT_ID), 'acct_sam');
  assert.equal(conversationPeer(direct, 'acct_me', 'acct_me'), 'acct_sam');
  assert.equal(cloudAvatarImageUrl(generatedAvatarMarker('lorelei', KORDI_SYSTEM_ACCOUNT_ID, 1)), KORDI_SYSTEM_AVATAR_URL);
  assert.equal(cloudAvatarImageUrl(generatedAvatarMarker('lorelei', 'acct_kordi_pip', 1)), KORDI_SYSTEM_AVATAR_URL);
  assert.equal(cloudMessageFromChatSync(chatMessage('acct_kordi_pip', 'text'), direct).messageKind, 'system-notice');
  assert.equal(normalizePlanCardSnapshot(planCardBlock)?.participants.length, 2);
  assert.equal(isBuiltInIdentity({ humanId: KORDI_SYSTEM_ACCOUNT_ID }), true);
  assert.equal(isBuiltInIdentity({ sourceIdentityId: 'acct_kordi_pip' }), true);
  assert.equal(isBuiltInIdentity({ humanId: 'acct_sam' }), false);
});
