import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MessageBubble
} from "../src/kordi-app/components/transcript";
import type { Message } from "../src/kordi-app/types";

test('forwarded human messages render Telegram-style forwarded header instead of quote block', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'Forward this',
    time: '12:18',
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source: {
        sourceSessionId: 'session:one',
        sourceMessageId: 'msg:source',
        senderLabel: 'Shiney lala',
        textPreview: 'Original text',
        attachmentCount: 0,
        timeLabel: '12:07',
      },
    },
    sourceMessage: {
      messageId: 'msg:source',
      senderLabel: 'Shiney lala',
      text: 'Original text',
      attachmentCount: 0,
      time: '12:07',
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /data-message-forwarded-header="true"/);
  assert.match(markup, />Forwarded from</);
  assert.match(markup, />Shiney lala</);
  assert.doesNotMatch(markup, /app-source-message-quote/);
});
