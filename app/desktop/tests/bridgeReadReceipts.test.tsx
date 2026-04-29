import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeBridgeConversationForSession,
  bridgeReadReceiptSignature,
  shouldMarkBridgeConversationRead,
} from '../src/features/bridge/readReceipts';
import type { DesktopBridgeConversation } from '../src/kordi-app/types';

function conversation(overrides: Partial<DesktopBridgeConversation> = {}): DesktopBridgeConversation {
  return {
    id: 'bridge:host-1:peer-1:person',
    canonicalSessionId: 'session:bridge:humans:thread-1',
    hostId: 'host-1',
    peerNodeId: 'peer-1',
    peerDisplayName: 'Peer',
    peerOwnerName: 'Peer',
    peerRuntime: 'person',
    projectId: null,
    projectName: null,
    title: 'Peer',
    subtitle: 'Direct person chat',
    unreadCount: 0,
    updatedAtMs: 1,
    updatedAtLabel: '10:00',
    awaitingReply: false,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: null,
    identity: null,
    messages: [],
    ...overrides,
  };
}

test('activeBridgeConversationForSession resolves canonical session ids', () => {
  const active = activeBridgeConversationForSession([
    conversation({ id: 'bridge:host-1:peer-1:person', canonicalSessionId: 'session:bridge:humans:thread-1' }),
  ], 'session:bridge:humans:thread-1');

  assert.equal(active?.id, 'bridge:host-1:peer-1:person');
});

test('activeBridgeConversationForSession resolves outreach parent session ids', () => {
  const active = activeBridgeConversationForSession([
    conversation({
      id: 'bridge:host-1:peer-1:person',
      canonicalSessionId: 'session:bridge:humans:stable-pair',
      outreach: {
        targetKind: 'bridge-person',
        parentSessionId: 'session:bridge:humans:latest-parent',
        bridgeHostId: 'host-1',
        targetNodeId: 'peer-1',
        targetDisplayName: 'Peer',
        requestText: 'hello',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }),
  ], 'session:bridge:humans:latest-parent');

  assert.equal(active?.id, 'bridge:host-1:peer-1:person');
});

test('shouldMarkBridgeConversationRead stays true when unread was cleared but inbound request ids exist', () => {
  const active = conversation({
    unreadCount: 0,
    messages: [
      { id: 'msg-in', direction: 'inbound', sender: 'Peer', text: 'hello', timeLabel: '10:00', timestampMs: 1, requestId: 'req-1', deliveryState: null },
    ],
  });

  assert.equal(shouldMarkBridgeConversationRead(active), true);
});

test('bridgeReadReceiptSignature changes when a new inbound request id arrives', () => {
  const first = conversation({
    unreadCount: 0,
    messages: [
      { id: 'msg-in-1', direction: 'inbound', sender: 'Peer', text: 'hello', timeLabel: '10:00', timestampMs: 1, requestId: 'req-1', deliveryState: null },
    ],
  });
  const second = conversation({
    unreadCount: 0,
    messages: [
      ...first.messages,
      { id: 'msg-in-2', direction: 'inbound', sender: 'Peer', text: 'again', timeLabel: '10:01', timestampMs: 2, requestId: 'req-2', deliveryState: null },
    ],
  });

  assert.notEqual(bridgeReadReceiptSignature(first), bridgeReadReceiptSignature(second));
});

test('shouldMarkBridgeConversationRead ignores outbound-only conversations', () => {
  const active = conversation({
    unreadCount: 0,
    messages: [
      { id: 'msg-out', direction: 'outbound', sender: 'Me', text: 'hello', timeLabel: '10:00', timestampMs: 1, requestId: 'req-1', deliveryState: 'sent' },
    ],
  });

  assert.equal(shouldMarkBridgeConversationRead(active), false);
});
