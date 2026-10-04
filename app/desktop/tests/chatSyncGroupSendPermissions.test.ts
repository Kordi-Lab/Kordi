import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import { conversation, message } from './helpers/chatSyncCanonicalFixtures';

const group = {
  ...conversation, kind: 'group' as const, legacy_session_id: 'session:group:partial-roster',
  members: conversation.members,
};
const visibility = { hiddenSessionIds: [], deletedSessionIds: [], pinnedSessionIds: [], mutedSessionIds: [], unreadSessionIds: [], pinnedGroupSpaceIds: [] };
function envelope(kind: string, members: string[]) {
  return `kordi-cloud-group:${Buffer.from(JSON.stringify({
    kind, participants: members.map((accountId) => ({ accountId })),
    message: { id: 'draft-one', senderAccountId: 'acct_b', text: 'Hello' },
  })).toString('base64url')}`;
}
function setup() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl: async (input, init) => {
    const url = input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.endsWith('/sync/bootstrap')) return Response.json({
      protocol_version: 2, conversations: [group], session_visibility: visibility,
      latest_messages: [], next_cursor: 'opaque', last_stream_seq: 1, server_time: message.created_at,
    });
    if (url.endsWith('/members')) return Response.json({
      errorCode: 'forbidden', message: 'The account is not allowed to perform this operation.',
    }, { status: 403 });
    assert.ok(url.endsWith('/messages'), `unexpected request: ${url}`);
    return Response.json({ message: { ...message, sender_account_id: 'acct_b', client_message_id: body.client_message_id } }, { status: 201 });
  } });
  return { client, calls };
}

test('a regular member can send with a partial cached roster without editing membership', async () => {
  const { client, calls } = setup();
  await client.syncCloudEvents('synthetic-token', '0');
  const clientMessageId = 'b1d1683a-3816-4e1e-aa28-056f5821f772';
  await client.sendMessage('synthetic-token', 'acct_a', envelope('group-message', ['acct_a', 'acct_b', 'acct_missing_profile']), {
    accountId: 'acct_b', sessionId: group.legacy_session_id, conversationKind: 'group', clientMessageId,
    memberAccountIds: ['acct_a', 'acct_b', 'acct_missing_profile'],
  });
  assert.equal(calls.filter((call) => call.url.endsWith('/members')).length, 0);
  const sends = calls.filter((call) => call.url.endsWith('/messages'));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.client_message_id, clientMessageId);
});

test('a stale message participant snapshot cannot remove another member before sending', async () => {
  const { client, calls } = setup();
  await client.syncCloudEvents('synthetic-token', '0');
  await client.sendMessage('synthetic-token', 'acct_a', envelope('group-message', ['acct_b']), {
    accountId: 'acct_b', sessionId: group.legacy_session_id, conversationKind: 'group', memberAccountIds: ['acct_a'],
  });
  assert.equal(calls.some((call) => call.url.endsWith('/members')), false);
});

test('an explicit unauthorized membership update still fails and is not sent as a message', async () => {
  const { client, calls } = setup();
  await client.syncCloudEvents('synthetic-token', '0');
  await assert.rejects(client.sendMessage('synthetic-token', 'acct_a', envelope('group-update', ['acct_a', 'acct_b', 'acct_new']), {
    accountId: 'acct_b', sessionId: group.legacy_session_id, conversationKind: 'group', memberAccountIds: ['acct_a'],
  }), /not allowed/);
  assert.equal(calls.some((call) => call.url.endsWith('/messages')), false);
});

test('looking up an existing group does not edit a partial cached roster', async () => {
  const { client, calls } = setup();
  await client.syncCloudEvents('synthetic-token', '0');
  const result = await client.ensureChatConversation('synthetic-token', {
    accountId: 'acct_b', peerAccountId: 'acct_a', sessionId: group.legacy_session_id,
    kind: 'group', memberAccountIds: ['acct_a', 'acct_b', 'acct_missing_profile'],
  });
  assert.equal(result.id, group.id);
  assert.equal(calls.some((call) => call.url.endsWith('/members')), false);
});
