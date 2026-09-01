import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudMessageFromChatSync,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';
import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';

test('chat bootstrap group catalog restores root title and space id', () => {
  const conversation = {
    id: 'conversation-one',
    kind: 'group',
    shared_title: null,
    version: 1,
    created_by_account_id: 'acct_a',
    legacy_session_id: 'session:group:channel',
    group_space_id: 'session:group:space',
    group_title: 'Our Lab',
    latest_message_sequence: 1,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    members: [
      { account_id: 'acct_a', display_name: 'A', role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 1, last_read_sequence: 1, joined_at: '2026-09-01T00:00:00Z', left_at: null },
    ],
    preferences: { conversation_id: 'conversation-one', account_id: 'acct_a', personal_title: 'General Chat', version: 1 },
  } satisfies ChatSyncConversation;
  const message = {
    id: 'message-one',
    client_message_id: 'client-one',
    conversation_id: conversation.id,
    conversation_sequence: 1,
    sender_account_id: 'acct_a',
    kind: 'text',
    content: { schema: 1, blocks: [{ type: 'text', text: 'hello' }] },
    reply_to_message_id: null,
    attachment_ids: [],
    version: 1,
    generation_status: null,
    provider_response_id: null,
    created_at: '2026-09-01T00:00:00Z',
    edited_at: null,
    deleted_at: null,
  } satisfies ChatSyncMessage;

  const envelope = parseCloudGroupControl(
    cloudMessageFromChatSync(message, conversation).body,
  );
  assert.equal(envelope?.groupSpaceId, 'session:group:space');
  assert.equal(envelope?.groupTitle, 'Our Lab');
});
