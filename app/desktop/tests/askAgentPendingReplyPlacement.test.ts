import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/runtimeHistoryMerge';
import type { Message } from '../src/kordi-app/types';

const turn = (id: string, text: string, completed: boolean) => ({
  id: `canonical-turn:${id}`, sessionId: 's', prompt: '', status: completed ? 'complete' : 'processing', message: '',
  assistantText: text, thinkingText: '', tools: [], completed, succeeded: completed, replyToMessageId: null,
});

test('a pending reply stays under its request and the request shows once', () => {
  const runtime: Message[] = [
    { id: 'native-hi', entryId: 'wire-hi', role: 'user', text: 'hi', time: '16:26' } as Message,
    { id: 'native-reply', entryId: 'native-reply', role: 'owned-agent', text: 'Hello', time: '16:27' } as Message,
    // The optimistic copy of the new request: its render identity is the canonical row id.
    { role: 'user', text: 'hihi', time: '16:27', clientMessageId: 'msg:ui:hihi' } as Message,
  ];
  const canonical: Message[] = [
    { id: 'msg:ui:hi', entryId: 'wire-hi', role: 'user', text: 'hi', time: '16:26' } as Message,
    { id: 'msg:cloud:self:response:wire-hi', entryId: 'native-reply', role: 'owned-agent', text: '', time: '16:27', turn: turn('reply', 'Hello', true) } as Message,
    { id: 'msg:ui:hihi', entryId: 'msg:ui:hihi', role: 'user', text: 'hihi', time: '16:27' } as Message,
    { id: 'msg:cloud:self:pending:msg:ui:hihi', entryId: 'msg:cloud:self:pending:msg:ui:hihi', role: 'owned-agent', text: '', time: '16:27',
      replyToMessageId: 'msg:ui:hihi', turn: { ...turn('pending', '', false), replyToMessageId: 'msg:ui:hihi' } } as Message,
  ];
  const merged = mergeCanonicalHistoryIntoRuntime(canonical, runtime);
  const order = merged.map((message) => `${message.role}:${message.text || message.id}`);
  assert.equal(merged.filter((message) => message.role === 'user' && message.text === 'hihi').length, 1, order.join(' | '));
  const requestIndex = merged.findIndex((message) => message.role === 'user' && message.text === 'hihi');
  const pendingIndex = merged.findIndex((message) => message.id === 'msg:cloud:self:pending:msg:ui:hihi');
  assert.ok(pendingIndex > requestIndex, `the pending reply follows its request: ${order.join(' | ')}`);
  const reply = merged.find((message) => message.role === 'owned-agent' && (message.turn?.completed || message.text === 'Hello'));
  assert.notEqual(reply, undefined);
});
