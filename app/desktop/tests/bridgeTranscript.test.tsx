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
