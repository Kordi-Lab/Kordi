import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble } from '../src/kordi-app/components/transcript';
import { TranscriptMessageTransferActions } from '../src/kordi-app/components/transcriptMessageTransferActions';
import type { Message } from '../src/kordi-app/types';

test('failed own messages render an external retry action opposite the avatar', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@Testuser3sKordi can you see our chat history?',
    time: '00:45',
    statusChips: ['failed'],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    onRetryMessage: () => {},
  }));

  assert.doesNotMatch(markup, />Sending failed</);
  assert.match(markup, />!<\/span>/);
  assert.match(markup, /data-message-retry-button="true"/);
  assert.match(markup, /data-message-transfer-action-side="opposite-avatar"/);
  assert.match(markup, /aria-label="Retry sending message"/);
  assert.match(markup, /title="Retry sending message"/);
  assert.match(markup, /h-7 w-7/);
  assert.match(markup, /data-message-delivery-glyph="none"/);
  assert.match(markup, /text-rose-600/);
});

const failedImageMessage: Message = {
  role: 'user',
  sender: 'Me',
  senderType: 'human',
  isOwnMessage: true,
  text: '',
  time: '00:46',
  statusChips: ['failed'],
  attachments: [{
    kind: 'image',
    name: 'Failed image.jpg',
    previewUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="800" height="600"/%3E',
    mimeType: 'image/jpeg',
  }],
};

test('failed image messages place a labeled retry control beside the image', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: failedImageMessage,
    onRetryMessage: () => {},
  }));

  assert.match(markup, /data-message-retry-placement="beside-image"/);
  assert.match(markup, />Failed<\/span>/);
  assert.match(markup, />Retry<\/span>/);
  assert.match(markup, /self-center/);
  assert.doesNotMatch(markup, /data-attachment-image-delivery-status="failed"/);
});

test('image retry stays clickable and shows progress until retry completes', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:1420/',
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  let root: Root | null = null;
  let finishRetry: (() => void) | undefined;

  try {
    const retry = new Promise<void>((resolve) => { finishRetry = resolve; });
    const host = dom.window.document.querySelector<HTMLDivElement>('#root');
    assert.ok(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(TranscriptMessageTransferActions, {
      message: failedImageMessage,
      showUploads: false,
      retryable: true,
      onRetryMessage: () => retry,
    })));

    const button = host.querySelector<HTMLButtonElement>('[data-message-retry-button="true"]');
    assert.ok(button);
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(button.dataset.messageRetryState, 'retrying');
    assert.equal(button.disabled, true);
    assert.match(button.textContent ?? '', /Retrying…/);
    assert.ok(button.querySelector('.animate-spin'));

    await act(async () => {
      finishRetry?.();
      await retry;
    });
    assert.equal(button.dataset.messageRetryState, 'idle');
    assert.equal(button.disabled, false);
  } finally {
    if (root) await act(async () => root?.unmount());
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  }
});
