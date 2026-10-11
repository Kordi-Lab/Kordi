import assert from 'node:assert/strict';
import { test } from 'node:test';

import { releaseInterruptedCloudAgentRequests } from '../src/features/cloud/cloudInterruptedTurnRelease';

type Call = { token: string; action: string; input: unknown };

function fakeClient(respond: (input: { requestMessageId: string }) => unknown) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async desktopAgentExecution<T>(token: string, action: string, input: unknown): Promise<T> {
        calls.push({ token, action, input });
        const result = respond(input as { requestMessageId: string });
        if (result instanceof Error) throw result;
        return result as T;
      },
    },
  };
}

test('restart releases each interrupted request once on the server', async () => {
  const { calls, client } = fakeClient(() => ({ released: true, published: true }));
  const result = await releaseInterruptedCloudAgentRequests(
    client,
    [
      { sessionId: 'session:group:one', requestId: 'request:a' },
      { sessionId: ' session:group:one ', requestId: 'request:a ' },
      { sessionId: 'session:group:two', requestId: 'request:b' },
      { sessionId: '', requestId: 'request:c' },
    ],
    async () => 'token-1',
  );
  assert.deepEqual(result, { released: 2, failures: [] });
  assert.deepEqual(calls, [
    {
      token: 'token-1',
      action: 'interrupted',
      input: { sessionId: 'session:group:one', requestMessageId: 'request:a' },
    },
    {
      token: 'token-1',
      action: 'interrupted',
      input: { sessionId: 'session:group:two', requestMessageId: 'request:b' },
    },
  ]);
});

test('a failed release is reported without blocking the others', async () => {
  const failure = new Error('offline');
  const { client } = fakeClient(({ requestMessageId }) => (
    requestMessageId === 'request:a' ? failure : { released: false }
  ));
  const result = await releaseInterruptedCloudAgentRequests(
    client,
    [
      { sessionId: 'session:group:one', requestId: 'request:a' },
      { sessionId: 'session:group:one', requestId: 'request:b' },
    ],
    async () => 'token-1',
  );
  assert.deepEqual(result, { released: 0, failures: [failure] });
});

test('nothing is sent without a signed-in session', async () => {
  const { calls, client } = fakeClient(() => ({ released: true }));
  const result = await releaseInterruptedCloudAgentRequests(
    client,
    [{ sessionId: 'session:group:one', requestId: 'request:a' }],
    async () => null,
  );
  assert.deepEqual(result, { released: 0, failures: [] });
  assert.equal(calls.length, 0);
});
