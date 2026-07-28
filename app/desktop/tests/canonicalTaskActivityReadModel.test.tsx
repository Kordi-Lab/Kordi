import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';

test('canonical read model maps delegated exchanges to task activity with participants', () => {
  const sessionId = 'session:group:task-read-model';
  const state = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-alice', humanId: 'human-alice', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:alice', kind: 'agent', displayName: 'Alice Kordi', source: 'bridge', sourceHostId: 'host-1', ownerIdentityId: 'human:alice', sourceIdentityId: 'node-alice', agentId: 'agent-alice', avatarKey: 'agent-alice', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Task group', status: 'active', createdByIdentityId: 'human:me', metadata: { source: 'chat-create-flow' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:alice', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [],
    delegatedExchanges: [
      {
        id: 'delegation:bridge-session-message:session:group:task-read-model:bridge_req_task',
        sessionId,
        initiatorIdentityId: 'human:me',
        targetIdentityId: 'agent:alice',
        triggerMessageId: 'msg:parent',
        requestMessageId: 'msg:parent',
        responseMessageId: null,
        transport: 'bridge',
        sourceHostId: 'host-1',
        sourceConversationId: 'bridge:host:alice-agent',
        sourceRequestId: 'bridge_req_task',
        contextPolicy: 'session-message',
        status: 'processing',
        error: null,
        createdAtMs: 2,
        updatedAtMs: 3,
      },
      {
        id: 'delegation:human-fanout-copy',
        sessionId,
        initiatorIdentityId: 'human:me',
        targetIdentityId: 'human:alice',
        triggerMessageId: 'msg:parent',
        requestMessageId: 'msg:parent',
        responseMessageId: null,
        transport: 'bridge',
        sourceHostId: 'host-1',
        sourceConversationId: 'bridge:host:alice-person',
        sourceRequestId: 'bridge_req_human_fanout',
        contextPolicy: 'session-message',
        status: 'complete',
        error: null,
        createdAtMs: 2,
        updatedAtMs: 4,
      },
    ],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(state as never);
  const conversation = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '')[0];

  assert.equal(conversation?.canonicalDelegatedExchangeCount, 1);
  assert.equal(conversation?.taskActivities?.length, 1);
  assert.equal(conversation?.taskActivities?.[0]?.target?.name, "Alice's Alice Kordi");
  assert.equal(conversation?.taskActivities?.[0]?.initiator?.name, 'Me');
  assert.deepEqual(conversation?.taskActivities?.[0]?.participants.map((participant) => participant.name), ['Me', 'Alice', "Alice's Alice Kordi"]);
  assert.equal(conversation?.taskActivities?.[0]?.sourceRequestId, 'bridge_req_task');
});

test('canonical read model exposes shared model-created task tools from external agent relay messages', () => {
  const sessionId = 'session:group:shared-model-task';
  const state = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-alice', humanId: 'human-alice', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:alice', kind: 'agent', displayName: 'Alice Kordi', source: 'bridge', sourceHostId: 'host-1', ownerIdentityId: 'human:alice', sourceIdentityId: 'node-alice', agentId: 'agent-alice', avatarKey: 'agent-alice', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Task group', status: 'active', createdByIdentityId: 'human:me', metadata: { source: 'chat-create-flow' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:alice', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [{
      id: 'msg:agent-response',
      sessionId,
      senderIdentityId: 'agent:alice',
      senderRole: 'external-agent',
      messageKind: 'agent-turn',
      contentText: 'Done — I created a temporary test task for us and marked it complete.',
      content: {
        kind: 'session-relay',
        deliveryState: 'responded',
        parentSessionKind: 'group',
        parentSessionTitle: 'Release planning',
        tools: [{
          id: 'tool:task-operator',
          name: 'task_operator',
          status: 'done',
          arguments: JSON.stringify({ taskTitle: 'Temporary Test Task', plan: [] }),
          liveOutput: '',
          resultText: 'Done',
          isError: false,
        }],
      },
      parentMessageId: 'msg:user-request',
      delegatedExchangeId: null,
      status: 'complete',
      sourceTransport: 'desktop-bridge-session-relay',
      sourceEventId: 'desktop-bridge-session-relay:shared-task',
      createdAtMs: 3,
      updatedAtMs: 3,
      sequenceNum: 1,
      contentHash: 'hash',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(state as never);
  const conversation = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '')[0];
  const dashboard = buildTaskActivityDashboard({ messages: conversation?.messages ?? [] });

  assert.equal(conversation?.messages[0]?.turn?.tools.length, 1);
  assert.equal(dashboard.tasks[0]?.title, 'Temporary Test Task');
  assert.equal(dashboard.tasks[0]?.target, 'Group: Release planning');
});
