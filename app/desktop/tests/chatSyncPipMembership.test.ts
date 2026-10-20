import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import { KORDI_PIP_ACCOUNT_ID } from '../src/features/pip/pipIdentity';
import { conversation, message } from './helpers/chatSyncCanonicalFixtures';

const pipMember = {
  account_id: KORDI_PIP_ACCOUNT_ID, role: 'member', membership_state: 'active', version: 1,
  last_delivered_sequence: 0, last_read_sequence: 0,
  joined_at: '2026-08-10T07:00:00Z', left_at: null,
};

const group = {
  ...conversation,
  kind: 'group' as const,
  legacy_session_id: 'session:group:with-pip',
  preferences: { ...conversation.preferences, account_id: 'acct_b' },
  members: [...conversation.members, pipMember],
};

function clientRecording(calls: string[]) {
  return new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.endsWith('/sync/bootstrap')) {
        return new Response(JSON.stringify({
          protocol_version: 2,
          conversations: [group],
          session_visibility: {hiddenSessionIds:[],deletedSessionIds:[],pinnedSessionIds:[],mutedSessionIds:[],unreadSessionIds:[],pinnedGroupSpaceIds:[]},
          latest_messages: [],
          next_cursor: 'opaque',
          last_stream_seq: 1,
          server_time: '2026-08-10T07:20:00Z',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ message }), { status: 201 });
    },
  });
}

function groupEnvelope(accountIds: string[]) {
  return `kordi-cloud-group:${Buffer.from(JSON.stringify({
    kind: 'group-update',
    participants: accountIds.map((accountId) => ({ accountId })),
  })).toString('base64url')}`;
}

test('a group send never tries to remove PiP, which clients do not list', async () => {
  const calls: string[] = [];
  const client = clientRecording(calls);
  await client.syncCloudEvents('token', '0');
  await client.sendMessage('token', 'acct_a', groupEnvelope(['acct_a', 'acct_b']), {
    sessionId: group.legacy_session_id,
    conversationKind: 'group',
    memberAccountIds: ['acct_a'],
  });
  assert.equal(calls.some((url) => url.endsWith('/members')), false);
  assert.equal(calls.some((url) => url.endsWith('/messages')), true);
});

test('a client that still lists PiP does not ask to add it either', async () => {
  const calls: string[] = [];
  const client = clientRecording(calls);
  await client.syncCloudEvents('token', '0');
  await client.sendMessage('token', 'acct_a', groupEnvelope(['acct_a', 'acct_b', KORDI_PIP_ACCOUNT_ID]), {
    sessionId: group.legacy_session_id,
    conversationKind: 'group',
    memberAccountIds: ['acct_a', KORDI_PIP_ACCOUNT_ID],
  });
  assert.equal(calls.some((url) => url.endsWith('/members')), false);
});
