import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueuedMessageBubble } from '../src/pages/chatsPage.queuedMessage';

async function render(props: { threadLayout?: boolean }, edits: string[], cancels: string[]) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(QueuedMessageBubble, {
      message: { id: 'q1', sessionId: 's1', text: 'what next', time: '07:26', attachments: [] },
      isCompressionActive: false,
      onEdit: (_session: string, id: string) => edits.push(id),
      onCancel: (_session: string, id: string) => cancels.push(id),
      ...props,
    }));
  });
  return { host, root };
}

test('thread layout renders the queued message as a left thread row', async () => {
  const edits: string[] = [];
  const cancels: string[] = [];
  const { host, root } = await render({ threadLayout: true }, edits, cancels);
  try {
    const row = host.querySelector('.app-thread-message-row');
    assert.ok(row);
    assert.equal(row.getAttribute('data-message-layout'), 'threads');
    assert.equal(host.querySelector('.app-thread-message-author')?.textContent, 'Me');
    assert.equal(host.querySelector('.app-thread-message-queued')?.textContent, 'Queued');
    assert.equal(host.querySelector('.app-thread-message-time')?.textContent, '07:26');
    assert.ok(!host.textContent?.includes('Queued next'));
    await act(async () => (host.querySelector('.app-queued-message-edit') as HTMLButtonElement).click());
    await act(async () => (host.querySelector('.app-queued-message-cancel') as HTMLButtonElement).click());
    assert.deepEqual(edits, ['q1']);
    assert.deepEqual(cancels, ['q1']);
  } finally {
    await act(async () => root.unmount());
  }
});

test('non-thread layout keeps the bubble with sentence-case label', async () => {
  const { host, root } = await render({}, [], []);
  try {
    assert.equal(host.querySelector('.app-thread-message-row'), null);
    assert.ok(host.textContent?.includes('Queued next'));
    assert.ok(!host.querySelector('.app-queued-message-label')?.className.includes('uppercase'));
  } finally {
    await act(async () => root.unmount());
  }
});
