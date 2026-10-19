import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { cloudGroupObservedSequences } from '../src/features/cloud/cloudReadTracking';

const groupId = '019cb111-8ecc-7181-8266-8986d9501700';

function groupConversation(latestMessageSequence: number) {
  return {
    id: groupId,
    kind: 'group',
    shared_title: null,
    version: 1,
    created_by_account_id: 'acct_me',
    legacy_session_id: 'session:group:one',
    latest_message_sequence: latestMessageSequence,
    created_at: '2026-05-12T00:00:00Z',
    updated_at: '2026-05-12T00:00:00Z',
    members: [
      { account_id: 'acct_me', role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 0, last_read_sequence: 0, joined_at: '2026-05-12T00:00:00Z', left_at: null },
      { account_id: 'acct_peer', role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 0, last_read_sequence: 0, joined_at: '2026-05-12T00:00:00Z', left_at: null },
    ],
    preferences: { conversation_id: groupId, account_id: 'acct_me', personal_title: null, version: 1 },
  };
}

function readSequences(observedSequence?: number) {
  const bodies: Array<{ sequence: number }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/sync/bootstrap')) {
      return Promise.resolve(new Response(JSON.stringify({
        protocol_version: 2,
        conversations: [groupConversation(9)],
        latest_messages: [],
        next_cursor: 'opaque',
        last_stream_seq: 4,
        server_time: '2026-05-12T00:00:00Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    bodies.push(JSON.parse(init?.body as string));
    return Promise.resolve(new Response(JSON.stringify({ cursor: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });
  return client.markSessionMessagesRead('kordi_cs_xyz', 'session:group:one', observedSequence)
    .then(() => bodies.map((body) => body.sequence));
}

test('an open group read covers an own-agent reply the cached head has not seen', async () => {
  // The owner's request is sequence 9. This Mac published the agent reply at
  // sequence 10 through its execution lease, so the cached head still says 9.
  assert.deepEqual(await readSequences(10), [10]);
});

test('an older observed sequence never moves the read cursor backwards', async () => {
  assert.deepEqual(await readSequences(4), [9]);
  assert.deepEqual(await readSequences(), [9]);
});

test('observed group sequences come from the rows the renderer holds', () => {
  const row = (sessionId: string, conversationSequence?: number | null) => ({
    wire: { conversationSequence },
    envelope: { groupId: sessionId },
  });
  assert.deepEqual(cloudGroupObservedSequences([
    row('session:group:one', 9),
    row('session:group:one', 10),
    row('session:group:one', null),
    row('session:group:two', 30),
  ], ['session:group:one']), { 'session:group:one': 10 });
});
