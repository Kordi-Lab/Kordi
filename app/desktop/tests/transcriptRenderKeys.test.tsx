import assert from 'node:assert/strict';
import { test } from 'node:test';

import { transcriptMessageRenderKey } from '../src/features/chat/transcriptRenderKeys';
import type { Message } from '../src/kordi-app/types';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello',
    time: '12:00',
    detail: 'Sending',
    statusChips: ['sending'],
    ...overrides,
  };
}

test('transcript message render key stays stable when sent-message status metadata refreshes', () => {
  const sending = message();
  const delivered = message({
    time: '12:01',
    detail: 'Delivered',
    statusChips: ['delivered'],
  });

  assert.equal(transcriptMessageRenderKey(sending, 4), transcriptMessageRenderKey(delivered, 4));
});

test('transcript message fallback render key avoids volatile time and status fields', () => {
  const sending = message({ id: undefined });
  const read = message({
    id: undefined,
    time: '12:03',
    detail: 'Read',
    statusChips: ['read'],
  });

  assert.equal(transcriptMessageRenderKey(sending, 2), transcriptMessageRenderKey(read, 2));
});

test('optimistic and canonical Cloud rows keep one render key', () => {
  const clientMessageId = '77777777-7777-4777-8777-777777777777';
  const optimistic = message({ id: clientMessageId, clientMessageId });
  const canonical = message({ id: 'server-message-id', clientMessageId });

  assert.equal(
    transcriptMessageRenderKey(optimistic, 2),
    transcriptMessageRenderKey(canonical, 2),
  );
});
