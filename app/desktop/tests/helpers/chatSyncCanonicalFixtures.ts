import type {ChatSyncConversation, ChatSyncMessage} from '../../src/features/cloud/authClient';

export const conversation: ChatSyncConversation = {
  id: '019cb111-8ecc-7181-8266-8986d950169b',
  kind: 'direct',
  shared_title: 'Synced title',
  version: 3,
  created_by_account_id: 'acct_a',
  legacy_session_id: 'session:direct-person:acct_a:acct_b',
  latest_message_sequence: 8,
  created_at: '2026-08-10T07:00:00Z',
  updated_at: '2026-08-10T07:20:00Z',
  members: [
    { account_id: 'acct_a', role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-10T07:00:00Z', left_at: null },
    { account_id: 'acct_b', role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-10T07:00:00Z', left_at: null },
  ],
  preferences: { conversation_id: '019cb111-8ecc-7181-8266-8986d950169b', account_id: 'acct_b', personal_title: null, version: 1 },
};
export const message: ChatSyncMessage = {
  id: '019cb2c9-0a77-7d84-b81b-97042279ad3d',
  client_message_id: '019cb2c8-d133-7e52-b797-ad871be09d66',
  conversation_id: conversation.id,
  conversation_sequence: 8,
  sender_account_id: 'acct_a',
  kind: 'text',
  content: { schema: 1, blocks: [{ type: 'text', text: 'hello' }] },
  reply_to_message_id: null,
  attachment_ids: [],
  version: 1,
  generation_status: null,
  provider_response_id: null,
  created_at: '2026-08-10T07:20:00Z',
  edited_at: null,
  deleted_at: null,
  reactions: [{ reaction: 'blob:blobwave', account_ids: ['acct_a'] }],
};
