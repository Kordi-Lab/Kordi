import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBridgeMentionTargetsByScope, mentionableCloudAgentSummaries, sharedCloudAgentOwnerIdsForMentionScope } from '../src/app/useKordiAppModelBridgeMentions';
import type { Conversation, DesktopBridgeState, DesktopChatState } from '../src/kordi-app/types';

function bridgeState(): DesktopBridgeState {
  return {
    configPath: '/tmp/bridge.json',
    legacyConfigPath: '/tmp/legacy-bridge.json',
    conversationsPath: '/tmp/conversations.json',
    activeHostId: 'host-1',
    hosts: [{
      id: 'host-1',
      registered: true,
      connected: true,
      serverUrl: 'https://bridge.test',
      nodeId: 'node-local',
      displayName: 'Alice Kordi',
      ownerName: 'Alice',
      endpoint: 'https://alice.example',
      tokenPresent: true,
      humanId: 'human-alice',
      discoveryMode: 'manual',
      activeAgentId: 'agent-local',
      agents: [{
        id: 'agent-local',
        label: 'Kordi',
        nodeId: 'node-agent-local',
        runtime: 'kordi-desktop',
        isDefault: true,
        isActive: true,
        registered: true,
      }],
      visiblePeers: [],
      visiblePeerCount: 0,
      projects: [],
    }],
    conversations: [],
    localServer: { running: true, serverUrl: 'http://127.0.0.1:1234' },
  };
}

function desktopChatState(): DesktopChatState {
  return {
    localAgent: {
      label: 'My runtime Kordi',
      systemPrompt: '',
      loadedSkills: [],
      loadedTools: [],
      loadedPlugins: [],
      identityFiles: [],
      defaultProvider: '',
      defaultModel: '',
      workspaceRoot: '',
      lastActivities: [],
    },
  } as DesktopChatState;
}

test('buildBridgeMentionTargetsByScope returns empty targets outside the native shell', () => {
  const targets = buildBridgeMentionTargetsByScope({
    isNativeShell: false,
    desktopBridgeState: null,
    desktopChatState: null,
    activeConvMentionScope: null,
  });

  assert.deepEqual(targets, { chat: [], project: [] });
});

test('buildBridgeMentionTargetsByScope carries unread count for matching mention participants', () => {
  const state = bridgeState();
  state.hosts[0].visiblePeers = [{
    endpoint: 'https://bob.example',
    nodeId: 'node-bob',
    displayName: 'Bob',
    ownerName: 'Bob',
    runtime: 'person',
    humanId: 'human-bob',
    agentId: null,
    isContact: true,
    contactRequestStatus: 'approved',
    sharedProjects: [],
  }];
  const conversations: Conversation[] = [{
    id: 'bridge:host-1:node-bob:person',
    canonicalSessionId: 'bridge:host-1:node-bob:person',
    name: 'Bob',
    type: 'bridge-person',
    subtitle: 'Unread hello',
    unread: 3,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Alice', 'Bob'],
    messages: [],
    bridgeTarget: { hostId: 'host-1', nodeId: 'node-bob', humanId: 'human-bob', runtime: 'person' },
  }];

  const targets = buildBridgeMentionTargetsByScope({
    isNativeShell: true,
    desktopBridgeState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: null,
    conversations,
  });

  assert.equal(targets.chat.find((target) => target.nodeId === 'node-bob')?.unreadCount, 3);
});

test('buildBridgeMentionTargetsByScope includes the scoped local Bridge agent', () => {
  const targets = buildBridgeMentionTargetsByScope({
    isNativeShell: true,
    desktopBridgeState: bridgeState(),
    desktopChatState: desktopChatState(),
    activeConvMentionScope: null,
  });

  assert.equal(targets.chat[0]?.label, 'My Kordi');
  assert.equal(targets.chat[0]?.value, 'MyKordi');
  assert.equal(targets.chat[0]?.targetKind, 'bridge-agent');
  assert.equal(targets.chat[0]?.nodeId, 'node-agent-local');
  assert.equal(targets.project[0]?.label, 'My Kordi');
});

