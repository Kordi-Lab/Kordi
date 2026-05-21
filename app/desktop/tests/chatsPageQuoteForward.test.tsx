import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ComposerInteractionPreview, ForwardDestinationPicker } from '../src/pages/ChatsPage';

test('composer quote preview renders sender excerpt and remove control', () => {
  const markup = renderToStaticMarkup(createElement(ComposerInteractionPreview, {
    quote: {
      messageId: 'msg:alice',
      senderLabel: 'Alice',
      text: 'Please check the latest group update',
      time: '10:10',
    },
    forward: null,
    onClearQuote: () => {},
    onClearForward: () => {},
  }));

  assert.match(markup, /data-composer-quote-preview="true"/);
  assert.match(markup, /Replying to Alice/);
  assert.match(markup, /Please check the latest group update/);
  assert.match(markup, /aria-label="Remove quote"/);
});

test('composer forward preview renders Telegram-style forwarded from label', () => {
  const markup = renderToStaticMarkup(createElement(ComposerInteractionPreview, {
    quote: null,
    forward: {
      sourceMessageId: 'msg:news',
      sourceSessionId: 'session:news',
      senderLabel: 'Odaily资讯速递',
      sourceChatLabel: 'News',
    },
    onClearQuote: () => {},
    onClearForward: () => {},
  }));

  assert.match(markup, /data-composer-forward-preview="true"/);
  assert.match(markup, /Forwarded from Odaily资讯速递/);
  assert.match(markup, /aria-label="Remove forward"/);
});

test('forward destination picker lists chats and marks active session', () => {
  const markup = renderToStaticMarkup(createElement(ForwardDestinationPicker, {
    activeSessionId: 'session:main',
    destinations: [
      { id: 'session:main', title: '# main', subtitle: 'Current group' },
      { id: 'session:issues', title: '# Test-issues', subtitle: 'Direct chat' },
    ],
    onSelect: () => {},
    onClose: () => {},
  }));

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /Forward to/);
  assert.match(markup, /# main/);
  assert.match(markup, /Current/);
  assert.match(markup, /# Test-issues/);
});
