import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeThreadReplies } from '../src/features/chat/threadReplies';
import type { Message } from '../src/kordi-app/types';

function reply(id: string, sequence?: number, timestampMs = 1_000): Message {
  return { id, role: 'user', text: id, time: '12:00', timestampMs, conversationSequence: sequence };
}

const ids = (messages: Message[]) => messages.map(message => message.id);

test('sending a reply in a loaded unread thread keeps it after confirmed history', () => {
  const history = [reply('first', 10), reply('unread', 20)];
  const pending = { ...reply('sending'), deliveryState: 'sending' as const };
  const sending = mergeThreadReplies(history, [...history, pending]);
  assert.deepEqual(ids(sending), ['first', 'unread', 'sending']);

  // Server confirmation supplies the sequence without moving the reply to the top.
  const confirmed = { ...pending, conversationSequence: 21, deliveryState: 'sent' as const };
  const received = mergeThreadReplies(sending, [confirmed]);
  assert.deepEqual(ids(received), ['first', 'unread', 'sending']);
  assert.equal(received[2].deliveryState, 'sent');
});

test('confirmed replies follow server order despite client clock skew', () => {
  assert.deepEqual(ids(mergeThreadReplies(
    [reply('second', 20, 100)],
    [reply('third', 30, 50), reply('first', 10, 2_000)],
  )), ['first', 'second', 'third']);
});

test('unsequenced replies stay at the tail in creation order during polling', () => {
  const pendingFirst = reply('pending-first', undefined, 100);
  const pendingSecond = reply('pending-second', 0, 200);
  const pendingFailed = { ...reply('failed', undefined, 300), deliveryState: 'failed' as const };
  assert.deepEqual(ids(mergeThreadReplies(
    [reply('confirmed', 10, 2_000), pendingSecond],
    [pendingFailed, reply('incoming', 11, 3_000), pendingFirst],
  )), ['confirmed', 'incoming', 'pending-first', 'pending-second', 'failed']);
});

test('overlapping history pages retain the latest local representation once', () => {
  const server = { ...reply('server-id', 20), reactionTargetMessageId: 'server-id' };
  const local = { ...server, id: 'local-id', text: 'Edited reply' };
  const merged = mergeThreadReplies([reply('first', 10), server], [local, reply('last', 30)]);
  assert.deepEqual(ids(merged), ['first', 'local-id', 'last']);
  assert.equal(merged[1], local);
});
