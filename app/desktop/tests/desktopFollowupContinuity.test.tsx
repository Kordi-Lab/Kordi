import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { suppressIncompleteLiveTurnEcho } from '../src/features/chat/desktopLiveTurns';

const tool = (id: string) => ({ id, name: 'read', status: 'running', arguments: '', liveOutput: '', isError: false });
const turn = (overrides: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot => ({
  id: 'current-turn', sessionId: 'session-a', prompt: 'Follow up', status: 'running',
  message: '', assistantText: '', thinkingText: '', tools: [], completed: false,
  succeeded: false, ...overrides,
});
const previous = (overrides: Partial<Message> = {}): Message => ({
  id: 'previous-answer', entryId: 'previous-entry', role: 'owned-agent', text: 'Earlier answer',
  time: '12:00', timestampMs: 1_000,
  turn: turn({ id: 'previous-turn', status: 'complete', completed: true, succeeded: true, tools: [tool('old-tool-1'), tool('old-tool-2')] }),
  ...overrides,
});

test('a follow-up tool call never hides an earlier answer with more tools', () => {
  const messages = [previous()];
  assert.equal(suppressIncompleteLiveTurnEcho(messages, turn({ tools: [tool('new-tool')] })), messages);
});

test('identical text in another request is not a live response echo', () => {
  const messages = [previous({ replyToMessageId: 'previous-request', text: 'Same answer' })];
  assert.equal(suppressIncompleteLiveTurnEcho(messages, turn({
    replyToMessageId: 'current-request', assistantText: 'Same answer',
  })), messages);
});

test('a completed answer predating the current turn is not a text fallback echo', () => {
  const messages = [previous({ text: 'Same answer' })];
  assert.equal(suppressIncompleteLiveTurnEcho(messages, turn({
    startedAtMs: 5_000, assistantText: 'Same answer',
  })), messages);
});

test('a current tool echo is matched by tool identity, not count', () => {
  const running = turn({ tools: [tool('new-tool')] });
  const old = previous();
  const echo = previous({
    id: 'persisted-current', entryId: 'current-entry', timestampMs: 6_000,
    text: '', turn: turn({ id: 'persisted-current', tools: [tool('new-tool')] }),
  });
  assert.deepEqual(suppressIncompleteLiveTurnEcho([old, echo], running), [old]);
});

test('an exact transcript entry matches despite different streaming snapshots', () => {
  const old = previous();
  const echo = previous({ id: 'persisted-current', entryId: 'current-entry', text: 'Persisted final answer', timestampMs: 6_000 });
  assert.deepEqual(suppressIncompleteLiveTurnEcho([old, echo], turn({
    transcriptEntryId: 'current-entry', assistantText: 'Partial response',
  })), [old]);
});
