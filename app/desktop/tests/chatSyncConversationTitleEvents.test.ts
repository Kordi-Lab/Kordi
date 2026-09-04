import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';

test('incremental message creation publishes its canonical conversation title immediately', async () => {
  const conversation = {
    id: '019cb111-8ecc-7181-8266-8986d950169b',
    kind: 'group',
    shared_title: 'Really channel',
    version: 46,
    created_by_account_id: 'acct_a',
    legacy_session_id: 'session:group:planning',
    latest_message_sequence: 8,
    created_at: '2026-08-10T07:00:00Z',
    updated_at: '2026-08-10T07:20:00Z',
    members: [
      { account_id: 'acct_a', role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-10T07:00:00Z', left_at: null },
      { account_id: 'acct_b', role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-10T07:00:00Z', left_at: null },
    ],
    preferences: { conversation_id: '019cb111-8ecc-7181-8266-8986d950169b', account_id: 'acct_b', personal_title: null, version: 1 },
  };
  const message = {
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
    reactions: [],
  };
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async () => new Response(JSON.stringify({
      protocol_version: 2,
      events: [{
        stream_seq: 47,
        event_id: '019cb2ca-0a77-7d84-b81b-97042279ad3f',
        protocol_version: 2,
        type: 'message.created',
        critical: true,
        conversation_id: conversation.id,
        entity_id: message.id,
        entity_version: 1,
        occurred_at: message.created_at,
        payload: { conversation, message },
      }],
      next_cursor: 'opaque.renamed.cursor',
      last_stream_seq: 47,
      has_more: false,
      server_time: message.created_at,
    }), { status: 200 }),
  });

  const result = await client.syncCloudEvents('token', 'opaque.current.cursor', 500);
  const titleEvent = result.events.find((event) => event.eventType === 'session.title.updated');

  assert.equal(result.events.some((event) => event.eventType === 'message.upsert'), true);
  assert.equal((titleEvent?.payload.sessionTitle as { sessionId?: string })?.sessionId, 'session:group:planning');
  assert.equal((titleEvent?.payload.sessionTitle as { title?: string })?.title, 'Really channel');
});
