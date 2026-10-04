import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudMessageFromChatSync,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';
import {
  encodeCloudGroupControl,
  parseCloudGroupControl,
  type CloudGroupControlEnvelope,
} from '../src/features/cloud/cloudGroupMessages';

const createdAt = '2026-09-30T10:00:00Z';

const conversation: ChatSyncConversation = {
  id: 'conversation:sender-identity',
  kind: 'group',
  shared_title: 'Sender identity',
  version: 1,
  created_by_account_id: 'acct_owner',
  legacy_session_id: 'session:group:sender-identity',
  latest_message_sequence: 3,
  created_at: createdAt,
  updated_at: createdAt,
  members: [
    { account_id: 'acct_owner', display_name: 'Owner', role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 3, last_read_sequence: 3, joined_at: createdAt, left_at: null },
    { account_id: 'acct_member', display_name: 'Member', role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 3, last_read_sequence: 3, joined_at: createdAt, left_at: null },
  ],
  preferences: {
    conversation_id: 'conversation:sender-identity',
    account_id: 'acct_viewer',
    personal_title: null,
    version: 1,
  },
};

function envelope(overrides: Partial<CloudGroupControlEnvelope>): string {
  return encodeCloudGroupControl({
    kind: 'group-message',
    groupId: conversation.legacy_session_id!,
    groupTitle: conversation.shared_title,
    createdByAccountId: 'acct_owner',
    actor: { accountId: 'acct_owner', displayName: 'Owner', avatarUrl: null },
    participants: [
      { accountId: 'acct_owner', displayName: 'Owner', avatarUrl: null },
      { accountId: 'acct_member', displayName: 'Member', avatarUrl: null },
    ],
    message: {
      id: 'group-message:1',
      senderAccountId: 'acct_owner',
      senderKind: 'agent',
      senderAgentId: 'cloud-agent:acct_owner',
      senderDisplayName: 'Owner Kordi',
      text: 'hello',
      createdAtMs: Date.parse(createdAt),
    },
    ...overrides,
  });
}

function wire(senderAccountId: string, body: string): ChatSyncMessage {
  return {
    id: `message:${senderAccountId}`,
    client_message_id: `client:${senderAccountId}`,
    conversation_id: conversation.id,
    conversation_sequence: 3,
    sender_account_id: senderAccountId,
    kind: 'text',
    content: { schema: 1, blocks: [{ type: 'text', text: body }] },
    reply_to_message_id: null,
    attachment_ids: [],
    version: 1,
    generation_status: null,
    provider_response_id: null,
    created_at: createdAt,
    edited_at: null,
    deleted_at: null,
  };
}

test('group messages are attributed to the stored sender, not the envelope sender', () => {
  const mapped = cloudMessageFromChatSync(wire('acct_member', envelope({})), conversation, 'acct_viewer');
  const parsed = parseCloudGroupControl(mapped.body);
  assert.equal(mapped.fromAccountId, 'acct_member');
  assert.equal(parsed?.message?.senderAccountId, 'acct_member');
  assert.equal(parsed?.message?.senderKind, 'human');
  assert.equal(parsed?.message?.senderAgentId, null);
  assert.equal(parsed?.message?.senderDisplayName, null);
  assert.equal(parsed?.actor.accountId, 'acct_member');
  assert.equal(parsed?.actor.displayName, 'Member');
  assert.equal(parsed?.message?.text, 'hello');
});

test('agent messages from their owner keep the agent presentation', () => {
  const mapped = cloudMessageFromChatSync(wire('acct_owner', envelope({})), conversation, 'acct_viewer');
  const parsed = parseCloudGroupControl(mapped.body);
  assert.equal(parsed?.message?.senderAccountId, 'acct_owner');
  assert.equal(parsed?.message?.senderKind, 'agent');
  assert.equal(parsed?.message?.senderAgentId, 'cloud-agent:acct_owner');
  assert.equal(parsed?.message?.senderDisplayName, 'Owner Kordi');
  assert.equal(parsed?.actor.accountId, 'acct_owner');
});

test('group control notices are attributed to the stored sender', () => {
  const body = envelope({ kind: 'group-title-update', groupTitle: 'Renamed', message: null });
  const mapped = cloudMessageFromChatSync(wire('acct_member', body), conversation, 'acct_viewer');
  const parsed = parseCloudGroupControl(mapped.body);
  assert.equal(parsed?.kind, 'group-title-update');
  assert.equal(parsed?.groupTitle, 'Renamed');
  assert.equal(parsed?.actor.accountId, 'acct_member');
  assert.equal(parsed?.actor.displayName, 'Member');

  const unchanged = cloudMessageFromChatSync(wire('acct_owner', body), conversation, 'acct_viewer');
  assert.equal(unchanged.body, body);
});
