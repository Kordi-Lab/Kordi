import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { setMessageLayout, type MessageLayout } from '../src/app/messageLayoutPreference';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';

const styles = ['shell-expressive-picker.css', 'message-layout.css']
  .map((name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8'))
  .join('\n');

const repeatedEmoji: Message = {
  role: 'user',
  sender: 'Me',
  senderType: 'human',
  isOwnMessage: true,
  text: '😀😀😀',
  time: '22:22',
  statusChips: ['sent'],
};

async function renderEmojiGeometry(layout: MessageLayout, text: string) {
  const dom = new JSDOM(`<style>${styles}</style><div class="kordi-app"><div id="root"></div></div>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  setMessageLayout(layout);
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(MessageBubble, { msg: { ...repeatedEmoji, text } }));
    });
    assert.equal(Boolean(host.querySelector('.app-thread-message-row')), layout === 'threads');
    return Array.from(host.querySelectorAll('.app-noto-emoji'), (element) => {
      const style = dom.window.getComputedStyle(element);
      return {
        className: element.className,
        display: style.display,
        verticalAlign: style.verticalAlign,
        width: style.width,
        height: style.height,
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
      };
    });
  } finally {
    await act(async () => root.unmount());
    setMessageLayout('chat');
  }
}

for (const layout of ['threads', 'chat'] as const) {
  test(`every emoji in a repeated emoji message shares one line box in the ${layout} layout`, async () => {
    for (const text of ['😀😀😀', 'Look 😀 and 😀 and 😀']) {
      const emoji = await renderEmojiGeometry(layout, text);
      assert.equal(emoji.length, 3, text);
      assert.match(emoji[0].className, /app-inline-blob-emoji/);
      assert.equal(emoji[0].verticalAlign, 'middle');
      assert.equal(emoji[0].marginTop, '-0.25em');
      for (const next of emoji.slice(1)) assert.deepEqual(next, emoji[0], text);
    }
  });
}

test('Threads keeps block spacing for message blocks without touching inline content', () => {
  const css = readFileSync(new URL('../src/styles/message-layout.css', import.meta.url), 'utf8');
  const blocks = /\[data-kordi-copy-surface="message"\]\s*>\s*:is\(([^)]*)\):not\(:first-child\)/.exec(css)?.[1] ?? '';
  assert.match(blocks, /\bp\b/);
  assert.match(blocks, /\bdiv\b/);
  assert.doesNotMatch(blocks, /\bspan\b|\bbutton\b|\bimg\b|\bcanvas\b/);
});
