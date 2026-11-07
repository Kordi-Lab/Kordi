import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';

test('leaving a group deletes the caller membership of its group space', async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({
        left: { group_space_id: 'session:group:planning', conversation_ids: [] },
      }), { status: 200 });
    },
  });

  await client.leaveGroup('token-a', 'group:session:group:planning');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'DELETE');
  assert.equal(
    requests[0].url,
    'http://srv/v2/chat/group-spaces/session%3Agroup%3Aplanning/members/me',
  );
  assert.equal(requests[0].authorization, 'Bearer token-a');
});

test('a refused leave surfaces as an error', async () => {
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: 'last_group_admin', message: 'Make someone else an admin before leaving.' },
    }), { status: 409 }),
  });

  await assert.rejects(client.leaveGroup('token-a', 'session:group:planning'));
});
