import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageContextMenuContent } from '../src/kordi-app/components/messageContextMenuContent';
import type { Message } from '../src/kordi-app/types';

test('message context menu shows conversation and thread replies directly', () => {
  const message: Message = {
    id: 'msg:thread-target',
    role: 'owned-agent',
    sender: 'My Kordi',
    senderType: 'agent',
    text: 'Choose where to reply',
    time: '10:42',
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    onReplyMessage: () => undefined,
    onOpenMessageThread: () => undefined,
  }));

  assert.match(markup, /data-message-context-menu-action="reply-conversation"/);
  assert.match(markup, /data-message-context-menu-action="reply-thread"/);
  assert.match(markup, />Reply in conversation</);
  assert.match(markup, />Reply in thread</);
  assert.doesNotMatch(markup, /data-message-context-menu-action="reply"/);
});