test('buildBridgeMentionTargetsByScope hides chat mentions in direct agent sessions', () => {
  const targets = buildBridgeMentionTargetsByScope({
    isNativeShell: true,
    desktopBridgeState: bridgeState(),
    desktopChatState: desktopChatState(),
    activeConvMentionScope: {
      id: 'session:agent',
      canonicalSessionId: 'session:agent',
      name: 'My Kordi',
      type: 'owned-agent',
      subtitle: '',
      unread: 0,
      bridges: ['Local'],
      trust: 'Owned',
      directness: 'Direct chat',
      participants: ['Me', 'My Kordi'],
      messages: [],
    } as Conversation,
  });

  assert.deepEqual(targets.chat, []);
  assert.equal(targets.project[0]?.label, 'My Kordi');
});

test('mentionableCloudAgentSummaries merges owned shared Cloud Agents for owner autocomplete and send resolution', () => {
  const summaries = mentionableCloudAgentSummaries({
    sharedCloudAgents: [{
      agentId: 'cloud_agent_remote',
      ownerAccountId: 'acct_remote',
      ownerDisplayName: 'Remote',
      accessScope: 'participant_conversations',
      name: 'Remote Driver',
      role: 'Remote helper',
      description: null,
      updatedAt: '2026-06-20T00:00:00Z',
    }],
    ownedCloudAgentsById: {
      cloud_agent_private: {
        agentId: 'cloud_agent_private',
        ownerAccountId: 'acct_me',
        accessScope: 'private',
        status: 'active',
        name: 'Private Notes',
        role: 'Private helper',
        description: null,
        systemPrompt: 'private prompt',
        sourceSummary: null,
        boundaries: [],
        resources: [],
        skills: [],
        modelRouting: {},
        createdAt: '2026-06-20T00:00:00Z',
        updatedAt: '2026-06-20T00:00:00Z',
        archivedAt: null,
      },
      cloud_agent_project: {
        agentId: 'cloud_agent_project',
        ownerAccountId: 'acct_me',
        accessScope: 'participant_conversations',
        status: 'active',
        name: 'Kordi Project Driver',
        role: 'Project helper',
        description: 'Moves work forward',
        systemPrompt: 'secret prompt',
        sourceSummary: null,
        boundaries: [],
        resources: [],
        skills: [],
        modelRouting: { defaultModel: 'private/model' },
        createdAt: '2026-06-20T00:00:00Z',
        updatedAt: '2026-06-20T00:01:00Z',
        archivedAt: null,
      },
    },
    ownerDisplayName: '111',
  });

  assert.deepEqual(
    summaries.map((agent) => `${agent.ownerDisplayName}:${agent.name}:${agent.agentId}`),
    ['Remote:Remote Driver:cloud_agent_remote', '111:Kordi Project Driver:cloud_agent_project'],
  );
  assert.equal('systemPrompt' in (summaries[1] as object), false);
  assert.equal('modelRouting' in (summaries[1] as object), false);
});

