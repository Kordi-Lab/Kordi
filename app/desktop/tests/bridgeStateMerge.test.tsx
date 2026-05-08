import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeDesktopBridgeState } from '../src/features/bridge/useBridgeState';
import type {
  DesktopBridgeConversation,
  DesktopBridgeConversationMessage,
  DesktopBridgeHost,
  DesktopBridgeState,
} from '../src/kordi-app/types';

function host(overrides: Partial<DesktopBridgeHost> = {}): DesktopBridgeHost {
  return {
    id: 'host-1',
    registered: true,
    connected: true,
    serverUrl: 'https://bridge.example',
    nodeId: 'kd_self',
    displayName: 'My Kordi',
    ownerName: 'Me',
    endpoint: 'https://bridge.example/kd_self',
    tokenPresent: true,
    humanId: 'kh_self',
    discoveryMode: 'open',
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    activeAgentId: 'ka_self',
    agents: [],
    visiblePeers: [],
    visiblePeerCount: 0,
    projects: [],
    contactRequests: [],
    lastError: null,
    ...overrides,
  };
}

function message(overrides: Partial<DesktopBridgeConversationMessage>): DesktopBridgeConversationMessage {
  return {
    id: 'message-1',
    direction: 'inbound',
    sender: 'Testuser4',
    text: 'hello',
    timeLabel: '13:13',
    timestampMs: 1_000,
    requestId: null,
    deliveryState: 'sent',
    outreach: null,
    attachments: [],
    ...overrides,
  };
}

function conversation(messages: DesktopBridgeConversationMessage[], overrides: Partial<DesktopBridgeConversation> = {}): DesktopBridgeConversation {
  return {
    id: 'conversation-1',
    canonicalSessionId: 'session:bridge:humans:abc',
    hostId: 'host-1',
    peerNodeId: 'kd_peer',
    peerDisplayName: 'Testuser4',
    peerOwnerName: 'Testuser4',
    peerRuntime: 'person',
    projectId: null,
    projectName: null,
    title: 'Testuser4',
    subtitle: messages[messages.length - 1]?.text ?? '',
    unreadCount: 0,
    updatedAtMs: 2_000,
    updatedAtLabel: '13:13',
    awaitingReply: false,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: null,
    identity: null,
    messages,
    ...overrides,
  };
}

function bridgeState(conversations: DesktopBridgeConversation[]): DesktopBridgeState {
  return {
    configPath: '/tmp/bridges.json',
    legacyConfigPath: '/tmp/legacy-bridges.json',
    conversationsPath: '/tmp/bridge-conversations.sqlite3',
    activeHostId: 'host-1',
    hosts: [host()],
    conversations,
    localServer: { running: false },
    localAgentRouting: null,
  };
}

test('mergeDesktopBridgeState keeps a bridge request before its agent response even when an update arrives reversed', () => {
  const request = message({
    id: 'request',
    direction: 'inbound',
    requestId: 'bridge_req_1',
    text: '@MyKordi who are you',
    timestampMs: 1_100,
  });
  const response = message({
    id: 'response',
    direction: 'outbound-response',
    sender: 'My Kordi',
    requestId: 'bridge_req_1',
    text: 'I am Kordi.',
    timestampMs: 1_200,
  });

  const current = bridgeState([conversation([])]);
  const next = bridgeState([conversation([response, request])]);

  const merged = mergeDesktopBridgeState(current, next);

  assert.deepEqual(
    merged?.conversations[0].messages.map((item) => item.id),
    ['request', 'response'],
  );
});

test('mergeDesktopBridgeState keeps locally cleared unread stable when a stale bridge snapshot replays the same request', () => {
  const request = message({
    id: 'request',
    direction: 'inbound',
    requestId: 'bridge_req_1',
    text: 'hello',
    timestampMs: 1_100,
  });

  const current = bridgeState([conversation([request], { unreadCount: 0 })]);
  const staleNext = bridgeState([conversation([request], { unreadCount: 1, updatedAtMs: 2_200 })]);

  const merged = mergeDesktopBridgeState(current, staleNext);

  assert.equal(merged?.conversations[0].unreadCount, 0);
});

test('mergeDesktopBridgeState accepts new unread when a later bridge snapshot includes a new inbound request', () => {
  const oldRequest = message({
    id: 'request-1',
    direction: 'inbound',
    requestId: 'bridge_req_1',
    text: 'hello',
    timestampMs: 1_100,
  });
  const newRequest = message({
    id: 'request-2',
    direction: 'inbound',
    requestId: 'bridge_req_2',
    text: 'are you there?',
    timestampMs: 1_300,
  });

  const current = bridgeState([conversation([oldRequest], { unreadCount: 0 })]);
  const next = bridgeState([conversation([oldRequest, newRequest], { unreadCount: 1, updatedAtMs: 2_400 })]);

  const merged = mergeDesktopBridgeState(current, next);

  assert.equal(merged?.conversations[0].unreadCount, 1);
});

test('mergeDesktopBridgeState preserves the existing bridge request when a partial response update arrives', () => {
  const request = message({
    id: 'request',
    direction: 'inbound',
    requestId: 'bridge_req_1',
    text: '@MyKordi who are you',
    timestampMs: 1_100,
  });
  const response = message({
    id: 'response',
    direction: 'outbound-response',
    sender: 'My Kordi',
    requestId: 'bridge_req_1',
    text: 'I am Kordi.',
    timestampMs: 1_200,
  });

  const current = bridgeState([conversation([request])]);
  const next = bridgeState([conversation([response], { updatedAtMs: 2_200 })]);

  const merged = mergeDesktopBridgeState(current, next);

  assert.deepEqual(
    merged?.conversations[0].messages.map((item) => item.id),
    ['request', 'response'],
  );
});
