import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageContextMenuContent } from '../src/kordi-app/components/messageContextMenuContent';
import type { Message } from '../src/kordi-app/types';

test('message context menu offers Quote and Open discussion as separate first actions', () => {
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

  assert.match(markup, /data-message-context-menu-action="quote"/);
  assert.match(markup, /data-message-context-menu-action="open-discussion"/);
  assert.match(markup, />Quote</);
  assert.match(markup, />Open discussion</);
  assert.doesNotMatch(markup, /Reply in (conversation|thread)/);
  assert.match(
    markup,
    /data-message-context-menu-action="quote"[\s\S]*data-message-context-menu-action="open-discussion"[\s\S]*?role="separator"[\s\S]*data-message-context-menu-action="copy-text"/,
  );
});
