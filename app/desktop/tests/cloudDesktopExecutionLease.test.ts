import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { acquireDesktopExecutionLease } from '../src/features/cloud/cloudDesktopExecutionLease';
import type { CloudAuthClient } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';

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

async function leaseWithRenewals(renew: () => Promise<unknown>) {
  const identity = { requestId: 'request', agentId: 'agent', ownerAccountId: 'owner', requesterAccountId: 'owner', agentName: 'Kordi' };
  const client = {
    desktopAgentExecution: async (_token: string, action: string) => (action === 'claim'
      ? { acquired: true, runId: 'run', turnIdentity: identity }
      : renew()),
  } as unknown as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  const input = { requestMessageId: 'request', sessionId: 'session', ownerAccountId: 'owner', requesterAccountId: 'owner', prompt: 'Review disk usage', idempotencyKey: 'request' };
  const lease = await acquireDesktopExecutionLease(client, 'fixture-token', input);
  assert.ok(lease);
  return lease;
}

async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    mock.timers.tick(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('a transient renewal failure keeps a long local turn running', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  let calls = 0;
  const lease = await leaseWithRenewals(async () => {
    calls += 1;
    if (calls <= 2) throw new CloudAuthError('network_error', 'Cloud request timed out. Check your connection and try again.', 0);
    return { ok: true, cancelRequested: false };
  });
  try {
    // Two timed-out renewals, then the network recovers.
    await advance(60_000);
    assert.equal(lease.lost, false);
    assert.ok(calls > 2);
  } finally { lease.dispose(); mock.timers.reset(); }
});

test('a refused renewal or an unrenewed deadline ends the lease', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const refused = await leaseWithRenewals(async () => { throw new CloudAuthError('execution_lease_lost', 'This runtime no longer owns the request.', 409); });
  const unreachable = await leaseWithRenewals(async () => { throw new CloudAuthError('network_error', 'Network request failed.', 0); });
  try {
    await advance(6_000);
    assert.equal(refused.lost, true);
    assert.equal(unreachable.lost, false);
    await advance(40_000);
    assert.equal(unreachable.lost, true);
  } finally { refused.dispose(); unreachable.dispose(); mock.timers.reset(); }
});

test('a timed-out admission is sent again while the lease holds', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
  let admits = 0;
  const lease = await leaseWithRenewals(async () => {
    admits += 1;
    if (admits === 1) throw new CloudAuthError('network_error', 'Cloud request timed out. Check your connection and try again.', 0);
    return { admitted: true, cancelRequested: false };
  });
  try {
    const admitted = lease.admitted();
    await advance(2_000);
    assert.equal(await admitted, true);
    assert.equal(admits, 2);
  } finally { lease.dispose(); mock.timers.reset(); }
});

test('a refused admission or an unreachable server past the deadline still fails', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
  const refused = await leaseWithRenewals(async () => { throw new CloudAuthError('execution_lease_lost', 'This runtime no longer owns the request.', 409); });
  const unreachable = await leaseWithRenewals(async () => { throw new CloudAuthError('network_error', 'Network request failed.', 0); });
  try {
    await assert.rejects(refused.admitted(), /no longer owns/);
    const pending = assert.rejects(unreachable.admitted(), /Execution lease lost/);
    await advance(42_000);
    await pending;
  } finally { refused.dispose(); unreachable.dispose(); mock.timers.reset(); }
});
