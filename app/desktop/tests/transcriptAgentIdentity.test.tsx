import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

test('renders an agent name with a separate owner tag', () => {
  const message: Message = {
    role: 'owned-agent',
    sender: 'Scout',
    senderOwnerName: 'Alex',
    senderType: 'agent',
    text: 'Hey! I am doing well, thanks for asking.',
    time: '14:30',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-chat-bubble-agent/);
  assert.match(markup, />Scout</);
  assert.match(markup, /Owner · Alex/);
  assert.match(markup, /aria-label="Owner: Alex"/);
  assert.doesNotMatch(markup, /Alex['’]s Scout|My Scout/);
  assert.match(markup, />Hey! I am doing well, thanks for asking\.</);
  assert.doesNotMatch(markup, /app-message-bubble-own|app-message-bubble-peer/);
});

test('renders the owner tag while the viewer-owned agent is still working', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-live-owner',
    sessionId: 'session-1',
    prompt: 'hi',
    status: 'working',
    message: 'Working',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    error: null,
  };
  const message: Message = {
    role: 'owned-agent',
    sender: 'Babytang',
    text: '',
    time: '14:30',
    turn,
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, />Babytang</);
  assert.match(markup, /Owner · You/);
  assert.match(markup, /aria-label="Owner: You"/);
});

for (const role of ['owned-agent', 'external-agent'] as const) {
  test(`${role} preserves full structured agent mentions in Markdown replies`, () => {
    const text = '@Lab agent Please coordinate with @Hana’s agent before the pilot.';
    const names = ['Lab agent', 'Hana’s agent'];
    const message: Message = {
      role, sender: 'Research agent', senderType: 'agent', text, time: '14:30',
      mentions: names.map((label, index) => ({
        label, targetKind: 'agent', targetIdentityId: `agent:${index}`,
        startUtf16: text.indexOf(`@${label}`), lengthUtf16: label.length + 1,
        displayText: `@${label}`, displayLabel: label,
      })),
    };
    const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));
    assert.match(markup, /data-mention-kind="agent"[^>]*data-mention-identity="agent:0"[^>]*>@Lab agent<\/span>/);
    assert.match(markup, /data-mention-kind="agent"[^>]*data-mention-identity="agent:1"[^>]*>@Hana’s agent<\/span>/);
    assert.doesNotMatch(markup, /data-mention-kind="person"/);
  });
}
