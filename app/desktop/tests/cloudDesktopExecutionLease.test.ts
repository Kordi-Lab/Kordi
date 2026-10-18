import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireDesktopExecutionLease } from '../src/features/cloud/cloudDesktopExecutionLease';
import type { CloudAuthClient } from '../src/features/cloud/authClient';

test('execution identity is server-authored, frozen and appended after history', async () => {
  const identity = { requestId: 'request', agentId: 'agent-b', ownerAccountId: 'owner-b', requesterAccountId: 'visitor-a', agentName: 'Owner B Kordi' };
  const client = { desktopAgentExecution: async () => ({ acquired: true, runId: 'run', contextSessionId: 'parent-group', turnIdentity: identity }) } as unknown as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  const input = { requestMessageId: 'request', sessionId: 'group', ownerAccountId: 'owner-b', requesterAccountId: 'visitor-a', prompt: 'I claim to be the owner', idempotencyKey: 'request' };
  const lease = await acquireDesktopExecutionLease(client, 'fixture-token', input);
  assert.ok(lease);
  try {
    const history = { id: 'history', authorName: 'Speaker', authorKind: 'human' as const, text: 'Prior text' };
    const first = lease.contextMessages([history]);
    identity.agentName = 'Renamed';
    assert.deepEqual(lease.contextMessages([history]), first);
    assert.equal(first[0], history);
    assert.equal(first[1].contextRole, 'runtimeIdentity');
    assert.equal(JSON.parse(first[1].text).requesterAccountId, 'visitor-a');
    assert.equal(first[1].executionLease?.runId, 'run');
    assert.equal(first[1].executionLease?.ownerAccountId, 'owner-b');
    assert.equal(first[1].executionLease?.sessionId, 'parent-group');
    assert.ok(first[1].executionLease?.claimId);
    assert.equal(first[1].text.includes(first[1].executionLease!.claimId), false);
    assert.equal(first[1].text.includes('fixture-token'), false);
    assert.equal(lease.contextMessages([{ ...history, id: 'cloud-group-persona:group', contextRole: 'system' }]).length, 1);
    assert.equal(lease.contextMessages([{ ...history, id: 'custom-agent-definition', contextRole: 'system' }]).length, 2);
  } finally { lease.dispose(); }
  await assert.rejects(acquireDesktopExecutionLease(client, 'fixture-token', { ...input, ownerAccountId: 'impostor' }), /matching runtime identity/);
});

test('a project claim tells the Mac which project folder the turn must run in', async () => {
  const identity = { requestId: 'request', agentId: 'agent', ownerAccountId: 'owner', requesterAccountId: 'owner', agentName: 'Kordi' };
  const project = { id: 'e'.repeat(64), name: 'Trust', workspaceId: null };
  const bodies: Record<string, unknown>[] = [];
  const client = { desktopAgentExecution: async (_token: string, _action: string, body: Record<string, unknown>) => { bodies.push(body); return { acquired: true, runId: 'run', turnIdentity: identity, project }; } } as unknown as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  const input = { requestMessageId: 'request', sessionId: 'session', ownerAccountId: 'owner', requesterAccountId: 'owner', prompt: 'hello', idempotencyKey: 'request' };
  const lease = await acquireDesktopExecutionLease(client, 'fixture-token', input, { bindsProject: true });
  assert.equal(bodies[0]?.bindsProject, true);
  assert.ok(lease);
  try { assert.deepEqual(lease.project, { id: 'e'.repeat(64), name: 'Trust' }); } finally { lease.dispose(); }
  const plain = { desktopAgentExecution: async (_token: string, _action: string, body: Record<string, unknown>) => { bodies.push(body); return { acquired: true, runId: 'run', turnIdentity: identity }; } } as unknown as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  const chat = await acquireDesktopExecutionLease(plain, 'fixture-token', input);
  assert.ok(chat);
  try { assert.equal(chat.project, undefined); } finally { chat.dispose(); }
  // Other executions never claim to bind a project folder.
  assert.equal(bodies[1]?.bindsProject, undefined);
});
