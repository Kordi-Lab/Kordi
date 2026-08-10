import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';

test('sendMessage creates a producer operation id before network I/O', async () => {
  let body: BodyInit | null | undefined;
  const fetchImpl: typeof fetch = (_input, init) => {
    body = init?.body;
    return Promise.resolve(new Response(JSON.stringify({
      message: {
        messageId: 'msg_generated', fromAccountId: 'acct_me', toAccountId: 'acct_peer',
        body: 'hello', createdAt: '2026-08-10T00:00:00Z', deliveredAt: null,
        readAt: null, direction: 'outgoing',
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.sendMessage('kordi_cs_xyz', 'acct_peer', 'hello');

  assert.equal(typeof body, 'string');
  assert.match(JSON.parse(body as string).clientMessageId, /^kordi-message-v2:send:/);
});
