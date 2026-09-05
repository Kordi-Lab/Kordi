import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installVirtualTranscriptHarness } from './support/virtualTranscriptHarness';
import type { Message } from '../src/kordi-app/types';

test('synced queued requests show the queue card without a processing placeholder, then become running', async () => {
  await installVirtualTranscriptHarness();
  const { useChatTranscriptViewport } = await import('../src/pages/chatsPage.transcriptViewport');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  const request: Message = { id: 'request-b', role: 'user', sender: 'You', text: 'Next request', time: '10:00' };
  const response: Message = {
    id: 'response-b', role: 'owned-agent', sender: 'Kordi', text: '', time: '10:00', replyToMessageId: request.id,
    turn: {
      id: 'turn-b', sessionId: 'session', prompt: request.text, status: 'queued', message: 'Queued next',
      assistantText: '', thinkingText: '', tools: [], completed: false, succeeded: false, replyToMessageId: request.id,
    },
  };
  function Transcript({ messages }: { messages: Message[] }) {
    return useChatTranscriptViewport({
      viewport: { sessionKey: 'session', scrollRef: useRef(null), messages, scrollClassName: '', emptyState: null, composer: null },
      presentation: { liveTurnSender: 'Kordi', shouldRenderLiveTurn: false },
      actions: { onOpenSource() {}, onOpenArtifact() {}, onOpenAuthSettings() {}, onStopCollaborationAgentRequest() {}, onStopActiveTurn() {} },
      selection: {}, transcriptMessages: messages, transcriptEntries: messages.map((message, originalIndex) => ({ message, originalIndex })),
      transcriptTailKey: messages.at(-1)?.turn?.status ?? '',
    });
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<Transcript messages={[request, response]} />); });
    assert.match(container.textContent ?? '', /Queued next/);
    assert.equal(container.querySelectorAll('.app-queued-message').length, 1);
    assert.equal(container.querySelectorAll('.app-agent-waiting-wave').length, 0);
    assert.equal(container.querySelectorAll('.app-queued-message-actions').length, 0);
    await act(async () => { root.render(<Transcript messages={[request, { ...response, turn: { ...response.turn!, status: 'preparing' } }]} />); });
    assert.equal(container.querySelectorAll('.app-queued-message').length, 0);
    assert.equal(container.querySelectorAll('.app-agent-waiting-wave').length, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
