import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  MessageBubbleShapeBackdrop,
  humanMessageBubbleShapeClass,
  messageBubbleShapePath,
  queuedMessageBubbleShapeClass,
} from '../src/features/chat/messageBubbleShape';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

test('human message bubble shape classes encode the selected clean squared soft-tail direction', () => {
  assert.equal(humanMessageBubbleShapeClass('own'), 'app-message-bubble app-message-bubble-own');
  assert.equal(humanMessageBubbleShapeClass('peer'), 'app-message-bubble app-message-bubble-peer');
});

test('queued message bubble shape uses the outgoing clean squared soft-tail class', () => {
  assert.equal(
    queuedMessageBubbleShapeClass,
    'app-message-bubble app-message-bubble-own app-message-bubble-queued',
  );
});

test('transcript and queued bubbles no longer hardcode the old pill radius utilities', () => {
  const transcript = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
  const chatsPage = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(transcript, /humanMessageBubbleShapeClass\('own'\)/);
  assert.match(transcript, /humanMessageBubbleShapeClass\('peer'\)/);
  assert.match(chatsPage, /queuedMessageBubbleShapeClass/);
  assert.doesNotMatch(transcript, /rounded-\[20px\] rounded-br-\[6px\]/);
  assert.doesNotMatch(transcript, /rounded-\[20px\] rounded-bl-\[6px\]/);
  assert.doesNotMatch(chatsPage, /rounded-\[19px\] rounded-br-\[6px\]/);
});

test('bubble backdrop renders one seamless vector path instead of separate tail pieces', () => {
  const ownBackdrop = renderToStaticMarkup(<MessageBubbleShapeBackdrop side="own" />);
  const peerBackdrop = renderToStaticMarkup(<MessageBubbleShapeBackdrop side="peer" />);

  assert.match(ownBackdrop, /<svg/);
  assert.match(ownBackdrop, /<path/);
  assert.doesNotMatch(ownBackdrop, /<rect|<polygon|<circle/);
  assert.match(peerBackdrop, /<svg/);
  assert.match(peerBackdrop, /<path/);
  assert.doesNotMatch(peerBackdrop, /<rect|<polygon|<circle/);
});

test('bubble CSS uses the seamless shape layer with natural motion and no stitched pseudo-tail', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-message-bubble-shape-fill/);
  assert.match(shellCss, /vector-effect:\s*non-scaling-stroke/);
  assert.match(shellCss, /@keyframes app-message-bubble-enter/);
  assert.match(shellCss, /prefers-reduced-motion:\s*reduce[\s\S]*app-message-bubble/);
  assert.doesNotMatch(shellCss, /\.app-message-bubble-own::after/);
  assert.doesNotMatch(shellCss, /\.app-message-bubble-peer::after/);
});

test('bubble path keeps the tail compact at the lower side for tall messages', () => {
  const ownTallPath = messageBubbleShapePath('own', { width: 220, height: 240 });
  const peerTallPath = messageBubbleShapePath('peer', { width: 220, height: 240 });

  assert.match(ownTallPath, /V\s*226/);
  assert.match(peerTallPath, /V\s*226/);
  assert.doesNotMatch(ownTallPath, /V\s*158/);
  assert.doesNotMatch(peerTallPath, /V\s*158/);
});

test('bubble path uses a small bottom-corner tail like the reference, not a side flap', () => {
  const ownPath = messageBubbleShapePath('own', { width: 220, height: 240 });
  const peerPath = messageBubbleShapePath('peer', { width: 220, height: 240 });

  assert.match(ownPath, /220\s+240/);
  assert.match(peerPath, /0\s+240/);
  assert.doesNotMatch(ownPath, /\b220\s+231\b/);
  assert.doesNotMatch(peerPath, /\b0\s+231\b/);
});

test('human bubble styling avoids visible outline seams around the WhatsApp-style tail', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-chat-bubble-user\s*{[\s\S]*--app-message-bubble-stroke:\s*transparent;/);
  assert.match(shellCss, /\.app-chat-bubble-peer\s*{[\s\S]*--app-message-bubble-stroke:\s*transparent;/);
  assert.doesNotMatch(shellCss, /height:\s*calc\(100% \+ var\(--app-message-bubble-tail-depth\)\)/);
});
