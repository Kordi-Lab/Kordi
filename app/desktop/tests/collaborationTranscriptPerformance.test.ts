import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { DesktopCollaborationConversationMessage } from '../src/kordi-app/types';
import {
  CHAT_SCALE,
  buildScaleCollaborationConversation,
  buildScaleCanonicalState,
  scaleMessageCount,
  scaleSessionId,
} from './fixtures/chatScale';
import { createPropertyReadCounter } from './helpers/propertyReadCounter';

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
  const conversation = buildScaleCollaborationConversation();
  const view = mapCollaborationConversationToViewModel(conversation, undefined, 'My Kordi');

  assert.equal(conversation.messages.length, CHAT_SCALE.selectedSessionMessages);
  assert.equal(view.messages.length, CHAT_SCALE.selectedSessionMessages - 50);
  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), false);
});

test('Bridge processing placeholder classification stays linear at 5,000 rows', () => {
  const conversation = buildScaleCollaborationConversation();
  const readCounter = createPropertyReadCounter();
  const messages: DesktopCollaborationConversationMessage[] = Array.from(
    { length: 2_500 },
    (_, index) => {
      const requestId = `scale-request:${index}`;
      return [
        readCounter.track({
          id: requestId,
          direction: 'outbound' as const,
          sender: 'Me',
          text: `Scale request ${index}`,
          timeLabel: '00:00',
          timestampMs: index * 2,
          requestId,
          deliveryState: 'delivered',
        }),
        readCounter.track({
          id: `scale-processing:${index}`,
          direction: 'inbound-response' as const,
          sender: 'Scale agent',
          text: 'processing...',
          timeLabel: '00:00',
          timestampMs: index * 2 + 1,
          requestId,
          deliveryState: 'processing',
        }),
      ];
    },
  ).flat();

  const view = mapCollaborationConversationToViewModel({ ...conversation, messages }, undefined, 'My Kordi');
  const propertyReads = readCounter.count();

  assert.equal(view.messages.length, messages.length);
  assert.ok(
    propertyReads <= messages.length * 40,
    `Expected at most 40 indexed property reads per Bridge row, received ${(propertyReads / messages.length).toFixed(1)}`,
  );
});
