import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCloudSelfAgentSessionPlanner } from '../src/features/cloud/cloudSelfAgentSessionPlan';
import { cloudSelfAgentForwardMessageKind } from '../src/features/cloud/cloudSelfAgentForwardPolicy';
import type { CanonicalSessionState } from '../src/kordi-app/types';

test('Cloud hydration repairs a published custom-agent session instead of renaming it My Kordi', () => {
  const sessionId = 'session:direct-agent:stock';
  const customIdentityId = 'agent:cloud-agent:stock';
  const state = {
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'US Stock Paper Trader',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'agent:cloud-self:me',
      metadata: {
        createdFrom: 'chat-create-flow',
        agentId: 'cloud-agent:cloud_agent_stock',
        cloudAgentId: 'cloud_agent_stock',
      },
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    identities: [{
      id: customIdentityId,
      kind: 'agent',
      displayName: 'US Stock Paper Trader',
      agentId: 'cloud-agent:cloud_agent_stock',
      metadata: { agentId: 'cloud-agent:cloud_agent_stock', isOwned: true },
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    messages: [],
    participants: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;
  const planner = createCloudSelfAgentSessionPlanner({
    state,
    forksBySessionId: {},
    cloudTitlesBySessionId: {},
    localHumanIdentityId: 'human:me',
    agentIdentityId: 'agent:cloud-self:me',
  });

  planner.ensure(sessionId, 'hello');

  assert.equal(planner.requests[0]?.kind, 'direct-agent');
  assert.equal(planner.requests[0]?.primaryIdentityId, customIdentityId);
  assert.deepEqual(planner.requests[0]?.participantIdentityIds, [customIdentityId]);
});

test('all locally executed owned-agent turns sync as non-executable history', () => {
  const historySessionIds = new Set(['session:self-agent:local', 'session:direct-agent:stock']);

  assert.equal(cloudSelfAgentForwardMessageKind({
    sessionId: 'session:self-agent:local',
    role: 'user',
  }, historySessionIds), 'canonical-history-user');
  assert.equal(cloudSelfAgentForwardMessageKind({
    sessionId: 'session:direct-agent:stock',
    role: 'agent',
  }, historySessionIds), 'canonical-history-agent');
  assert.equal(cloudSelfAgentForwardMessageKind({
    sessionId: 'session:remote',
    role: 'user',
  }, historySessionIds), null);
});