test('buildBridgeMentionTargetsByScope includes shared hosted Cloud Agents for conversation participants', () => {
  const state = bridgeState();
  state.activeHostId = 'cloud';
  state.hosts = [{
    ...state.hosts[0],
    id: 'cloud',
    nodeId: 'acct_me',
    humanId: 'acct_me',
    ownerName: '222',
    displayName: '222',
    agents: [{
      ...state.hosts[0].agents[0],
      id: 'cloud-local-agent',
      nodeId: 'acct_me',
      runtime: 'kordi-desktop',
    }],
    visiblePeers: [],
    visiblePeerCount: 0,
  }];
  const group = {
    id: 'session:group:cloud',
    canonicalSessionId: 'session:group:cloud',
    name: 'Cloud group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    bridges: ['cloud'],
    trust: 'Cloud',
    directness: 'Group chat',
    participantSpaceId: 'group:cloud',
    participants: ['222', '111'],
    canonicalParticipants: [
      { id: 'human:acct_me', name: '222', kind: 'human', role: 'self', source: 'local', humanId: 'acct_me', bridgeNodeId: 'acct_me' },
      { id: 'human:acct_owner', name: '111', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'cloud', humanId: 'acct_owner', bridgeNodeId: 'acct_owner' },
    ],
    messages: [],
  } as Conversation;

  const targets = buildBridgeMentionTargetsByScope({
    isNativeShell: true,
    desktopBridgeState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: group,
    sharedCloudAgents: [{
      agentId: 'cloud_agent_project',
      ownerAccountId: 'acct_owner',
      ownerDisplayName: '111',
      accessScope: 'participant_conversations',
      name: 'Kordi Project Driver',
      role: 'Project helper',
      description: null,
      updatedAt: '2026-06-20T00:00:00Z',
    }],
  });

  const projectDriver = targets.chat.find((target) => target.agentId === 'cloud_agent_project');
  assert.equal(projectDriver?.label, 'Kordi Project Driver');
  assert.equal(projectDriver?.value, 'KordiProjectDriver');
  assert.equal(projectDriver?.bridgeHostId, 'cloud');
  assert.equal(projectDriver?.nodeId, 'acct_owner');
  assert.equal(projectDriver?.ownerName, '111');
});

test('sharedCloudAgentOwnerIdsForMentionScope uses direct contact bridge targets when canonical participants are absent', () => {
  assert.deepEqual(sharedCloudAgentOwnerIdsForMentionScope({
    id: 'bridge:cloud:acct_owner:person',
    canonicalSessionId: 'bridge:cloud:acct_owner:person',
    type: 'person',
    directness: 'Direct chat',
    participants: ['222', '111'],
    bridgeTarget: { hostId: 'cloud', nodeId: 'acct_owner', humanId: 'acct_owner', runtime: 'person' },
  } as Conversation, 'acct_me'), ['acct_owner']);
});

test('buildBridgeMentionTargetsByScope includes my owned shared Cloud Agent in direct contact chats', () => {
  const state = bridgeState();
  state.activeHostId = 'cloud';
  state.hosts = [{
    ...state.hosts[0],
    id: 'cloud',
    nodeId: 'acct_me',
    humanId: 'acct_me',
    ownerName: '111',
    displayName: '111',
    agents: [{
      ...state.hosts[0].agents[0],
      id: 'cloud-local-agent',
      nodeId: 'acct_me',
      runtime: 'kordi-desktop',
    }],
    visiblePeers: [],
    visiblePeerCount: 0,
  }];
  const directContact = {
    id: 'bridge:cloud:acct_222:person',
    canonicalSessionId: 'bridge:cloud:acct_222:person',
    name: '222',
    type: 'person',
    subtitle: '',
    unread: 0,
    bridges: ['cloud'],
    trust: 'Cloud',
    directness: 'Direct chat',
    participants: ['111', '222'],
    bridgeTarget: { hostId: 'cloud', nodeId: 'acct_222', humanId: 'acct_222', ownerName: '222', runtime: 'person' },
    messages: [],
  } as Conversation;

  const targets = buildBridgeMentionTargetsByScope({
    isNativeShell: true,
    desktopBridgeState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: directContact,
    sharedCloudAgents: [{
      agentId: 'cloud_agent_project',
      ownerAccountId: 'acct_me',
      ownerDisplayName: '111',
      accessScope: 'participant_conversations',
      name: 'Kordi Project Driver',
      role: 'Project helper',
      description: null,
      updatedAt: '2026-06-20T00:00:00Z',
    }],
  });

  const projectDriver = targets.chat.find((target) => target.agentId === 'cloud_agent_project');
  assert.equal(projectDriver?.label, 'Kordi Project Driver');
  assert.equal(projectDriver?.value, 'KordiProjectDriver');
  assert.equal(projectDriver?.nodeId, 'acct_me');
});

