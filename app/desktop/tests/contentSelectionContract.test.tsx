import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownContent } from '../src/kordi-app/components/markdown';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

test('base styles disable shell selection and opt in only declared copy surfaces and editors', () => {
  const css = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');

  assert.match(css, /:where\(body, body \*\)[\s\S]*?-webkit-user-select: none;[\s\S]*?user-select: none;/);
  assert.match(css, /\[data-kordi-copy-surface="message"\]/);
  assert.match(css, /\[data-kordi-copy-surface="document"\]/);
  assert.match(css, /\[contenteditable\]:not\(\[contenteditable="false"\]\)/);
  assert.match(css, /\[data-message-selection-mode="true"\][\s\S]*?user-select: none;/);
  assert.match(css, /\[data-kordi-copy-surface\][\s\S]*?::selection[\s\S]*?--app-copy-selection-bg/);
  assert.match(css, /--app-copy-selection-text/);
  assert.match(css, /data-kordi-copy-selection="unified"[\s\S]*?--app-copy-selection-height/);
  assert.match(css, /data-kordi-copy-selection="unified"[\s\S]*?background-color: transparent/);
});

test('selection colors use a quiet blue tint with explicit light and dark contrast', () => {
  const tokens = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  assert.match(tokens, /--app-copy-selection-bg: rgb\(96 165 250 \/ 0\.32\)/);
  assert.match(tokens, /--app-copy-selection-surface-bg: rgb\(96 165 250 \/ 0\.18\)/);
  assert.match(tokens, /--app-copy-selection-text: rgb\(248 250 252\)/);
  assert.match(tokens, /--app-copy-selection-bg: rgb\(147 197 253 \/ 0\.46\)/);
  assert.match(tokens, /--app-copy-selection-surface-bg: rgb\(147 197 253 \/ 0\.30\)/);
  assert.match(tokens, /--app-copy-selection-text: rgb\(15 23 42\)/);
});

test('message payloads opt in without making system notices selectable', () => {
  const message: Message = {
    id: 'msg:copyable',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Copy this message',
    time: '10:42',
  };
  const systemNotice: Message = {
    id: 'msg:notice',
    role: 'system',
    sender: 'Kordi',
    text: 'No provider connected yet',
    time: '10:43',
  };

  const messageMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));
  const noticeMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: systemNotice }));

  assert.match(messageMarkup, /data-kordi-copy-surface="message"/);
  assert.doesNotMatch(noticeMarkup, /data-kordi-copy-surface/);
});

test('shared markdown is non-selectable by default and documents are scoped for Cmd+A', () => {
  const defaultMarkup = renderToStaticMarkup(createElement(MarkdownContent, { text: 'Interface copy' }));
  const documentMarkup = renderToStaticMarkup(createElement(MarkdownContent, {
    text: '# Agent document',
    copySurface: 'document',
  }));

  assert.doesNotMatch(defaultMarkup, /data-kordi-copy-surface/);
  assert.match(documentMarkup, /data-kordi-copy-surface="document"/);
  assert.match(documentMarkup, /tabindex="0"/);
});
