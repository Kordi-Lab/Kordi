import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBridgeMentionTargetsByScope } from '../src/app/useKordiAppModelBridgeMentions';
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
