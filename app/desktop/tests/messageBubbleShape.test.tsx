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
  const queuedMessage = readFileSync(new URL('../src/pages/chatsPage.queuedMessage.tsx', import.meta.url), 'utf8');

  assert.match(transcript, /humanMessageBubbleShapeClass\('own'\)/);
  assert.match(transcript, /humanMessageBubbleShapeClass\('peer'\)/);
  assert.match(queuedMessage, /queuedMessageBubbleShapeClass/);
  assert.doesNotMatch(transcript, /rounded-\[20px\] rounded-br-\[6px\]/);
  assert.doesNotMatch(transcript, /rounded-\[20px\] rounded-bl-\[6px\]/);
  assert.doesNotMatch(queuedMessage, /rounded-\[19px\] rounded-br-\[6px\]/);
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

test('the shape canvas reserves the tail reach so the tail never leaves the viewport', () => {
  const ownBackdrop = renderToStaticMarkup(<MessageBubbleShapeBackdrop side="own" />);
  const peerBackdrop = renderToStaticMarkup(<MessageBubbleShapeBackdrop side="peer" />);

  // Own reserves it on the trailing edge, peer on the leading edge.
  assert.match(ownBackdrop, /viewBox="0 0 154\.675 44"/);
  assert.match(peerBackdrop, /viewBox="-6\.675 0 154\.675 44"/);

  const shellCss = readDesktopShellCss();
  assert.match(shellCss, /--app-message-bubble-tail-reach:\s*6\.675px/);
  assert.match(shellCss, /\.app-message-bubble-shape\s*{[\s\S]*width:\s*calc\(100% \+ var\(--app-message-bubble-tail-reach\)\)/);
});

test('bubble CSS uses the seamless shape layer with natural motion and no stitched pseudo-tail', () => {
  const shellCss = readDesktopShellCss();
  const baseBubbleRule = shellCss.match(/\.app-message-bubble\s*\{[^}]*\}/)?.[0] ?? '';
  const entryBubbleRule = shellCss.match(/\.app-message-bubble-enter,\s*\.app-message-bubble-queued\s*\{[^}]*\}/)?.[0] ?? '';

  assert.match(shellCss, /\.app-message-bubble-shape-fill/);
  assert.match(shellCss, /vector-effect:\s*non-scaling-stroke/);
  assert.match(shellCss, /@keyframes app-message-bubble-send-enter/);
  assert.doesNotMatch(baseBubbleRule, /\banimation\s*:/);
  assert.doesNotMatch(baseBubbleRule, /\btransform(?:-origin)?\s*:/);
  assert.match(entryBubbleRule, /animation:\s*app-message-bubble-send-enter 150ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
  assert.match(shellCss, /@keyframes app-message-bubble-send-enter[\s\S]*translate3d\(var\(--app-message-bubble-enter-x\), 9px, 0\)/);
  assert.doesNotMatch(shellCss, /@keyframes app-transcript-existing-row-lift/);
  assert.match(shellCss, /data-virtual-transcript-session-ready='false'[\s\S]*visibility:\s*hidden/);
  assert.match(shellCss, /prefers-reduced-motion:\s*reduce[\s\S]*app-message-bubble/);
  assert.doesNotMatch(shellCss, /\.app-message-bubble-own::after/);
  assert.doesNotMatch(shellCss, /\.app-message-bubble-peer::after/);
});

test('bubble path uses the squarer Kordi corner pair on both sides', () => {
  const ownPath = messageBubbleShapePath('own', { width: 220, height: 64 });
  const peerPath = messageBubbleShapePath('peer', { width: 220, height: 64 });

  assert.match(ownPath, /^M 6 0 H 214 C 217 0 220 3 220 6/);
  assert.match(peerPath, /^M 6 0 H 214 C 217 0 220 3 220 6/);
});

test('a run tightens the stacked corner while the outer corner stays rounded', () => {
  const standalone = messageBubbleShapePath('peer', { width: 220, height: 64 });
  const insideRun = messageBubbleShapePath('peer', { width: 220, height: 64 }, { groupedWithPrevious: true });

  assert.match(standalone, /^M 6 0/);
  assert.match(insideRun, /^M 4 0 H 214 C 217 0 220 3 220 6/);
});

test('only the last bubble of a run grows a tail', () => {
  const tailed = messageBubbleShapePath('peer', { width: 220, height: 64 });
  const grouped = messageBubbleShapePath('peer', { width: 220, height: 64 }, { tail: false });
  const tailedOwn = messageBubbleShapePath('own', { width: 220, height: 64 });
  const groupedOwn = messageBubbleShapePath('own', { width: 220, height: 64 }, { tail: false });

  // Telegram tail: rides the edge 17px up, reaches 6.675px past it, closes with a 1px arc.
  assert.match(tailed, /A 1 1 0 0 1 -6\.675 62\.262/);
  assert.match(tailedOwn, /A 1 1 0 0 0 226 64/);
  assert.doesNotMatch(grouped, /A 1 1/);
  assert.doesNotMatch(groupedOwn, /A 1 1/);

  // Without a tail the in-run bubble keeps the tight radius on its stacked side only.
  assert.match(grouped, /V 58 C 220 61 217 64 214 64 H 4 C 2 64 0 62 0 60 V 6/);
  assert.match(groupedOwn, /V 60 C 220 62 218 64 216 64 H 6 C 3 64 0 61 0 58 V 6/);
});

test('the tail stays pinned to the bottom of tall messages', () => {
  const ownTallPath = messageBubbleShapePath('own', { width: 220, height: 240 });
  const peerTallPath = messageBubbleShapePath('peer', { width: 220, height: 240 });

  assert.match(ownTallPath, /V 223 C 220\.193 225\.84 220\.876 228\.767 222\.05 231\.782/);
  assert.match(peerTallPath, /A 1 1 0 0 1 -6\.675 238\.262/);
  assert.doesNotMatch(ownTallPath, /V\s*158/);
  assert.doesNotMatch(peerTallPath, /V\s*158/);
});

test('human bubble styling avoids visible outline seams around the WhatsApp-style tail', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-chat-bubble-user\s*{[\s\S]*--app-message-bubble-stroke:\s*transparent;/);
  assert.match(shellCss, /\.app-chat-bubble-peer\s*{[\s\S]*--app-message-bubble-stroke:\s*transparent;/);
  assert.doesNotMatch(shellCss, /height:\s*calc\(100% \+ var\(--app-message-bubble-tail-depth\)\)/);
});