test('buildBridgeMentionTargetsByScope includes shared hosted Cloud Agents in direct contact chats with the owner', () => {
  const state = bridgeState();
  state.activeHostId = 'cloud';
  state.hosts = [{
    ...state.hosts[0],
    id: 'cloud',
    nodeId: 'acct_me',
    humanId: 'acct_me',
    ownerName: '222',
    displayName: '222',
    agents: [{
      ...state.hosts[0].agents[0],
      id: 'cloud-local-agent',
      nodeId: 'acct_me',
      runtime: 'kordi-desktop',
    }],
    visiblePeers: [],
    visiblePeerCount: 0,
  }];
  const directContact = {
    id: 'bridge:cloud:acct_owner:person',
    canonicalSessionId: 'bridge:cloud:acct_owner:person',
    name: '111',
    type: 'bridge-person',
    subtitle: '',
    unread: 0,
    bridges: ['cloud'],
    trust: 'Cloud',
    directness: 'Direct person chat',
    participants: ['222', '111'],
    bridgeTarget: { hostId: 'cloud', nodeId: 'acct_owner', humanId: 'acct_owner', ownerName: '111', runtime: 'person', agentId: null },
    messages: [],
  } as Conversation;

  const targets = buildBridgeMentionTargetsByScope({
    isNativeShell: true,
    desktopBridgeState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: directContact,
    sharedCloudAgents: [{
      agentId: 'cloud_agent_project',
      ownerAccountId: 'acct_owner',
      ownerDisplayName: '111',
      accessScope: 'participant_conversations',
      name: 'Kordi Project Driver',
      role: 'Project helper',
      description: null,
      updatedAt: '2026-06-20T00:00:00Z',
    }],
  });

  const projectDriver = targets.chat.find((target) => target.agentId === 'cloud_agent_project');
  assert.equal(projectDriver?.label, 'Kordi Project Driver');
  assert.equal(projectDriver?.nodeId, 'acct_owner');
  assert.equal(projectDriver?.ownerName, '111');
});

test('buildBridgeMentionTargetsByScope includes group-only people but only reachable agents', () => {
  const state = bridgeState();
  state.activeHostId = 'cloud';
  state.hosts = [{
    ...state.hosts[0],
    id: 'cloud',
    nodeId: 'acct_me',
    humanId: 'acct_me',
    ownerName: 'Me Cloud',
    displayName: 'Me Cloud',
    agents: [{
      ...state.hosts[0].agents[0],
      id: 'cloud-local-agent',
      nodeId: 'acct_me',
      runtime: 'kordi-desktop',
    }],
    visiblePeers: [{
      endpoint: 'cloud',
      nodeId: 'acct_alice',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'acct_alice',
      agentId: 'cloud-agent:acct_alice',
      isDefaultAgent: true,
      isContact: true,
      contactRequestStatus: 'approved',
      sharedProjects: [],
    }],
    visiblePeerCount: 1,
  }];
  const group = {
    id: 'session:group:cloud',
    canonicalSessionId: 'session:group:cloud',
    name: 'Cloud group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    bridges: ['cloud'],
    trust: 'Cloud',
    directness: 'Group chat',
    participantSpaceId: 'group:cloud',
    participants: ['Me Cloud', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:acct_me', name: 'Me Cloud', kind: 'human', role: 'self', source: 'local', humanId: 'acct_me', bridgeNodeId: 'acct_me' },
      { id: 'human:acct_alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'cloud', humanId: 'acct_alice', bridgeNodeId: 'acct_alice' },
      { id: 'human:acct_bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'cloud', humanId: 'acct_bob', bridgeNodeId: 'acct_bob' },
    ],
    messages: [],
  } as Conversation;

  const targets = buildBridgeMentionTargetsByScope({
    isNativeShell: true,
    desktopBridgeState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: group,
  });

  assert.deepEqual(
    targets.chat.map((target) => `${target.targetKind}:${target.label}:${target.nodeId}`),
    [
      'bridge-agent:My Kordi:acct_me',
      'bridge-person:Alice:acct_alice',
      "bridge-agent:Alice's Kordi:acct_alice",
      'bridge-person:Bob:acct_bob',
    ],
  );
  assert.equal(targets.chat.some((target) => target.label === "Bob's Kordi"), false);
});
