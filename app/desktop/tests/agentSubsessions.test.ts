import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import type { NativeAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';
import { publishModelSubsessions } from '../src/features/cloud/agentSubsessionSync';
import { deriveCloudActivityFromTurn } from '../src/features/cloud/cloudSessionActivity';

test('subsession synchronization uses the execution resource without creating conversations', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new CloudAuthClient({ baseUrl: 'http://127.0.0.1:17081', fetchImpl: async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ sessionId: 'subsession', version: 1 }), { headers: { 'content-type': 'application/json' } });
  } });
  const snapshot: NativeAgentSubsession = { sessionId: 'subsession', parentSessionId: 'parent', parentRequestId: 'request', title: 'Model task', status: 'done', messages: [{ id: 'entry', role: 'assistant', text: 'Result', timestampMs: 1000 }] };
  await client.putAgentSubsession('test-token', snapshot, 0);
  await client.getAgentSubsession('test-token', snapshot.sessionId, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init?.method, 'PUT');
  assert.match(requests[0].url, /\/v1\/cloud\/agent-subsessions\/subsession$/);
  assert.match(requests[1].url, /includeMessages=true$/);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    parentSessionId: 'parent', parentRequestId: 'request', title: 'Model task', status: 'done', messages: snapshot.messages, expectedVersion: 0,
  });
  assert(requests.every((request) => !request.url.includes('/conversations')));
});

test('ordinary answers do not synthesize a subsession or a task card', async () => {
  await publishModelSubsessions({ tools: [] });
  await publishModelSubsessions({ tools: [{ id: 'plan', name: 'task_operator', status: 'completed', arguments: '{"action":"create"}', liveOutput: '', resultText: 'Task created', isError: false }] });
});

test('real subsessions do not leave permanently active duplicate planning tasks', () => {
  const result = deriveCloudActivityFromTurn({ sessionId: 'parent', localAccountId: 'owner', participantAccountIds: ['owner', 'peer'], turn: {
    id: 'parent-turn', sessionId: 'parent', prompt: 'Research', status: 'succeeded', message: '', assistantText: 'Started', thinkingText: '', completed: true, succeeded: true,
    tools: [{ id: 'spawn', name: 'task_operator', status: 'completed', arguments: '{"action":"spawn","task_name":"research","taskTitle":"Research"}', liveOutput: '', isError: false,
      resultText: 'Background session: {"sessionId":"child","title":"Research","status":"running"}' }],
  } });
  assert.equal(result.tasks.length, 0);
});
