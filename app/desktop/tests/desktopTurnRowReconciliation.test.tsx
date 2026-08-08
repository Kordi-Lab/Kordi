import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  buildDesktopLiveTurnTranscriptMessage,
  createDesktopTurnRenderAlias,
  reconcileDesktopMessagesWithTurnRenderAliases,
} from '../src/features/chat/desktopLiveTurns';
import { transcriptMessageRenderKey } from '../src/features/chat/transcriptRenderKeys';
import { mapDesktopMessagesForTranscript } from '../src/features/chat/useDesktopTranscriptAdapter';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

let root: Root | null = null;
let rowMounts = 0;
let rowUnmounts = 0;

function TrackedTranscriptRow({ message }: { message: Message }) {
  useEffect(() => {
    rowMounts += 1;
    return () => {
      rowUnmounts += 1;
    };
  }, []);
  return <div data-message-id={message.id}>{message.text}</div>;
}

function Transcript({ messages }: { messages: Message[] }) {
  return messages.map((message, index) => (
    <TrackedTranscriptRow
      key={transcriptMessageRenderKey(message, index)}
      message={message}
    />
  ));
}

test.before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  target.window = dom.window;
  target.document = dom.window.document;
  target.HTMLElement = dom.window.HTMLElement;
  target.Node = dom.window.Node;
  target.IS_REACT_ACT_ENVIRONMENT = true;
});

test.afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  rowMounts = 0;
  rowUnmounts = 0;
});

test('live-to-canonical completion updates one keyed transcript row without remounting it', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const live: Message = {
    id: 'turn-stable',
    role: 'owned-agent',
    sender: 'My Kordi',
    text: 'streaming',
    time: '12:00',
  };
  await act(async () => root?.render(<Transcript messages={[live]} />));

  const canonical: Message = {
    ...live,
    entryId: 'entry:assistant:stable',
    text: 'persisted',
  };
  await act(async () => root?.render(<Transcript messages={[canonical]} />));

  assert.equal(rowMounts, 1);
  assert.equal(rowUnmounts, 0);
  assert.equal(host.textContent, 'persisted');
});

test('real assistant row keeps its sender, time, and fork control DOM through canonical hydration', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn-stable-ui',
    sessionId: 'session-stable-ui',
    prompt: 'hello',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Hi! 👋 How can I help you today?',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    startedAtMs: 1_725_000_000_000,
    completedAtMs: 1_725_000_001_000,
    transcriptEntryId: 'entry:assistant:stable-ui',
  };
  const live = buildDesktopLiveTurnTranscriptMessage({
    ...completedTurn,
    status: 'writing',
    completed: false,
    succeeded: false,
  });
  const alias = createDesktopTurnRenderAlias(completedTurn);
  const [reconciled] = reconcileDesktopMessagesWithTurnRenderAliases(
    completedTurn.sessionId,
    [{
      role: 'assistant',
      sender: 'Kordi',
      text: completedTurn.assistantText,
      timeLabel: 'later',
      timestampMs: completedTurn.completedAtMs!,
      entryId: completedTurn.transcriptEntryId,
    }],
    new Map([[alias.turnId, alias]]),
  );
  const [canonical] = mapDesktopMessagesForTranscript(
    completedTurn.sessionId,
    [reconciled],
    { agentDisplayName: 'Kordi' },
  );
  const onForkMessage = () => undefined;

  await act(async () => root?.render(<MessageBubble msg={live} onForkMessage={onForkMessage} />));
  const liveForkButton = host.querySelector<HTMLButtonElement>('.app-message-fork-button');
  const liveTime = host.querySelector<HTMLElement>('.app-message-hover-time');
  assert.ok(liveForkButton);
  assert.ok(liveTime?.parentElement?.classList.contains('w-fit'));
  assert.ok(liveTime?.parentElement?.classList.contains('max-w-full'));
  assert.equal(liveTime?.parentElement?.classList.contains('w-full'), false);
  assert.equal(liveForkButton.disabled, true);
  assert.equal(host.querySelector('.app-message-meta')?.textContent?.trim(), 'My Kordi');
  assert.equal(liveTime?.textContent, live.time);

  await act(async () => root?.render(<MessageBubble msg={canonical} onForkMessage={onForkMessage} />));
  const canonicalForkButton = host.querySelector<HTMLButtonElement>('.app-message-fork-button');
  const canonicalTime = host.querySelector<HTMLElement>('.app-message-hover-time');
  assert.equal(canonical.id, live.id);
  assert.equal(canonical.sender, live.sender);
  assert.equal(canonical.time, live.time);
  assert.equal(canonicalForkButton, liveForkButton);
  assert.equal(canonicalTime, liveTime);
  assert.equal(canonicalForkButton?.disabled, false);
  assert.equal(host.querySelector('.app-message-meta')?.textContent?.trim(), 'My Kordi');
  assert.equal(canonicalTime?.textContent, live.time);
});
