import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS } from '../src/features/collaboration/collaborationProcessingState';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { DesktopCollaborationConversation } from '../src/kordi-app/types';

function conversation(
  overrides: Partial<DesktopCollaborationConversation> = {},
): DesktopCollaborationConversation {
  return {
    id: 'bridge:cloud:node-peer',
    canonicalSessionId: 'session:bridge:agents:peer',
    hostId: 'cloud',
    peerNodeId: 'node-peer',
    peerDisplayName: "Shenzhe's Kordi",
    peerOwnerName: 'Shenzhe',
    peerRuntime: 'kordi-desktop',
    projectId: null,
    projectName: null,
    title: "Shenzhe's Kordi",
    subtitle: 'hi',
    unreadCount: 0,
    updatedAtMs: 1,
    updatedAtLabel: '21:03',
    awaitingReply: true,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: null,
    identity: null,
    messages: [],
    ...overrides,
  };
}

function processingConversation(timestampMs: number, requestId: string) {
  return conversation({
    messages: [{
      id: 'msg-request',
      direction: 'outbound',
      sender: 'Me',
      text: '@MyKordi hi',
      timeLabel: '21:03',
      timestampMs,
      requestId,
      deliveryState: 'sent',
      outreach: null,
    }, {
      id: 'msg-processing',
      direction: 'outbound-response',
      sender: 'My Kordi',
      text: 'processing...',
      timeLabel: '21:03',
      timestampMs: timestampMs + 1,
      requestId,
      deliveryState: 'processing',
      outreach: null,
    }],
  });
}

test('bridge transcript expires an orphaned historical processing response with its request', () => {
  const nowMs = Date.parse('2026-08-02T12:00:00Z');
  const oldTimestampMs = nowMs - COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS - 1;
  const view = mapCollaborationConversationToViewModel(
    processingConversation(oldTimestampMs, 'bridge_req_orphaned_processing'),
    undefined,
    'My Kordi',
    nowMs,
  );

  assert.deepEqual(view.messages.map((message) => message.text), ['@MyKordi hi']);
  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), false);
});

test('bridge transcript keeps a fresh processing response visible', () => {
  const nowMs = Date.parse('2026-08-02T12:00:00Z');
  const view = mapCollaborationConversationToViewModel(
    processingConversation(nowMs - 1_000, 'bridge_req_active_processing'),
    undefined,
    'My Kordi',
    nowMs,
  );

  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), true);
});
