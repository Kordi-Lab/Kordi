import test from 'node:test';
import assert from 'node:assert/strict';

import type { DesktopChatMessage, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import {
  buildCompletedDesktopAssistantMessage,
  desktopAssistantMessageMatchesTurn,
  mergeDesktopTurnSnapshot,
  shouldConfirmCompletedDesktopTurnTranscript,
  shouldPollDesktopLiveTurn,
  suppressIncompleteLiveTurnEcho,
} from '../src/features/chat/desktopLiveTurns';

function turn(overrides: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot {
  return {
    id: 'turn-1',
    sessionId: 'session-a',
    prompt: 'hello',
    status: 'running',
    message: '',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    ...overrides,
  };
}

test('synthetic no-provider pending turns are not polled from the desktop runtime', () => {
  assert.equal(shouldPollDesktopLiveTurn(turn({ id: 'turn:no-provider-pending:msg:ui:abc' })), false);
  assert.equal(shouldPollDesktopLiveTurn(turn({ id: 'local-agent-starting:session-1' })), false);
  assert.equal(shouldPollDesktopLiveTurn(turn({ id: 'turn-runtime-1' })), true);
  assert.equal(shouldPollDesktopLiveTurn(turn({ id: 'turn-complete', completed: true })), false);
});

test('desktop live turn snapshot merge preserves richer streaming text and tool output', () => {
  const current = turn({
    assistantText: 'Longer assistant response',
    thinkingText: 'thinking through the plan',
    tools: [
      { id: 'tool-1', name: 'bash', status: 'running', arguments: 'pnpm test:unit', liveOutput: 'line one\nline two', resultText: null, detail: 'checking', isError: false },
      { id: 'tool-old', name: 'read', status: 'complete', arguments: 'old', liveOutput: 'old output', resultText: 'done', detail: null, isError: false },
    ],
  });
  const next = turn({
    assistantText: 'Shorter',
    thinkingText: 'thinking',
    tools: [
      { id: 'tool-1', name: 'bash', status: 'complete', arguments: 'pnpm', liveOutput: 'line one', resultText: 'passed', detail: null, isError: false },
    ],
  });

  assert.deepEqual(mergeDesktopTurnSnapshot(current, next), {
    ...next,
    assistantText: 'Longer assistant response',
    thinkingText: 'thinking through the plan',
    tools: [
      { id: 'tool-1', name: 'bash', status: 'complete', arguments: 'pnpm test:unit', liveOutput: 'line one\nline two', resultText: 'passed', detail: 'checking', isError: false },
      { id: 'tool-old', name: 'read', status: 'complete', arguments: 'old', liveOutput: 'old output', resultText: 'done', detail: null, isError: false },
    ],
  });
});

test('desktop live turn echo suppression removes only matching incomplete owned-agent echo', () => {
  const runningTurn = turn({
    assistantText: 'Streaming answer',
    thinkingText: 'hidden chain preview',
    tools: [{ id: 'tool-1', name: 'bash', status: 'running', arguments: '', liveOutput: 'output', isError: false }],
  });
  const messages: Message[] = [
    { role: 'user', text: 'hello', time: '12:00' },
    { role: 'owned-agent', text: 'unrelated old answer', time: '12:01' },
    { role: 'owned-agent', text: 'Streaming answer', time: '12:02', turn: runningTurn },
  ];

  assert.deepEqual(suppressIncompleteLiveTurnEcho(messages, runningTurn), messages.slice(0, 2));
  assert.equal(suppressIncompleteLiveTurnEcho(messages, { ...runningTurn, completed: true }), messages);
});

test('desktop assistant message matching accepts completed turn text, thinking, and tool artifacts', () => {
  const completedTurn = turn({
    status: 'complete',
    assistantText: '  Final   answer  ',
    thinkingText: 'notes',
    tools: [{ id: 'tool-1', name: 'read', status: 'complete', arguments: '', liveOutput: '', resultText: 'file', detail: null, isError: false }],
    completed: true,
    succeeded: true,
  });
  const message: DesktopChatMessage = {
    role: 'assistant',
    text: 'Final answer',
    timeLabel: '12:03',
    timestampMs: 123,
    thinkingText: 'notes',
    tools: completedTurn.tools,
  };

  assert.equal(desktopAssistantMessageMatchesTurn(message, completedTurn), true);
  assert.equal(desktopAssistantMessageMatchesTurn({ ...message, text: 'different answer' }, completedTurn), false);
});

test('visible completed plain-text turns confirm persisted history before the live row is removed', () => {
  const completed = turn({
    status: 'complete',
    assistantText: 'Persisted reply',
    completed: true,
    succeeded: true,
    transcriptRefreshRequired: false,
  });

  assert.equal(shouldConfirmCompletedDesktopTurnTranscript(completed, true), true);
  assert.equal(shouldConfirmCompletedDesktopTurnTranscript(completed, false), false);
  assert.equal(shouldConfirmCompletedDesktopTurnTranscript(turn({
    status: 'failed',
    completed: true,
    succeeded: false,
    error: 'provider failed',
    transcriptRefreshRequired: true,
  }), true), false);
});

test('completed desktop assistant messages fall back to error text and failed status', () => {
  const completed = buildCompletedDesktopAssistantMessage(turn({
    status: 'failed',
    assistantText: '',
    message: 'provider stopped',
    error: 'request failed',
    thinkingText: 'thoughts',
    tools: [{ id: 'tool-1', name: 'bash', status: 'failed', arguments: '', liveOutput: '', resultText: null, detail: null, isError: true }],
    completed: true,
    succeeded: false,
  }), '12:04');

  assert.equal(completed.role, 'assistant');
  assert.equal(completed.sender, 'My Kordi');
  assert.equal(completed.text, 'request failed');
  assert.equal(completed.failed, true);
  assert.equal(completed.thinkingText, 'thoughts');
  assert.equal(completed.tools?.length, 1);
});
