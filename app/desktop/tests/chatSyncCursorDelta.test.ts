import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatSyncConversation, ChatSyncMessage } from '../src/features/cloud/authClient';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import type { ChatSyncSyncResponse } from '../src/features/cloud/chatSyncTypes';

const previousSequence = 9_999;
const latestSequence = 10_000;
const conversation: ChatSyncConversation = {
  id: 'conversation-large-history',
  kind: 'direct',
  shared_title: null,
  version: 1,
  created_by_account_id: 'acct_a',
  legacy_session_id: 'session:direct-person:acct_a:acct_b',
  latest_message_sequence: latestSequence,
  created_at: '2026-08-31T00:00:00Z',
  updated_at: '2026-08-31T00:00:00Z',
  members: [{
    account_id: 'acct_b',
    role: 'member',
    membership_state: 'active',
    version: 1,
    last_delivered_sequence: previousSequence,
    last_read_sequence: previousSequence,
    joined_at: '2026-08-31T00:00:00Z',
    left_at: null,
  }],
  preferences: {
    conversation_id: 'conversation-large-history',
    account_id: 'acct_b',
    personal_title: null,
    version: 1,
  },
};

function message(sequence: number): ChatSyncMessage {
  return {
    id: `message-${sequence}`,
    client_message_id: `client-${sequence}`,
    conversation_id: conversation.id,
    conversation_sequence: sequence,
    sender_account_id: 'acct_a',
    kind: 'text',
    content: { schema: 1, blocks: [{ type: 'text', text: 'Message' }] },
    reply_to_message_id: null,
    attachment_ids: [],
    version: 1,
    generation_status: null,
    provider_response_id: null,
    created_at: '2026-08-31T00:00:00Z',
    edited_at: null,
    deleted_at: null,
    reactions: [],
  };
}

test('one cursor step reprojects only one message from a 10,000-message history', async () => {
  const response = {
    protocol_version: 2,
    events: [{
      stream_seq: latestSequence,
      event_id: 'cursor-step',
      protocol_version: 2,
      type: 'read_cursor.updated',
      critical: true,
      conversation_id: conversation.id,
      entity_id: conversation.id,
      entity_version: null,
      occurred_at: '2026-08-31T00:00:00Z',
      payload: {
        cursor: {
          conversation_id: conversation.id,
          account_id: 'acct_b',
          last_delivered_sequence: latestSequence,
          last_read_sequence: latestSequence,
        },
      },
    }],
    next_cursor: String(latestSequence),
    last_stream_seq: latestSequence,
    has_more: false,
    server_time: '2026-08-31T00:00:00Z',
  } satisfies ChatSyncSyncResponse;
  const state = new ChatSyncState(
    async () => response,
    () => 'acct_b',
    () => undefined,
    () => null,
  );
  state.rememberConversation(conversation);
  for (let sequence = 1; sequence <= latestSequence; sequence += 1) {
    state.messageById.set(`message-${sequence}`, message(sequence));
  }

  const result = await new ChatSyncSyncClient(state).syncCloudEvents('token', '9_999');

  assert.deepEqual(result.events.map((event) => event.messageId), ['message-10000']);
  assert.ok(result.events[0]?.payload.message);
});
