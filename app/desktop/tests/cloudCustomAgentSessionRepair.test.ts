import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import { createCloudSelfAgentSessionPlanner } from '../src/features/cloud/cloudSelfAgentSessionPlan';
import {
  cloudSelfAgentForwardMessageKind,
  cloudSelfAgentShouldPublishProgress,
} from '../src/features/cloud/cloudSelfAgentForwardPolicy';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const sessionId = 'session:direct-agent:stock';
const customIdentityId = 'agent:cloud-agent:stock';

function customAgentState() {
  return {
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
    profile: { id: 'profile', humanIdentityId: 'human:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;
}

test('Cloud hydration repairs a published custom-agent session instead of renaming it My Kordi', () => {
  const state = customAgentState();
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

test('Cloud response rows keep the configured custom-agent sender identity', () => {
  const account: CloudAccount = {
    accountId: 'acct_me',
    displayName: 'Me',
    primaryEmail: 'me@example.com',
    avatarUrl: null,
    avatar: cloudAccountAvatarFixture,
    nodeId: 'node_me',
    passwordSet: true,
  };
  const request: CloudMessage = {
    messageId: 'request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'hello',
    direction: 'outgoing',
    sessionId,
    createdAt: '2026-08-20T12:00:00Z',
    deliveredAt: null,
    readAt: null,
  };
  const response: CloudMessage = {
    ...request,
    messageId: 'response',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'hello from the stock agent',
      deliveryState: 'complete',
    }),
    createdAt: '2026-08-20T12:00:01Z',
  };

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [request, response],
    state: customAgentState(),
  });

  assert.equal(
    plan.messageRequests.find((message) => message.senderRole === 'owned-agent')?.senderIdentityId,
    customIdentityId,
  );
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
  assert.equal(cloudSelfAgentShouldPublishProgress('session:self-agent:local', historySessionIds), false);
  assert.equal(cloudSelfAgentShouldPublishProgress('session:self-agent:local', historySessionIds, true), true);
  assert.equal(cloudSelfAgentShouldPublishProgress('session:remote', historySessionIds), true);
});
