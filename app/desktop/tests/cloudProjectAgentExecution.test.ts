import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  planCloudSelfAgentSync,
  seedCloudSelfAgentForwardSyncLedger,
} from '../src/features/cloud/cloudSelfAgentForwardSync';
import { cloudSelfAgentForwardMessageKind, publishedSelfAgentRequestAlreadyExecutedLocally } from '../src/features/cloud/cloudSelfAgentForwardPolicy';
import { cloudSyncedLocalAgentSessionIds } from '../src/features/cloud/cloudSelfAgentSessionIdentity';
import { cloudSelfAgentRuntimeSessionId } from '../src/features/cloud/cloudAgentRuntime';
import { CLOUD_AGENT_RUNTIME_SESSION_PREFIX } from '../src/features/cloud/cloudAgentMessages';
import { createCloudSelfAgentSessionPlanner } from '../src/features/cloud/cloudSelfAgentSessionPlan';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const route = { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' };

function projectState() {
  return {
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
    sessions: [{
      id: 'project-session', kind: 'project', status: 'active', title: 'New session',
      projectId: 'project:/fixture/project', projectName: 'Project',
      metadata: { projectRoot: '/fixture/project', titleSource: 'placeholder' },
    }],
    messages: [{
      id: 'project-request', sessionId: 'project-session', senderIdentityId: 'human:me', senderRole: 'user',
      messageKind: 'text', contentText: 'Synthetic project request', status: 'sent',
      sequenceNum: 1, createdAtMs: 200, updatedAtMs: 200, sourceTransport: 'desktop-chat-ui',
      content: { deliveryState: 'sent', agentRuntimeRoute: route },
    }],
  } as unknown as CanonicalSessionState;
}

test('a hosted project message enters execution admission on its existing project session', () => {
  const state = projectState();
  const synced = cloudSyncedLocalAgentSessionIds(state);
  const operations = planCloudSelfAgentSync(state, {}, { createdAfterMs: 150 });
  assert.equal(operations.length, 1, 'A sent project request must reach the execution queue');
  const operation = operations[0];
  assert.equal(operation.localMessageId, 'project-request');
  assert.equal(cloudSelfAgentRuntimeSessionId(operation.sessionId), 'project-session');
  assert.deepEqual(operation.agentRuntimeRoute, { ...route, thinking: null });
  assert.equal(cloudSelfAgentForwardMessageKind(operation, synced), null);
  assert.equal(publishedSelfAgentRequestAlreadyExecutedLocally(operation), false);
});

test('project execution does not include contact sessions or internal agent runtimes', () => {
  const state = projectState();
  state.sessions.push(
    { ...state.sessions[0], id: 'contact-session', kind: 'direct-person' },
    { ...state.sessions[0], id: `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}internal` },
  );
  assert.deepEqual([...cloudSyncedLocalAgentSessionIds(state)], ['project-session']);
});

test('recovering a project forwards its new request without replaying older messages', () => {
  const state = projectState();
  state.messages.unshift({
    ...state.messages[0], id: 'old-project-request', sequenceNum: 0, createdAtMs: 100, updatedAtMs: 100,
  });
  const seeded = seedCloudSelfAgentForwardSyncLedger(state, {}, 250, 150);
  assert.ok(seeded.ledger['old-project-request']);
  assert.equal(seeded.ledger['project-request'], undefined);
  const operations = planCloudSelfAgentSync(state, seeded.ledger, { createdAfterMs: 150 });
  assert.deepEqual(operations.map((operation) => operation.localMessageId), ['project-request']);
  assert.equal(operations[0].historyOnly, undefined);
  assert.deepEqual(operations[0].agentRuntimeRoute, { ...route, thinking: null });
});

test('cloud request and reply synchronization preserves the local project workspace', () => {
  const state = projectState();
  const planner = createCloudSelfAgentSessionPlanner({
    state, forksBySessionId: {}, cloudTitlesBySessionId: {},
    localHumanIdentityId: 'human:me', agentIdentityId: 'agent:me',
  });
  planner.ensure('project-session', 'New project task', 'cloud-request', 250);
  const request = planner.requests[0];
  assert.ok(request, 'The synchronized request updates the placeholder title');
  assert.equal(request.kind, 'project');
  assert.equal(request.projectId, state.sessions[0].projectId);
  assert.equal(request.projectName, 'Project');
  assert.equal((request.metadata as Record<string, unknown>).projectRoot, '/fixture/project');
});
