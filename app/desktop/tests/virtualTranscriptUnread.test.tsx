import assert from 'node:assert/strict';
import test from 'node:test';

import { act } from 'react';
import {
  cleanupVirtualTranscriptHarness,
  flush,
  installVirtualTranscriptHarness,
  render,
  rows,
  transcript,
} from './support/virtualTranscriptHarness';

test.before(async () => {
  await installVirtualTranscriptHarness();
});

test.afterEach(async () => {
  await cleanupVirtualTranscriptHarness();
});

test('a notice appended after one long reply does not pull a reader to the bottom', async () => {
  const initialItems = rows('long-reply-', 0, 1, 2_000);
  const view = await render(transcript({ items: initialItems, sessionKey: 'single-reply' }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);
  await act(async () => viewport.scrollTo({ top: 100 }));
  await flush();
  await view.rerender(transcript({
    items: [...initialItems, ...rows('model-notice-', 0, 1, 50)],
    sessionKey: 'single-reply',
  }));
  assert.equal(viewport.scrollTop, 100);
  assert.ok(view.host.querySelector('[data-transcript-latest-button="true"]'));
});

test('a scrolled-up transcript counts unread messages and clears at latest', async () => {
  const initialItems = rows('unread-', 0, 100, 50);
  const tailChanges: boolean[] = [];
  const props = {
    sessionKey: 'new-message-count',
    onTailChange: (isAtTail: boolean) => tailChanges.push(isAtTail),
  };
  const view = await render(transcript({ items: initialItems, ...props }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);

  await act(async () => viewport.scrollTo({ top: 1_000 }));
  await flush();
  assert.ok(view.host.querySelector('[data-transcript-latest-button="true"]'));
  assert.equal(view.host.querySelector('[data-new-message-count]'), null);

  await view.rerender(transcript({
    items: [...rows('older-', 0, 20, 50), ...initialItems],
    ...props,
  }));
  assert.equal(view.host.querySelector('[data-new-message-count]'), null);

  await view.rerender(transcript({
    items: [...rows('older-', 0, 20, 50), ...initialItems, ...rows('new-', 0, 120, 50)],
    unreadCount: 120,
    ...props,
  }));
  const badge = view.host.querySelector<HTMLElement>('[data-new-message-count]');
  assert.equal(badge?.dataset.newMessageCount, '120');
  assert.equal(badge?.textContent, '99+');

  const button = view.host.querySelector<HTMLButtonElement>('[data-transcript-latest-button="true"]');
  assert.match(button?.getAttribute('aria-label') ?? '', /120 new messages/);
  tailChanges.length = 0;
  await act(async () => button?.click());
  await flush();
  assert.equal(view.host.querySelector('[data-transcript-latest-button="true"]'), null);
  assert.equal(tailChanges.at(-1), true);
});
