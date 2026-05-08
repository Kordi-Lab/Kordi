import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_READ_ATTENTION_EVENTS,
  activeBridgeConversationForSession,
  activeBridgeConversationsForSession,
  activeUnreadBridgeConversationsForSession,
  bridgeConversationIdsToMarkReadOnUserActivity,
  bridgeReadReceiptBatchSignature,
  bridgeReadReceiptSignature,
  canAutoMarkBridgeRead,
  shouldMarkBridgeConversationRead,
} from '../src/features/bridge/readReceipts';
import { markBridgeConversationsReadInState } from '../src/features/bridge/useBridgeState';
import type { DesktopBridgeConversation, DesktopBridgeState } from '../src/kordi-app/types';

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

test('activeBridgeConversationsForSession returns every bridge conversation for a parent session', () => {
  const active = activeBridgeConversationsForSession([
    conversation({
      id: 'bridge:host-1:peer-1:person',
      canonicalSessionId: 'session:bridge:humans:stable-pair',
      unreadCount: 1,
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
    conversation({
      id: 'bridge:host-1:peer-1',
      canonicalSessionId: 'session:bridge:agents:peer-agent',
      peerRuntime: 'kordi-desktop',
      unreadCount: 1,
      outreach: {
        targetKind: 'bridge-agent',
        parentSessionId: 'session:bridge:humans:latest-parent',
        bridgeHostId: 'host-1',
        targetNodeId: 'peer-1',
        targetDisplayName: 'Peer Kordi',
        requestText: 'hello',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }),
  ], 'session:bridge:humans:latest-parent');

  assert.deepEqual(active.map((item) => item.id), ['bridge:host-1:peer-1:person', 'bridge:host-1:peer-1']);
});

test('activeUnreadBridgeConversationsForSession finds unread bridge agent conversations for uuid parent sessions', () => {
  const active = activeUnreadBridgeConversationsForSession([
    conversation({
      id: 'bridge:host-1:peer-1',
      canonicalSessionId: 'session:bridge:agents:peer-agent',
      peerRuntime: 'kordi-desktop',
      unreadCount: 1,
      outreach: {
        targetKind: 'bridge-agent',
        parentSessionId: 'd17bf74f-f065-46cb-82d7-bf78ed7f910f',
        bridgeHostId: 'host-1',
        targetNodeId: 'peer-1',
        targetDisplayName: 'Peer Kordi',
        requestText: 'hello',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }),
  ], 'd17bf74f-f065-46cb-82d7-bf78ed7f910f');

  assert.deepEqual(active.map((item) => item.id), ['bridge:host-1:peer-1']);
});

test('bridgeConversationIdsToMarkReadOnUserActivity does not clear sibling group threads for an active bridge conversation id', () => {
  const parentSessionId = 'session:bridge:humans:shared-parent';
  const ids = bridgeConversationIdsToMarkReadOnUserActivity([
    conversation({
      id: 'bridge:host-1:peer-1:person',
      canonicalSessionId: 'session:bridge:humans:stable-pair',
      unreadCount: 0,
      outreach: {
        targetKind: 'bridge-person',
        parentSessionId,
        bridgeHostId: 'host-1',
        targetNodeId: 'peer-1',
        targetDisplayName: 'Peer',
        requestText: 'hello',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }),
    conversation({
      id: 'bridge:host-1:peer-1',
      canonicalSessionId: 'session:bridge:agents:peer-agent',
      peerRuntime: 'kordi-desktop',
      unreadCount: 1,
      outreach: {
        targetKind: 'bridge-agent',
        parentSessionId,
        bridgeHostId: 'host-1',
        targetNodeId: 'peer-1',
        targetDisplayName: 'Peer Kordi',
        requestText: 'hello',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      messages: [
        { id: 'msg-in-response', direction: 'inbound-response', sender: 'Peer Kordi', text: 'answer', timeLabel: '10:01', timestampMs: 2, requestId: 'req-1', deliveryState: 'responded' },
      ],
    }),
  ], 'bridge:host-1:peer-1:person');

  assert.deepEqual(ids, []);
});

test('bridgeConversationIdsToMarkReadOnUserActivity includes unread parent-session bridge threads', () => {
  const ids = bridgeConversationIdsToMarkReadOnUserActivity([
    conversation({
      id: 'bridge:host-1:peer-1:person',
      canonicalSessionId: 'session:bridge:humans:stable-pair',
      unreadCount: 4,
      outreach: {
        targetKind: 'bridge-person',
        parentSessionId: 'session:group:active-parent',
        bridgeHostId: 'host-1',
        targetNodeId: 'peer-1',
        targetDisplayName: 'Peer',
        requestText: 'hello',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }),
  ], 'session:group:active-parent');

  assert.deepEqual(ids, ['bridge:host-1:peer-1:person']);
});

test('markBridgeConversationsReadInState clears only the requested unread bridge threads', () => {
  const state: DesktopBridgeState = {
    configPath: '',
    legacyConfigPath: '',
    conversationsPath: '',
    activeHostId: 'host-1',
    hosts: [],
    localServer: { running: false },
    conversations: [
      conversation({ id: 'bridge:read-me', unreadCount: 4 }),
      conversation({ id: 'bridge:keep-me', unreadCount: 2 }),
    ],
  };

  const nextState = markBridgeConversationsReadInState(state, ['bridge:read-me']);

  assert.equal(nextState?.conversations.find((item) => item.id === 'bridge:read-me')?.unreadCount, 0);
  assert.equal(nextState?.conversations.find((item) => item.id === 'bridge:keep-me')?.unreadCount, 2);
});

test('bridge read effects listen for focus and visibility changes', () => {
  assert.deepEqual(BRIDGE_READ_ATTENTION_EVENTS, ['focus', 'visibilitychange', 'pageshow']);
});

test('canAutoMarkBridgeRead requires visible focused document', () => {
  const visibleFocusedDocument = {
    visibilityState: 'visible',
    hasFocus: () => true,
  };
  const hiddenDocument = {
    visibilityState: 'hidden',
    hasFocus: () => true,
  };
  const blurredDocument = {
    visibilityState: 'visible',
    hasFocus: () => false,
  };

  assert.equal(canAutoMarkBridgeRead(visibleFocusedDocument), true);
  assert.equal(canAutoMarkBridgeRead(hiddenDocument), false);
  assert.equal(canAutoMarkBridgeRead(blurredDocument), false);
});

test('bridgeReadReceiptBatchSignature covers every active unread bridge conversation', () => {
  const signature = bridgeReadReceiptBatchSignature([
    conversation({
      id: 'bridge:host-1:peer-1:person',
      unreadCount: 1,
      messages: [
        { id: 'msg-in-1', direction: 'inbound', sender: 'Peer', text: 'hello', timeLabel: '10:00', timestampMs: 1, requestId: 'req-1', deliveryState: null },
      ],
    }),
    conversation({
      id: 'bridge:host-1:peer-1',
      unreadCount: 1,
      messages: [
        { id: 'msg-in-2', direction: 'inbound-response', sender: 'Peer Kordi', text: 'answer', timeLabel: '10:01', timestampMs: 2, requestId: 'req-2', deliveryState: 'responded' },
      ],
    }),
  ]);

  assert.equal(signature, 'bridge:host-1:peer-1:person:req-1|bridge:host-1:peer-1:req-2');
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
