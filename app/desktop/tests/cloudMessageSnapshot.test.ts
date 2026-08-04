import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';

test('listMessageSnapshot exposes the durable peer read cursor', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(typeof input === 'string' ? input : input.toString());
    return new Response(JSON.stringify({
      messages: [{
        messageId: 'msg_1',
        fromAccountId: 'acct_peer',
        toAccountId: 'acct_me',
        body: 'already read',
        createdAt: '2026-05-11T10:00:00Z',
        deliveredAt: '2026-05-11T10:00:01Z',
        readAt: '2026-05-11T10:00:02Z',
        direction: 'incoming',
      }],
      peerReadAt: '2026-05-11T10:30:00Z',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const snapshot = await client.listMessageSnapshot(
    'kordi_cs_xyz',
    'acct_peer',
    500,
  );

  assert.deepEqual(calls, [
    'http://srv/v1/cloud/messages?peerAccountId=acct_peer&limit=500',
  ]);
  assert.equal(snapshot.peerReadAt, '2026-05-11T10:30:00Z');
  assert.deepEqual(snapshot.messages[0]?.attachments, []);
});

test('listMessageSnapshot remains compatible with servers without a cursor', async () => {
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ messages: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const snapshot = await client.listMessageSnapshot('token', 'acct_peer');

  assert.deepEqual(snapshot, { messages: [], peerReadAt: null });
});
