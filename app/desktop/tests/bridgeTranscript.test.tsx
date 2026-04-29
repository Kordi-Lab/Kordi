import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapBridgeConversationToViewModel } from '../src/features/bridge/transcript';
import type { DesktopBridgeConversation, DesktopBridgeHost } from '../src/kordi-app/types';

function host(): DesktopBridgeHost {
  return {
    id: 'host-1',
    registered: true,
    connected: true,
    serverUrl: 'https://bridge.test',
    nodeId: 'node-me',
    displayName: 'My Kordi',
    ownerName: 'Me',
    endpoint: 'https://bridge.test',
    tokenPresent: true,
    humanId: 'human-me',
    discoveryMode: 'ask',
    activeAgentId: null,
    agents: [],
    visiblePeers: [],
    visiblePeerCount: 0,
    projects: [],
  };
}

function conversation(overrides: Partial<DesktopBridgeConversation> = {}): DesktopBridgeConversation {
  return {
    id: 'bridge:host-1:node-peer:person',
    canonicalSessionId: 'session:bridge:humans:peer',
    hostId: 'host-1',
    peerNodeId: 'node-peer',
    peerDisplayName: 'Shenzhe',
    peerOwnerName: 'Shenzhe',
    peerRuntime: 'person',
    projectId: null,
    projectName: null,
    title: 'Shenzhe',
    subtitle: 'hi',
    unreadCount: 0,
    updatedAtMs: 1,
    updatedAtLabel: '16:39',
    awaitingReply: false,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: null,
    identity: null,
    messages: [],
    ...overrides,
  };
}

test('bridge transcript keeps implicit direct person session messages as typed', () => {
  const requestId = 'bridge_req_direct';
  const view = mapBridgeConversationToViewModel(conversation({
    messages: [{
      id: 'msg-direct',
      direction: 'outbound',
      sender: 'Me',
      text: 'hello',
      timeLabel: '17:01',
      timestampMs: 1,
      requestId,
      deliveryState: 'read',
      outreach: {
        targetKind: 'bridge-person',
        parentSessionId: 'd17bf74f-f065-46cb-82d7-bf78ed7f910f',
        bridgeHostId: 'host-1',
        bridgeConversationId: 'bridge:host-1:node-peer:person',
        bridgeRequestId: requestId,
        targetNodeId: 'node-peer',
        targetDisplayName: "Shenzhe's Kordi",
        targetOwnerName: 'Shenzhe',
        targetRuntime: 'person',
        requestText: 'hello',
        triggerText: null,
        contextText: null,
        contextPolicy: 'session-message',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }],
  }), host(), 'My Kordi');

  assert.equal(view.messages[0]?.text, 'hello');
  assert.equal(view.messages[0]?.mentions, undefined);
});

test('direct person bridge transcript renders local agent responses as agent turns', () => {
  const view = mapBridgeConversationToViewModel(conversation({
    messages: [{
      id: 'msg-local-agent-response',
      direction: 'outbound-response',
      sender: "Shuyang's Kordi",
      text: 'We were talking about San Diego weather.',
      timeLabel: '17:07',
      timestampMs: 2,
      requestId: 'bridge_req_agent',
      deliveryState: 'responded',
      outreach: null,
    }],
  }), host(), 'My Kordi');

  const message = view.messages[0];
  assert.equal(message?.role, 'owned-agent');
  assert.equal(message?.senderType, 'agent');
  assert.equal(message?.sender, "Shuyang's Kordi");
  assert.equal(message?.text, '');
  assert.equal(message?.turn?.assistantText, 'We were talking about San Diego weather.');
  assert.deepEqual(message?.turn?.tools, []);
});

test('direct person bridge transcript renders remote agent responses as agent turns', () => {
  const view = mapBridgeConversationToViewModel(conversation({
    messages: [{
      id: 'msg-remote-agent-response',
      direction: 'inbound-response',
      sender: "Shenzhe's Kordi",
      text: 'The answer is ready.',
      timeLabel: '17:08',
      timestampMs: 2,
      requestId: 'bridge_req_remote_agent',
      deliveryState: 'responded',
      outreach: null,
    }],
  }), host(), 'My Kordi');

  const message = view.messages[0];
  assert.equal(message?.role, 'external-agent');
  assert.equal(message?.senderType, 'agent');
  assert.equal(message?.sender, "Shenzhe's Kordi");
  assert.equal(message?.text, '');
  assert.equal(message?.turn?.assistantText, 'The answer is ready.');
  assert.deepEqual(message?.turn?.tools, []);
});

test('bridge transcript preserves full outreach mention labels with spaces and punctuation', () => {
  const requestId = 'bridge_req_mention';
  const view = mapBridgeConversationToViewModel(conversation({
    outreach: {
      targetKind: 'bridge-agent',
      parentSessionId: 'session:bridge:humans:peer',
      bridgeHostId: 'host-1',
      bridgeConversationId: 'bridge:host-1:node-peer:person',
      bridgeRequestId: requestId,
      targetNodeId: 'node-agent',
      targetDisplayName: "Shenzhe's Kordi",
      targetOwnerName: 'Shenzhe',
      targetRuntime: 'kordi-desktop',
      requestText: 'hi',
      status: 'completed',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [{
      id: 'msg-1',
      direction: 'outbound',
      sender: 'Me',
      text: 'hi',
      timeLabel: '16:39',
      timestampMs: 1,
      requestId,
      deliveryState: 'read',
      outreach: null,
    }],
  }), host(), 'My Kordi');

  assert.equal(view.messages[0]?.text, "@Shenzhe's Kordi hi");
  assert.deepEqual(view.messages[0]?.mentions?.map((mention) => mention.label), ["Shenzhe's Kordi"]);
});
