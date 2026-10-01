import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAuthClient } from '../src/features/cloud/authClient';
import {
  acquireDesktopExecutionLease,
  DESKTOP_CONTEXT_CONTRACT,
  desktopServerContext,
} from '../src/features/cloud/cloudDesktopExecutionLease';
import { splitCloudAgentNativeContext } from '../src/features/cloud/cloudGroupAgentPolicy';
import type { DesktopChatContextMessage } from '../src/lib/desktop';

const identity = {
  requestId: 'request', agentId: 'cloud-agent:owner', ownerAccountId: 'owner', requesterAccountId: 'member', agentName: 'Scout',
};
const input = {
  requestMessageId: 'request', sessionId: 'session:group:g', ownerAccountId: 'owner', requesterAccountId: 'member',
  prompt: '@Scout what did I ask earlier?', idempotencyKey: 'shared:request:owner',
};
const localHistory: DesktopChatContextMessage[] = [
  { id: 'local-1', authorName: 'Member', authorKind: 'human', text: 'Earlier request' },
  { id: 'local-2', authorName: 'Someone else', authorKind: 'human', text: 'Unaddressed chatter' },
];

function clientReturning(response: Record<string, unknown>) {
  const claims: unknown[] = [];
  const client = {
    desktopAgentExecution: async (_token: string, action: string, body: unknown) => {
      if (action === 'claim') claims.push(body);
      return response;
    },
  } as unknown as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  return { client, claims };
}

test('claims declare context contract 2', async () => {
  const { client, claims } = clientReturning({ acquired: true, runId: 'run', turnIdentity: identity });
  const lease = await acquireDesktopExecutionLease(client, 'token', input);
  lease?.dispose();
  assert.equal(DESKTOP_CONTEXT_CONTRACT, 2);
  assert.equal((claims[0] as { contextContract?: number }).contextContract, 2);
});

test('server context replaces local history but keeps run instructions', async () => {
  const { client } = clientReturning({
    acquired: true,
    runId: 'run',
    turnIdentity: identity,
    serverContext: {
      contract: 2,
      historyScope: 'mentions',
      messages: [
        { id: 'wire-1', authorName: 'Member', authorKind: 'human', text: 'Earlier request', createdAtMs: 10 },
        { id: 'wire-2', authorName: 'Scout', authorKind: 'agent', text: 'Earlier answer', createdAtMs: 20 },
      ],
    },
  });
  const lease = await acquireDesktopExecutionLease(client, 'token', input);
  assert.ok(lease);
  try {
    assert.equal(lease.serverContext?.historyScope, 'mentions');
    const native = splitCloudAgentNativeContext([
      ...localHistory,
      { id: 'cloud-group-mention-permissions:g', authorName: 'Group mention directory', authorKind: 'agent', contextRole: 'resource', text: 'Directory' },
    ]);
    const messages = lease.contextMessages([...lease.history(native.history), ...native.instructions]);
    assert.deepEqual(messages.map((message) => message.id), [
      'server-context:wire-1', 'server-context:wire-2', 'cloud-group-mention-permissions:g', 'runtime-identity:run',
    ]);
    assert.equal(messages[1]?.authorKind, 'agent');
    assert.equal(messages.some((message) => message.text === 'Unaddressed chatter'), false);
  } finally { lease.dispose(); }
});

test('an empty server context means no history, never the local cache', async () => {
  const { client } = clientReturning({
    acquired: true, runId: 'run', turnIdentity: identity,
    serverContext: { contract: 2, historyScope: 'mentions', messages: [{ id: '', text: 'no id' }, 'bad'] },
  });
  const lease = await acquireDesktopExecutionLease(client, 'token', input);
  assert.ok(lease);
  try {
    assert.deepEqual(lease.history(localHistory), []);
  } finally { lease.dispose(); }
});

test('servers that send no server context keep the local history', async () => {
  const { client } = clientReturning({ acquired: true, runId: 'run', turnIdentity: identity });
  const lease = await acquireDesktopExecutionLease(client, 'token', input);
  assert.ok(lease);
  try {
    assert.equal(lease.serverContext, null);
    assert.deepEqual(lease.history(localHistory), localHistory);
  } finally { lease.dispose(); }
});

test('a claim that is not acquired stays a quiet no-op', async () => {
  const { client } = clientReturning({ runId: null, acquired: false, reason: 'desktop_update_required' });
  assert.equal(await acquireDesktopExecutionLease(client, 'token', input), null);
});

test('server context entries are read leniently', () => {
  assert.equal(desktopServerContext(null), null);
  assert.equal(desktopServerContext([]), null);
  assert.deepEqual(desktopServerContext({ historyScope: 'recent', messages: [{ id: 'm', text: ' hi ', authorKind: 'robot' }] }), {
    historyScope: 'recent',
    messages: [{ id: 'server-context:m', authorName: 'Participant', authorKind: 'human', text: 'hi', createdAtMs: null }],
  });
});
