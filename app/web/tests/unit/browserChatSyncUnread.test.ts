import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeBase64UrlUtf8 } from '@/features/cloud/cloudBase64Url';
import type { ChatSyncConversation, ChatSyncMessage } from '@/features/cloud/chatSyncTypes';
import { applyBrowserChatSyncCommand, emptyBrowserChatSync } from '@web/runtime/browserChatSync';
import { chatSyncConversationHeads } from '@web/runtime/browserChatSyncUnread';

const owner = 'acct_owner';
const peer = 'acct_peer';
const at = '2026-11-05T12:00:00Z';

function conversation(id: string, latest: number, ownerRead: number): ChatSyncConversation {
  const member = (accountId: string, read: number) => ({ account_id: accountId, display_name: accountId, avatar_url: null,
    role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: read, last_read_sequence: read,
    joined_at: at, left_at: null });
  return { id, kind: 'group', shared_title: id, version: 1, created_by_account_id: owner,
    legacy_session_id: `session:group:${id}`, latest_message_sequence: latest, created_at: at, updated_at: at,
    members: [member(owner, ownerRead), member(peer, latest)],
    preferences: { conversation_id: id, account_id: owner, personal_title: null, version: 1 } } as ChatSyncConversation;
}

function message(conversationId: string, sequence: number, options: { sender?: string; text?: string; replyTo?: string | null; deleted?: boolean } = {}): ChatSyncMessage {
  return { id: `${conversationId}-${sequence}`, client_message_id: `client-${conversationId}-${sequence}`,
    conversation_id: conversationId, conversation_sequence: sequence, sender_account_id: options.sender ?? peer, kind: 'text',
    content: { schema: 1, blocks: [{ type: 'text', text: options.text ?? `Message ${sequence}` }], legacy_attachments: [] },
    reply_to_message_id: options.replyTo ?? null, attachment_ids: [], version: 1, generation_status: null,
    provider_response_id: null, created_at: at, edited_at: null, deleted_at: options.deleted ? at : null };
}

function groupEnvelope(inner: Record<string, unknown>) {
  return `kordi-cloud-group:${encodeBase64UrlUtf8(JSON.stringify({ kind: 'group-message', groupId: 'session:group:g',
    createdByAccountId: peer, actor: { accountId: peer }, participants: [{ accountId: owner }, { accountId: peer }], message: inner }))}`;
}

test('a fresh browser counts only messages after the server read cursor, like the Mac', () => {
  const read = conversation('read', 12, 12);
  const partly = conversation('partly', 12, 9);
  const messages = [read, partly].flatMap(row => Array.from({ length: 12 }, (_, index) => message(row.id, index + 1)));
  const heads = chatSyncConversationHeads(owner, [read, partly], messages);
  assert.deepEqual(heads.map(head => [head.sessionId, head.unreadCount]),
    [['session:group:read', 0], ['session:group:partly', 3]]);
});

test('own, deleted, discussion and queued agent messages never count; self-agent replies and group copies count once', () => {
  const row = conversation('mixed', 9, 1);
  const threadRoot = { id: 'root', text: 'Root', messageAction: { kind: 'thread' } };
  const messages = [
    message('mixed', 2, { sender: owner }),
    message('mixed', 3, { deleted: true }),
    message('mixed', 4, { text: groupEnvelope(threadRoot) }),
    message('mixed', 5, { replyTo: 'mixed-4' }),
    message('mixed', 6, { text: groupEnvelope({ id: 'agent-turn', senderKind: 'agent', deliveryState: 'processing' }) }),
    message('mixed', 7, { sender: owner, text: groupEnvelope({ id: 'my-agent', senderKind: 'agent', senderAccountId: owner }) }),
    message('mixed', 8, { text: groupEnvelope({ id: 'shared' }) }),
    message('mixed', 9, { text: groupEnvelope({ id: 'shared' }) }),
  ];
  assert.equal(chatSyncConversationHeads(owner, [row], messages)[0].unreadCount, 2);
});

test('a read cursor event clears the browser unread head', () => {
  const state = emptyBrowserChatSync(owner);
  const row = conversation('cursor', 3, 0);
  applyBrowserChatSyncCommand(state, 'desktop_chat_sync_apply', { request: { accountId: owner, bootstrap: true,
    conversations: [row], messages: [1, 2, 3].map(sequence => message('cursor', sequence)) } });
  assert.equal((applyBrowserChatSyncCommand(state, 'desktop_chat_sync_unread_counts', {}) as { unreadCount: number }[])[0].unreadCount, 3);
  applyBrowserChatSyncCommand(state, 'desktop_chat_sync_apply', { request: { accountId: owner, events: [{
    stream_seq: 2, event_id: 'read', protocol_version: 2, type: 'read_cursor.updated', critical: false,
    conversation_id: 'cursor', entity_id: null, payload: { cursor: { account_id: owner, last_read_sequence: 3 } } }] } });
  assert.equal((applyBrowserChatSyncCommand(state, 'desktop_chat_sync_unread_counts', {}) as { unreadCount: number }[])[0].unreadCount, 0);
});
