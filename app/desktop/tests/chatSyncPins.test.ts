import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CloudAuthClient,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';
import { applyCloudSyncEventsToSessionPins } from '../src/features/cloud/cloudDiffSync';

const sessionId = 'session:direct-person:acct_a:acct_b';
const conversation: ChatSyncConversation = {
  id: '019cb111-8ecc-7181-8266-8986d950169b',
  kind: 'direct',
  shared_title: 'Synced title',
  version: 3,
  created_by_account_id: 'acct_a',
  legacy_session_id: sessionId,
  latest_message_sequence: 8,
  created_at: '2026-08-10T07:00:00Z',
  updated_at: '2026-08-10T07:20:00Z',
  members: [],
  preferences: {
    conversation_id: '019cb111-8ecc-7181-8266-8986d950169b',
    account_id: 'acct_b',
    personal_title: null,
    version: 1,
  },
};
const message: ChatSyncMessage = {
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
};

test('bootstrap pin snapshots replace stale private and shared state', async () => {
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async () => new Response(JSON.stringify({
      protocol_version: 2,
      conversations: [conversation],
      latest_messages: [message],
      session_pins: [{
        sessionId,
        sharedMessageId: message.id,
        privateMessageId: null,
        effectiveMessageId: message.id,
        updatedAt: '2026-08-10T07:19:00Z',
      }],
      next_cursor: 'opaque.signed.cursor',
      last_stream_seq: 44,
      server_time: '2026-08-10T07:20:00Z',
    }), { status: 200 }),
  });
  const result = await client.syncCloudEvents('token', '0', 500);
  const pins = applyCloudSyncEventsToSessionPins({
    [sessionId]: {
      sessionId,
      sharedMessageId: 'stale-shared',
      privateMessageId: 'stale-private',
      effectiveMessageId: 'stale-private',
      updatedAt: '2026-08-10T07:18:00Z',
    },
  }, result.events);

  assert.deepEqual(pins[sessionId], {
    sessionId,
    sharedMessageId: message.id,
    privateMessageId: null,
    effectiveMessageId: message.id,
    updatedAt: '2026-08-10T07:19:00Z',
    lastAction: null,
  });
});

test('incremental pin events retain actor activity', async () => {
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async () => new Response(JSON.stringify({
      protocol_version: 2,
      events: [{
        stream_seq: 46,
        event_id: '019cb2ca-0a77-7d84-b81b-97042279ad3e',
        protocol_version: 2,
        type: 'session.pin.updated',
        critical: true,
        conversation_id: conversation.id,
        entity_id: null,
        entity_version: null,
        occurred_at: '2026-08-10T07:20:02Z',
        payload: {
          sessionId,
          messageId: message.id,
          scope: 'shared',
          updatedByAccountId: 'acct_a',
          updatedAt: '2026-08-10T07:20:02Z',
        },
      }],
      next_cursor: 'opaque.pin.cursor',
      last_stream_seq: 46,
      has_more: false,
      server_time: '2026-08-10T07:20:02Z',
    }), { status: 200 }),
  });
  const result = await client.syncCloudEvents('token', 'opaque.current.cursor', 500);
  const pins = applyCloudSyncEventsToSessionPins({}, result.events);

  assert.deepEqual(pins[sessionId]?.lastAction, {
    kind: 'pinned',
    scope: 'shared',
    messageId: message.id,
    updatedByAccountId: 'acct_a',
    updatedAt: '2026-08-10T07:20:02Z',
  });
});
