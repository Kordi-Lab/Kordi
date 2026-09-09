import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationSendQueue } from '../src/features/chat/messageActions/conversationSendQueue';

test('delivery preserves chat order, isolates other chats, and continues after failure', async () => {
  const queue = new ConversationSendQueue();
  const sent: string[] = [];
  let rejectFirst!: (error: Error) => void;
  const first = queue.run('a', () => new Promise<void>((_, reject) => {
    sent.push('a1'); rejectFirst = reject;
  }));
  const firstFailure = assert.rejects(first, /offline/);
  const second = queue.run('a', async () => { sent.push('a2'); return 2; });
  const third = queue.run('a', async () => { sent.push('a3'); return 3; });
  await queue.run('b', async () => { sent.push('b1'); });
  assert.deepEqual(sent, ['a1', 'b1']);
  rejectFirst(new Error('offline'));
  await firstFailure;
  assert.deepEqual(await Promise.all([second, third]), [2, 3]);
  assert.deepEqual(sent, ['a1', 'b1', 'a2', 'a3']);
});
