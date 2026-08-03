import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ChatSessionPaneProps } from '../src/pages/chatsPage.types';
import {
  clearChatPerformanceRecords,
  readChatPerformanceRecords,
} from '../src/features/performance/chatPerformance';

let ChatSessionPane: typeof import('../src/pages/chatsPage.sessionPane').ChatSessionPane;
let root: Root | null = null;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  target.window = dom.window;
  target.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  target.HTMLElement = dom.window.HTMLElement;
  target.Element = dom.window.Element;
  target.Node = dom.window.Node;
  target.Event = dom.window.Event;
  target.CustomEvent = dom.window.CustomEvent;
  target.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  target.IS_REACT_ACT_ENVIRONMENT = true;

  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    dom.window.setTimeout(() => callback(Date.now()), 0)
  );
  const cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
  target.requestAnimationFrame = requestAnimationFrame;
  target.cancelAnimationFrame = cancelAnimationFrame;
  dom.window.requestAnimationFrame = requestAnimationFrame;
  dom.window.cancelAnimationFrame = cancelAnimationFrame;

  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  target.ResizeObserver = NoopResizeObserver;
  (dom.window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    NoopResizeObserver as unknown as typeof ResizeObserver;
}

const messages: ChatSessionPaneProps['viewport']['messages'] = [];
const queuedMessages: NonNullable<
  ChatSessionPaneProps['viewport']['queuedMessages']
> = [];
const scrollRef = createRef<HTMLDivElement>();
const actions: ChatSessionPaneProps['actions'] = {
  onOpenSource: () => {},
  onOpenArtifact: () => {},
  onOpenAuthSettings: () => {},
  onStopCollaborationAgentRequest: () => {},
};
const presentation: ChatSessionPaneProps['presentation'] = {
  liveTurnSender: 'Kordi',
  shouldRenderLiveTurn: false,
};
const selection: ChatSessionPaneProps['selection'] = {};

function sessionPane(composerLabel: string) {
  return (
    <ChatSessionPane
      presentation={presentation}
      actions={actions}
      selection={selection}
      viewport={{
        sessionKey: 'session:stable',
        messages,
        queuedMessages,
        scrollRef,
        scrollClassName: 'test-scroll',
        hasOlderMessages: true,
        // The workspace recreates this session-bound closure while typing.
        onLoadOlderMessages: () => {},
        composer: <div data-composer-label={composerLabel}>{composerLabel}</div>,
      }}
    />
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test.before(async () => {
  installDom();
  globalThis.__KORDI_PERF_DIAGNOSTICS__ = true;
  ({ ChatSessionPane } = await import('../src/pages/chatsPage.sessionPane'));
});

test.afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  clearChatPerformanceRecords();
});

test.after(() => {
  delete globalThis.__KORDI_PERF_DIAGNOSTICS__;
});

test('composer-only updates do not rerender the transcript subtree', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(sessionPane('first draft')));
  await flush();
  clearChatPerformanceRecords();

  await act(async () => root?.render(sessionPane('second draft')));
  await flush();

  const transcriptRenders = readChatPerformanceRecords().filter(
    (record) => record.name === 'transcript-virtual-render',
  );
  assert.equal(transcriptRenders.length, 0);
  assert.equal(
    host.querySelector('[data-composer-label]')?.textContent,
    'second draft',
  );
});
