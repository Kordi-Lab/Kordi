import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueuedMessageBubble } from '../src/pages/chatsPage.queuedMessage';

async function render(props: { threadLayout?: boolean; densityMode?: 'default' | 'contact-compact'; showAvatar?: boolean; avatarImageUrl?: string | null }, edits: string[], cancels: string[]) {
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

test('non-thread layout renders a pending outgoing bubble with a quiet status line', async () => {
  const edits: string[] = [];
  const cancels: string[] = [];
  const { host, root } = await render({}, edits, cancels);
  try {
    assert.equal(host.querySelector('.app-thread-message-row'), null);
    const bubble = host.querySelector('.app-queued-message');
    assert.ok(bubble);
    assert.match(bubble.className, /app-message-bubble-own/);
    assert.match(bubble.className, /app-chat-bubble-user/);
    assert.match(bubble.className, /app-message-bubble-queued/);
    assert.ok(!host.textContent?.includes('Queued next'));
    const meta = bubble.querySelector('.app-queued-message-meta');
    assert.ok(meta);
    assert.equal(meta.querySelector('.app-queued-message-label')?.textContent, 'Queued');
    assert.ok(!meta.textContent?.includes('07:26'), 'the clock time stays on hover like sent messages');
    assert.equal(meta.querySelector('.app-queued-message-actions'), null);
    assert.equal(bubble.querySelector('.app-queued-message-actions'), null, 'actions sit outside the bubble');
    assert.ok(bubble.closest('.app-queued-message-row')?.querySelector('.app-queued-message-actions'), 'actions live in the row');
    assert.ok(!meta.className.includes('uppercase'));
    await act(async () => (host.querySelector('.app-queued-message-edit') as HTMLButtonElement).click());
    await act(async () => (host.querySelector('.app-queued-message-cancel') as HTMLButtonElement).click());
    assert.deepEqual(edits, ['q1']);
    assert.deepEqual(cancels, ['q1']);
  } finally {
    await act(async () => root.unmount());
  }
});

test('default density renders gap-2, an h-8 avatar and the default bubble padding', async () => {
  const { host, root } = await render({ densityMode: 'default', avatarImageUrl: 'https://example.test/me.png' }, [], []);
  try {
    const row = host.querySelector('.app-queued-message-row')!;
    assert.match(row.className, /\bgap-2\b/);
    assert.doesNotMatch(row.className, /gap-1\.5/);
    const avatar = row.querySelector('img, [data-identity-avatar], .h-8.w-8');
    assert.ok(avatar);
    assert.match(row.innerHTML, /h-8 w-8/);
    assert.equal(row.querySelector('.app-message-avatar-spacer'), null);
    assert.match(host.querySelector('.app-queued-message')!.className, /px-4 py-2\.5/);
    assert.match(row.innerHTML, /example\.test\/me\.png/, 'avatar receives the image url');
  } finally {
    await act(async () => root.unmount());
  }
});

test('compact density renders gap-1.5, an h-7 avatar and compact bubble padding', async () => {
  const { host, root } = await render({ densityMode: 'contact-compact' }, [], []);
  try {
    const row = host.querySelector('.app-queued-message-row')!;
    assert.match(row.className, /gap-1\.5/);
    assert.match(row.innerHTML, /h-7 w-7/);
    assert.doesNotMatch(row.innerHTML, /h-8 w-8/);
    const bubble = host.querySelector('.app-queued-message')!;
    assert.match(bubble.className, /app-message-bubble-contact-compact/);
    assert.match(bubble.className, /px-3 py-1\.5/);
    assert.match(bubble.className, /rounded-\[8px\]/);
    assert.match(bubble.className, /app-message-bubble-queued/);
  } finally {
    await act(async () => root.unmount());
  }
});

test('showAvatar false keeps a same-size spacer instead of the avatar', async () => {
  for (const densityMode of ['default', 'contact-compact'] as const) {
    const { host, root } = await render({ densityMode, showAvatar: false }, [], []);
    try {
      const spacer = host.querySelector('.app-queued-message-row .app-message-avatar-spacer');
      assert.ok(spacer);
      assert.match(spacer.className, densityMode === 'default' ? /h-8 w-8/ : /h-7 w-7/);
      assert.equal(host.querySelectorAll('.app-queued-message-row img').length, 0);
    } finally {
      await act(async () => root.unmount());
    }
  }
});
