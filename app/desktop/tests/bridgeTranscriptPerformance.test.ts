import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapBridgeConversationToViewModel } from '../src/features/bridge/transcript';
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
