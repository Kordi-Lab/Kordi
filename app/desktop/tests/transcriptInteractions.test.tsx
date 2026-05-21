import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble, MessageInteractionMenu } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

const userMessage: Message = {
  id: 'msg:user:1',
  role: 'person',
  sender: 'Alice',
  senderType: 'human',
  text: 'Can you summarize this?',
  time: '10:15',
};

test('message interaction menu offers quote and forward for eligible messages', () => {
  const markup = renderToStaticMarkup(createElement(MessageInteractionMenu, {
    message: userMessage,
    x: 12,
    y: 24,
    onQuote: () => {},
    onForward: () => {},
    onClose: () => {},
  }));

  assert.match(markup, /role="menu"/);
  assert.match(markup, />Quote</);
  assert.match(markup, />Forward</);
});

test('message interaction menu rejects live processing placeholders', () => {
  const processing: Message = {
    id: 'msg:agent:processing',
    role: 'external-agent',
    sender: 'Jiaxin\'s Kordi',
    senderType: 'agent',
    text: '',
    time: '10:16',
    turn: {
      id: 'turn-processing',
      sessionId: 'session:group:main',
      prompt: '',
      status: 'processing',
      message: 'Processing…',
      assistantText: '',
      thinkingText: '',
      tools: [],
      completed: false,
      succeeded: false,
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageInteractionMenu, {
    message: processing,
    x: 12,
    y: 24,
    onQuote: () => {},
    onForward: () => {},
    onClose: () => {},
  }));

  assert.match(markup, /data-message-interaction-disabled="true"/);
  assert.doesNotMatch(markup, />Quote</);
  assert.doesNotMatch(markup, />Forward</);
});

test('quoted messages render a source preview inside the message bubble', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: {
      ...userMessage,
      role: 'user',
      isOwnMessage: true,
      sender: 'Me',
      quote: {
        messageId: 'msg:source',
        senderLabel: 'Alice',
        text: 'Original context that matters',
        time: '10:14',
      },
      text: 'Yes, I can.',
    },
  }));

  assert.match(markup, /app-message-quote-preview/);
  assert.match(markup, /Alice/);
  assert.match(markup, /Original context that matters/);
});

test('forwarded messages render Telegram-style inline forwarded header', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: {
      ...userMessage,
      forwardedFrom: {
        sourceMessageId: 'msg:source',
        sourceSessionId: 'session:source',
        senderLabel: 'Odaily资讯速递',
        sourceChatLabel: 'News',
      },
      text: '消息人士：美国将延长俄石油制裁豁免30天',
    },
  }));

  assert.match(markup, /app-message-forwarded-header/);
  assert.match(markup, /Forwarded from/);
  assert.match(markup, /Odaily资讯速递/);
  assert.doesNotMatch(markup, /app-message-forwarded-card/);
});
