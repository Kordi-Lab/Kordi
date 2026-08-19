import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

test('failed own messages render an external retry action opposite the avatar', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@Testuser3sKordi can you see our chat history?',
    time: '00:45',
    statusChips: ['failed'],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    onRetryMessage: () => {},
  }));

  assert.doesNotMatch(markup, />Sending failed</);
  assert.match(markup, />!<\/span>/);
  assert.match(markup, /data-message-retry-button="true"/);
  assert.match(markup, /data-message-transfer-action-side="opposite-avatar"/);
  assert.match(markup, /aria-label="Retry sending message"/);
  assert.match(markup, /title="Retry sending message"/);
  assert.match(markup, /h-7 w-7/);
  assert.match(markup, /data-message-delivery-glyph="none"/);
  assert.match(markup, /text-rose-600/);
});
