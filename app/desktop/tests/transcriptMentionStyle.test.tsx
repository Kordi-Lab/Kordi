import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[0];
}

function humanMessage(overrides: Partial<Message> = {}): Message {
  return {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@EthansKordi hello',
    time: '16:48',
    statusChips: ['read'],
    mentions: [{ label: 'EthansKordi', targetKind: 'agent' }],
    ...overrides,
  };
}

test('chat mentions render as inline colored text without pill chrome', () => {
  const html = renderToStaticMarkup(createElement(MessageBubble, { msg: humanMessage() }));

  const mentionSpan = html.match(/<span class="[^"]*app-message-mention[^"]*"[^>]*>@EthansKordi<\/span>/)?.[0];
  assert.ok(mentionSpan);
  assert.doesNotMatch(mentionSpan, /bg-sky|border-sky|text-sky|rounded-full|px-1\.5|py-0\.5|translate-y-\[-1px\]|inline-flex/);
});

test('chat mention and footer colors are tokenized by bubble context', () => {
  const shellCss = readDesktopShellCss();
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  assert.match(themeTokensCss, /--app-chat-mention-own:\s*var\(--app-sidebar-accent\);/);
  assert.match(themeTokensCss, /--app-chat-mention-peer:\s*var\(--app-sidebar-accent\);/);
  assert.match(themeTokensCss, /--app-sidebar-accent:\s*#60A5FA;/);
  assert.match(themeTokensCss, /--app-chat-meta-own:\s*oklch\(/);
  assert.match(themeTokensCss, /--app-chat-meta-peer:\s*oklch\(/);
  const userBubbleRule = cssRule(shellCss, '.app-chat-bubble-user');
  const peerBubbleRule = cssRule(shellCss, '.app-chat-bubble-peer');
  const mentionRule = cssRule(shellCss, '.app-message-mention');
  const agentMentionRule = cssRule(shellCss, '.app-message-mention-agent');
  const personMentionRule = cssRule(shellCss, '.app-message-mention-person');
  const footerRule = cssRule(shellCss, '.app-message-footer');
  const inlineSenderRule = cssRule(shellCss, '.app-message-inline-sender');

  assert.match(userBubbleRule, /--app-message-mention:\s*var\(--app-chat-mention-own\);/);
  assert.match(userBubbleRule, /--app-message-meta:\s*var\(--app-chat-meta-own\);/);
  assert.match(peerBubbleRule, /--app-message-mention:\s*var\(--app-chat-mention-peer\);/);
  assert.match(peerBubbleRule, /--app-message-meta:\s*var\(--app-chat-meta-peer\);/);
  assert.match(mentionRule, /color:\s*var\(--app-message-mention\);/);
  assert.match(mentionRule, /font-weight:\s*600;/);
  assert.match(mentionRule, /background:\s*transparent;/);
  assert.match(mentionRule, /border:\s*0;/);
  assert.match(mentionRule, /padding:\s*0;/);
  assert.match(agentMentionRule, /color:\s*var\(--app-chat-mention-agent\);/);
  assert.match(personMentionRule, /color:\s*var\(--app-chat-mention-person\);/);
  assert.match(footerRule, /color:\s*var\(--app-message-meta\);/);
  assert.match(inlineSenderRule, /color:\s*var\(--app-chat-accent\);/);
  assert.doesNotMatch(mentionRule, /border-radius:\s*9999px/);
});
