import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudMessageFromChatSync,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';
import { applyCloudSyncEventsToMessagesByPeer } from '../src/features/cloud/cloudDiffSync';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';

test('chat sync group receipts identify the actual reader instead of the first peer', () => {
  const message: ChatSyncMessage = {
    id: 'message:reader-attribution',
    client_message_id: 'client:reader-attribution',
    conversation_id: 'conversation:reader-attribution',
    conversation_sequence: 8,
    sender_account_id: 'acct_me',
    kind: 'text',
    content: null,
    reply_to_message_id: null,
    attachment_ids: [],
    version: 1,
    generation_status: null,
    provider_response_id: null,
    created_at: '2026-08-23T10:01:00Z',
    edited_at: null,
    deleted_at: null,
  };
  const conversation: ChatSyncConversation = {
    id: message.conversation_id,
    kind: 'group',
    shared_title: 'Readers',
    version: 1,
    created_by_account_id: 'acct_me',
    legacy_session_id: 'session:group:reader-attribution',
    latest_message_sequence: 8,
    created_at: '2026-08-23T10:00:00Z',
    updated_at: message.created_at,
    members: [
      { account_id: 'acct_me', role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-23T10:00:00Z', left_at: null },
      { account_id: 'acct_first_peer', role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 0, joined_at: '2026-08-23T10:00:00Z', left_at: null },
      { account_id: 'acct_actual_reader', role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-23T10:00:00Z', left_at: null },
    ],
    preferences: {
      conversation_id: message.conversation_id,
      account_id: 'acct_me',
      personal_title: null,
      version: 1,
    },
  };
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: conversation.legacy_session_id!,
    groupTitle: conversation.shared_title,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null },
    participants: conversation.members.map((member) => ({
      accountId: member.account_id,
      displayName: member.account_id,
      avatarUrl: null,
    })),
    message: {
      id: message.id,
      senderAccountId: 'acct_me',
      senderKind: 'human',
      senderDisplayName: 'Me',
      text: 'hello',
      createdAtMs: Date.parse(message.created_at),
    },
  });
  const mapped = cloudMessageFromChatSync({
    ...message,
    content: { schema: 1, blocks: [{ type: 'text', text: body }] },
  }, conversation, 'acct_me');
  const messagesByPeer = applyCloudSyncEventsToMessagesByPeer('acct_me', {}, [{
    eventId: 'event:reader-attribution',
    eventType: 'message.upsert',
    peerAccountId: 'acct_first_peer',
    messageId: mapped.messageId,
    payload: { message: mapped },
    occurredAt: message.created_at,
  }]);
  const summary = buildCloudMessageIndex('acct_me', messagesByPeer)
    .deliveryByMessageId.get(message.id);

  assert.deepEqual(mapped.readByAccountIds, ['acct_actual_reader']);
  assert.deepEqual(summary?.readers, [{
    accountId: 'acct_actual_reader',
    identityId: 'human:acct_actual_reader',
    readAt: null,
  }]);
});
