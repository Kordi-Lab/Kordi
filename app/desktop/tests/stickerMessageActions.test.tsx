import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageContextMenuContent } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

test('sticker message menu offers save alongside standard message actions', () => {
  const message: Message = {
    id: 'msg:sticker', role: 'person', sender: 'Alice', senderType: 'human',
    text: '', time: '10:42', messageKind: 'sticker',
    attachments: [{
      kind: 'image', subtype: 'sticker', name: 'wave.png', mimeType: 'image/png', attachmentId: 'att-sticker',
    }],
  };
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    onReplyMessage: () => undefined,
    onForwardMessage: () => undefined,
    onSelectMessage: () => undefined,
  }));

  assert.match(markup, />Reply in conversation</);
  assert.match(markup, />Forward</);
  assert.match(markup, />Save to My Stickers</);
  assert.match(markup, />Select</);
  assert.doesNotMatch(markup, />Copy Text</);
});
