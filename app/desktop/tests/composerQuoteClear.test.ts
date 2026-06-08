import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sendChatMessageWithImmediateQuoteClear } from '../src/features/chat/composerQuoteClear';
import type { ComposerQuoteState } from '../src/kordi-app/types';

const quote: ComposerQuoteState = {
  action: 'quote',
  source: {
    sourceSessionId: 'session:one',
    sourceMessageId: 'msg:source',
    senderLabel: '333',
    textPreview: 'Original message',
    attachmentCount: 0,
    createdAtMs: null,
    timeLabel: '13:56',
  },
};

test('sendChatMessageWithImmediateQuoteClear clears active quote immediately after a quoted send starts', async () => {
  let resolveSend: (() => void) | null = null;
  const events: string[] = [];
  const sendPromise = new Promise<void>((resolve) => {
    resolveSend = resolve;
  });

  const result = sendChatMessageWithImmediateQuoteClear({
    draftOverride: 'hiii',
    currentDraft: '',
    attachmentCount: 0,
    activeChatQuote: quote,
    send: () => {
      events.push('send-start');
      return sendPromise;
    },
    clearQuote: () => {
      events.push('quote-clear');
    },
  });

  assert.deepEqual(events, ['send-start', 'quote-clear']);
  resolveSend?.();
  await result;
});

test('sendChatMessageWithImmediateQuoteClear leaves quote alone for empty sends', async () => {
  const events: string[] = [];

  await sendChatMessageWithImmediateQuoteClear({
    currentDraft: '   ',
    attachmentCount: 0,
    activeChatQuote: quote,
    send: () => {
      events.push('send-start');
    },
    clearQuote: () => {
      events.push('quote-clear');
    },
  });

  assert.deepEqual(events, ['send-start']);
});
