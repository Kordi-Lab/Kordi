import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

test('a single emoji keeps its visible size without a message bubble', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '😀',
    time: '00:45',
    statusChips: ['sent'],
  };

  const emojiMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));
  const peerMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: { ...message, role: 'person', sender: 'Maya', isOwnMessage: false },
  }));
  const textMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: { ...message, text: 'Look 😀' },
  }));

  assert.match(emojiMarkup, /app-standalone-emoji-message relative h-11 w-\[4\.5rem\]/);
  assert.match(emojiMarkup, /app-noto-emoji h-11 w-11/);
  assert.match(emojiMarkup, /absolute -bottom-0\.5 -right-2/);
  assert.match(peerMarkup, /app-standalone-emoji-message relative h-11 w-11/);
  assert.match(emojiMarkup, /data-message-delivery-status="sent"/);
  assert.doesNotMatch(emojiMarkup, /app-message-bubble-shape/);
  assert.doesNotMatch(emojiMarkup, /px-4 py-2\.5/);
  assert.doesNotMatch(textMarkup, /app-standalone-emoji-message/);
  assert.match(textMarkup, /app-message-bubble-shape/);
});

test('inline emoji use the text baseline instead of hanging below it', () => {
  const css = readFileSync(
    new URL('../src/styles/shell-expressive-picker.css', import.meta.url),
    'utf8',
  );

  assert.match(css, /\.app-inline-blob-emoji\s*\{[^}]*vertical-align:\s*-0\.2em;/s);
});
