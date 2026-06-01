import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildReplyAttribution } from '../src/features/chat/replyAttribution';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import { mapDesktopMessagesForTranscript } from '../src/features/chat/useDesktopTranscriptAdapter';
import type { DesktopChatMessage } from '../src/kordi-app/types';

test('desktop transcript assigns stable ids before reply attribution so task jumps can highlight rendered turns', () => {
  const messages: DesktopChatMessage[] = [
    {
      role: 'user',
      sender: 'Me',
      text: 'Check Kordi project status for: /tmp/kordi/app/desktop',
      timeLabel: '16:22',
      timestampMs: 10,
    },
    {
      role: 'assistant',
      sender: 'My Kordi',
      text: 'Project status is healthy.',
      timeLabel: '16:22',
      timestampMs: 20,
      tools: [{
        id: 'plan-status',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({ taskTitle: 'Check Kordi project status' }),
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      }],
    },
  ];

  const mapped = mapDesktopMessagesForTranscript('session-status', messages);
  const attributed = buildReplyAttribution(mapped).messages;

  assert.equal(mapped[1].id, 'desktop-message:session-status:20:1:assistant');
  assert.equal(attributed[1].id, mapped[1].id);
});

test('desktop transcript maps plain completed assistant replies to foldable sourced turn cards', () => {
  const longClaudeReply = [
    'Here’s the current Mac landscape as of today (May 6, 2026):',
    '',
    '### Just released (March 2026)',
    '',
    '- **MacBook Air with M5** — 13″ and 15″, in sky blue, midnight, starlight, silver. Comes standard with 512GB starting storage and faster SSD.',
    '- **MacBook Pro 14″ / 16″ with M5 Pro and M5 Max** — Apple announced the latest 14- and 16-inch MacBook Pro models.',
    '- **MacBook Neo** — new entry-level laptop.',
    '',
    'Want me to compare specific configurations or pull current US prices?',
  ].join('\n');
  const messages: DesktopChatMessage[] = [
    {
      role: 'user',
      sender: 'Me',
      text: 'how about the new mac',
      timeLabel: '17:09',
      timestampMs: 1,
    },
    {
      role: 'assistant',
      sender: 'My Kordi',
      text: longClaudeReply,
      timeLabel: '17:09',
      timestampMs: 2,
    },
  ];

  const mapped = mapDesktopMessagesForTranscript('session-claude', messages);
  const attributed = buildReplyAttribution(mapped, null, { inferLatestHumanRequest: false }).messages;
  const assistant = attributed[1];

  assert.equal(assistant.turn?.assistantText, longClaudeReply);
  assert.equal(assistant.turn?.sourceMessage?.text, 'how about the new mac');

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: assistant }));

  assert.match(markup, /app-source-message-quote/);
  assert.match(markup, /app-live-assistant-answer-folded/);
  assert.match(markup, /— 3 more lines\. Click to show all —/);
});

test('self-agent chat can render completed assistant replies without reply quote, request reply line, background, or folding', () => {
  const longReply = [
    'There is still no substantive progress.',
    'First detail.',
    'Second detail.',
    'Third detail.',
    'Fourth detail.',
    'Fifth detail.',
    'Sixth detail.',
    'Seventh detail stays visible.',
  ].join('\n');
  const messages: DesktopChatMessage[] = [
    {
      role: 'user',
      sender: 'Me',
      text: 'check again',
      timeLabel: '17:10',
      timestampMs: 1,
    },
    {
      role: 'assistant',
      sender: 'My Kordi',
      text: longReply,
      timeLabel: '17:10',
      timestampMs: 2,
    },
  ];

  const mapped = mapDesktopMessagesForTranscript('session-self-agent', messages);
  const attributed = buildReplyAttribution(mapped, null, {
    inferLatestHumanRequest: false,
    suppressAgentReplyAttribution: true,
  }).messages;

  const requestMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: attributed[0] }));
  const assistantMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: attributed[1], plainAgentResponse: true }));

  assert.doesNotMatch(requestMarkup, /app-message-reply-line/);
  assert.doesNotMatch(assistantMarkup, /app-source-message-quote/);
  assert.doesNotMatch(assistantMarkup, /app-live-assistant-answer-surface/);
  assert.doesNotMatch(assistantMarkup, /app-live-assistant-answer-folded/);
  assert.doesNotMatch(assistantMarkup, /Click to show/);
  assert.match(assistantMarkup, /app-live-assistant-answer/);
  assert.match(assistantMarkup, /There is still no substantive progress/);
  assert.match(assistantMarkup, /Seventh detail stays visible/);
});

test('desktop transcript maps optimistic own messages with the local profile image url immediately', () => {
  const [mapped] = mapDesktopMessagesForTranscript('session-1', [{
    role: 'user',
    sender: 'Me',
    text: 'hello',
    timeLabel: '12:00',
    timestampMs: 1,
  }], {
    human: 'human:me',
    humanProfileImageUrl: 'https://images.test/me.png',
  });

  assert.equal(mapped.senderAvatarSeed, 'human:me');
  assert.equal(mapped.senderProfileImageUrl, 'https://images.test/me.png');
});

test('desktop transcript attachment mapping preserves file size and local preview path metadata', () => {
  const messages: DesktopChatMessage[] = [{
    role: 'user',
    sender: 'Me',
    text: '',
    timeLabel: '10:59',
    timestampMs: 1,
    attachments: [{
      kind: 'image',
      name: 'Screenshot 2026-04-30 10.59.00.png',
      formatLabel: 'PNG',
      previewUrl: null,
      mimeType: 'image/png',
      localPath: '/Users/shuyang/Library/Application Support/Kordi/tmp/attachments/screenshot.png',
      sizeBytes: 276000,
    }],
  }];

  const [mapped] = mapDesktopMessagesForTranscript('session-1', messages);

  assert.deepEqual(mapped.attachments, [{
    kind: 'image',
    name: 'Screenshot 2026-04-30 10.59.00.png',
    formatLabel: 'PNG',
    previewUrl: null,
    mimeType: 'image/png',
    localPath: '/Users/shuyang/Library/Application Support/Kordi/tmp/attachments/screenshot.png',
    sizeBytes: 276000,
  }]);
});
