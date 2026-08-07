import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';

test('lookupMessageBodies posts deduplicated exact ids to the authenticated recovery route', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: input.toString(), init });
    return Response.json({
      messages: [{ messageId: 'old-control', body: 'kordi-cloud-group:payload' }],
    });
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const messages = await client.lookupMessageBodies('kordi_cs_xyz', [' old-control ', 'old-control', '']);

  assert.deepEqual(messages, [{ messageId: 'old-control', body: 'kordi-cloud-group:payload' }]);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/messages/lookup');
  assert.equal(calls[0].init?.method, 'POST');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { messageIds: ['old-control'] });
});
