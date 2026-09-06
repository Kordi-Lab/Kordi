import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentSubsessionStatusNotice, agentThreadElapsed, agentThreadStatus } from '../src/features/cloud/agentSubsessionTasks';
import type { AgentSubsessionTask } from '../src/features/cloud/agentSubsessionTypes';

const task: AgentSubsessionTask = { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'request',
  agentId: 'agent-one', ownerAccountId: 'owner', ownerDisplayName: 'Owner', agentDisplayName: 'Researcher',
  title: 'Research', status: 'done', executionBackend: 'desktop', startedAtMs: 1000, finishedAtMs: 64000,
  heartbeatAtMs: 64000, live: false, queued: false };

test('parent cards distinguish queued work and expired heartbeats without changing terminal results', () => {
  assert.equal(agentSubsessionStatusNotice({ status: 'running', live: false, startedAtMs: 1 }), 'Status unavailable');
  assert.equal(agentSubsessionStatusNotice({ status: 'running', live: false, queued: true, startedAtMs: null }), 'Queued next');
  assert.equal(agentSubsessionStatusNotice({ status: 'running', live: true }), null);
  assert.equal(agentSubsessionStatusNotice({ status: 'done', live: false }), null);
  assert.equal(agentSubsessionStatusNotice({ status: 'running' }), null);
});

test('finished execution clocks do not grow while a conversation waits for another message', () => {
  assert.equal(agentThreadStatus(task), 'Done');
  assert.equal(agentThreadElapsed(task, 100000000), '1m 3s');
  assert.equal(agentThreadElapsed(task, 200000000), '1m 3s');
  assert.equal(agentThreadElapsed({ ...task, startedAtMs: null }), null);
  assert.equal(agentThreadElapsed({ ...task, finishedAtMs: 0 }), null);
});

test('active clocks reset per execution and stop when no runtime is confirmed', () => {
  const running = { ...task, status: 'running', live: true, finishedAtMs: null, startedAtMs: 100000 };
  assert.equal(agentThreadElapsed(running, 105000), '5s');
  assert.equal(agentThreadStatus(running), 'Running');
  assert.equal(agentThreadElapsed({ ...running, startedAtMs: 104000 }, 105000), '1s');
  assert.equal(agentThreadStatus({ ...running, live: false, queued: true }), 'Status unavailable');
  assert.equal(agentThreadElapsed({ ...running, live: false }, 999999999), null);
  assert.equal(agentThreadStatus({ ...running, startedAtMs: null, live: false, queued: true }), 'Queued next');
  assert.equal(agentThreadElapsed({ ...task, queued: true }), null);
});
