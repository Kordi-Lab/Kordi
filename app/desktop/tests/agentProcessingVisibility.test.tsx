import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canDisplayAgentTurn, agentTurnHasStarted } from '../src/features/chat/agentProcessingVisibility';
import { LiveChatTurnCard } from '../src/kordi-app/components/transcriptLiveTurns';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

const turn: DesktopChatTurnSnapshot = { id: 'turn', sessionId: 'session', prompt: 'Hello', status: 'starting',
  message: 'Working…', assistantText: '', thinkingText: '', tools: [], completed: false, succeeded: false, replyToMessageId: 'request' };
function request(status: string): Message { return { id: 'request', role: 'user', text: 'Hello', time: '12:00', statusChips: [status] }; }

test('scheduling a native turn does not show processing even after sending', () => {
  assert.equal(canDisplayAgentTurn(turn, [request('sending')]), false);
  assert.equal(canDisplayAgentTurn(turn, [request('sent')]), false);
  assert.equal(renderToStaticMarkup(createElement(LiveChatTurnCard, { turn, onStopActiveTurn: () => {} })), '');
});

test('real execution must wait for the linked request to be acknowledged', () => {
  const streaming = { ...turn, status: 'streaming' };
  for (const state of ['sending', 'failed', 'queued', 'cancelled']) assert.equal(canDisplayAgentTurn(streaming, [request(state)]), false);
  for (const state of ['sent', 'delivered', 'read']) assert.equal(canDisplayAgentTurn(streaming, [request(state)]), true);
  assert.equal(canDisplayAgentTurn(streaming, [{ ...request('sending'), id: 'runtime-user', replyAliasIds: ['request'] }]), false);
  assert.match(renderToStaticMarkup(createElement(LiveChatTurnCard, { turn: streaming, onStopActiveTurn: () => {} })), /app-agent-waiting-wave/);
});

test('completion and errors remain visible after delivery failure', () => {
  assert.equal(canDisplayAgentTurn({ ...turn, completed: true, status: 'failed', error: 'Failed' }, [request('failed')]), true);
  assert.equal(agentTurnHasStarted({ ...turn, status: 'writing', assistantText: 'Hello' }), true);
});


test('executor preparation is visible after acknowledgement without exposing optimistic starting', () => {
  const preparing = { ...turn, status: 'preparing' };
  assert.equal(agentTurnHasStarted(preparing), true);
  assert.equal(canDisplayAgentTurn(preparing, [request('sending')]), false);
  assert.equal(canDisplayAgentTurn(preparing, [request('sent')]), true);
  assert.equal(canDisplayAgentTurn(turn, [request('sent')]), false);
  assert.match(renderToStaticMarkup(createElement(LiveChatTurnCard, { turn: preparing, onStopActiveTurn: () => {} })), /app-agent-waiting-wave/);
});
