import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { mapBridgeConversationToViewModel } from '../src/features/bridge/transcript';
import type { DesktopBridgeConversationMessage } from '../src/kordi-app/types';
import {
  CHAT_SCALE,
  buildScaleBridgeConversation,
  buildScaleCanonicalState,
  scaleMessageCount,
  scaleSessionId,
} from './fixtures/chatScale';

test('scale canonical fixture has stable catalog and transcript cardinality', () => {
  const state = buildScaleCanonicalState();

  assert.equal(state.sessions.length, CHAT_SCALE.sessions);
  assert.equal(state.messages.length, scaleMessageCount());
  assert.equal(
    state.messages.filter((message) => message.sessionId === scaleSessionId(0)).length,
    CHAT_SCALE.messagesPerSession + CHAT_SCALE.selectedSessionMessages,
  );
  assert.equal(state.participants.length, CHAT_SCALE.sessions * 2);
  assert.ok(state.sessions.every((session) => session.lastMessageAtMs != null));
});

test('scale Bridge fixture suppresses completed processing placeholders', () => {
  const conversation = buildScaleBridgeConversation();
  const view = mapBridgeConversationToViewModel(conversation, undefined, 'My Kordi');

  assert.equal(conversation.messages.length, CHAT_SCALE.selectedSessionMessages);
  assert.equal(view.messages.length, CHAT_SCALE.selectedSessionMessages - 50);
  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), false);
});

test('Bridge processing placeholder classification stays linear at 5,000 rows', () => {
  const conversation = buildScaleBridgeConversation();
  const messages: DesktopBridgeConversationMessage[] = Array.from(
    { length: 2_500 },
    (_, index) => {
      const requestId = `scale-request:${index}`;
      return [
        {
          id: requestId,
          direction: 'outbound' as const,
          sender: 'Me',
          text: `Scale request ${index}`,
          timeLabel: '00:00',
          timestampMs: index * 2,
          requestId,
          deliveryState: 'delivered',
        },
        {
          id: `scale-processing:${index}`,
          direction: 'inbound-response' as const,
          sender: 'Scale agent',
          text: 'processing...',
          timeLabel: '00:00',
          timestampMs: index * 2 + 1,
          requestId,
          deliveryState: 'processing',
        },
      ];
    },
  ).flat();

  const startedAt = performance.now();
  const view = mapBridgeConversationToViewModel({ ...conversation, messages }, undefined, 'My Kordi');
  const elapsedMs = performance.now() - startedAt;

  assert.equal(view.messages.length, messages.length);
  assert.ok(elapsedMs < 100, `Expected 5,000 Bridge rows below 100ms, received ${elapsedMs.toFixed(1)}ms`);
});
