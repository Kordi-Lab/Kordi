import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudMessageFromChatSync,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';
import { encodeCloudGroupControl, parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudGroupCanonicalMessageSource } from '../src/features/cloud/cloudMessageIndex';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';

const conversation: ChatSyncConversation = {
  id: '019cb111-8ecc-7181-8266-8986d950169b',
  kind: 'group',
  shared_title: 'Call history',
  version: 3,
  created_by_account_id: 'acct_a',
  legacy_session_id: 'session:group:call-history',
  latest_message_sequence: 8,
  created_at: '2026-08-10T07:00:00Z',
  updated_at: '2026-08-10T07:20:00Z',
  members: [
    { account_id: 'acct_a', display_name: 'Alex', avatar_url: null, role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-10T07:00:00Z', left_at: null },
    { account_id: 'acct_b', display_name: 'Taylor', avatar_url: null, role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-10T07:00:00Z', left_at: null },
  ],
  preferences: { conversation_id: '019cb111-8ecc-7181-8266-8986d950169b', account_id: 'acct_b', personal_title: null, version: 1 },
};

const message: ChatSyncMessage = {
  id: '019cb2c9-0a77-7d84-b81b-97042279ad41',
  client_message_id: '019cb2c9-0a77-7d84-b81b-97042279ad40',
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

test('plain reliable group messages enter the canonical group projection', () => {
  const mapped = cloudMessageFromChatSync(message, conversation, 'acct_b');
  const envelope = parseCloudGroupControl(mapped.body);

  assert.equal(envelope?.groupId, conversation.legacy_session_id);
  assert.equal(envelope?.message?.text, 'hello');
  assert.equal(envelope?.message?.senderKind, 'human');
  assert.equal(envelope?.message?.id, message.id);
});

test('reliable transport time replaces stale legacy group-envelope activity', () => {
  const legacyBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:stale-embedded-route',
    groupSpaceId: null,
    groupTitle: conversation.shared_title,
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alex', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_a', displayName: 'Alex', avatarUrl: null, role: 'person' },
      { accountId: 'acct_b', displayName: 'Taylor', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: message.id,
      senderAccountId: 'acct_a',
      senderKind: 'human',
      senderDisplayName: 'Alex',
      text: 'hello',
      createdAtMs: 1,
    },
  });
  const mapped = cloudMessageFromChatSync({
    ...message,
    content: { schema: 1, blocks: [{ type: 'text', text: legacyBody }] },
  }, conversation, 'acct_b');

  assert.equal(
    parseCloudGroupControl(mapped.body)?.message?.createdAtMs,
    Date.parse(message.created_at),
  );
  assert.equal(
    parseCloudGroupControl(mapped.body)?.groupId,
    conversation.legacy_session_id,
  );
});

test('plain reliable group agent responses retain their request lifecycle', () => {
  const body = encodeCloudAgentResponse({
    requestId: 'request-1',
    text: 'Finished',
    deliveryState: 'complete',
  });
  const mapped = cloudMessageFromChatSync({
    ...message,
    content: { schema: 1, blocks: [{ type: 'text', text: body }] },
  }, conversation, 'acct_b');
  const envelope = parseCloudGroupControl(mapped.body);

  assert.equal(envelope?.message?.senderKind, 'agent');
  assert.equal(envelope?.message?.text, 'Finished');
  assert.equal(envelope?.message?.requestId, 'request-1');
  assert.equal(envelope?.message?.deliveryState, 'complete');
});

test('group call activity snapshots enter the canonical group envelope', () => {
  const callId = message.client_message_id;
  const callActivity = {
    schema: 1,
    callId,
    kind: 'meeting',
    event: 'ended',
    answeredAtMs: 1_000,
    durationSeconds: 65,
  };
  const mapped = cloudMessageFromChatSync({
    ...message,
    kind: `call.ended.${callId}`,
    content: {
      schema: 1,
      blocks: [{ type: 'text', text: 'The video chat ended. Duration 01:05.' }],
      callActivity,
    },
  }, conversation, 'acct_b');

  const envelope = parseCloudGroupControl(mapped.body);
  assert.equal(envelope?.groupId, conversation.legacy_session_id);
  assert.equal(envelope?.message?.id, mapped.messageId);
  assert.equal(envelope?.message?.messageKind, `call.ended.${callId}`);
  assert.deepEqual(envelope?.message?.structuredContent?.callActivity, callActivity);
  assert.equal(
    envelope ? cloudGroupCanonicalMessageSource(mapped, envelope)?.sourceEventId : null,
    `cloud-group:${mapped.messageId}:1`,
  );

  const updated = cloudMessageFromChatSync({
    ...message,
    kind: `call.ended.${callId}`,
    version: 2,
    content: {
      schema: 1,
      blocks: [{ type: 'text', text: 'The video chat ended. Duration 01:06.' }],
      callActivity: { ...callActivity, durationSeconds: 66 },
    },
  }, conversation, 'acct_b');
  const updatedEnvelope = parseCloudGroupControl(updated.body);
  assert.equal(
    updatedEnvelope
      ? cloudGroupCanonicalMessageSource(updated, updatedEnvelope)?.sourceEventId
      : null,
    `cloud-group:${mapped.messageId}:2`,
  );
});
