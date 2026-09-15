import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import React, { act } from 'react';
import { VirtualTranscript } from '../src/features/chat/VirtualTranscript';
import { cleanupVirtualTranscriptHarness, installVirtualTranscriptHarness, render, rows, triggerObservedResize, virtualRowStart, flush } from './support/virtualTranscriptHarness';

let shelfHeight = 0;
before(async () => {
  await installVirtualTranscriptHarness();
  HTMLElement.prototype.getBoundingClientRect = function () {
    const viewport = this.closest<HTMLElement>('[data-virtual-transcript-scroll]');
    const start = this.matches('[data-transcript-row-key]') ? virtualRowStart(this) : 0;
    const top = shelfHeight + start - (this.matches('[data-transcript-row-key]') ? viewport?.scrollTop ?? 0 : 0);
    return { top, bottom: top + this.offsetHeight, height: this.offsetHeight, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} };
  };
});
afterEach(cleanupVirtualTranscriptHarness);

function view(items: ReturnType<typeof rows>, passiveKey: string, messageKey = 'same-messages') {
  return <VirtualTranscript items={items} sessionKey="pin-scroll" getItemKey={item => item.id}
    renderItem={item => <div data-test-row-height={item.height} data-message-id={item.id}>{item.id}</div>}
    estimateSize={item => item.height} scrollStyle={{ height: 600 - shelfHeight }}
    passiveUpdateKey={passiveKey} messageContentKey={messageKey} />;
}

test('pin and unpin preserve visible messages across notice insertion, measurement and shelf changes', async () => {
  shelfHeight = 0;
  const messages = rows('message-', 0, 25);
  const root = await render(view(messages, 'none'));
  const viewport = root.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
  await act(async () => viewport.scrollTo({ top: viewport.scrollHeight - viewport.clientHeight }));
  await flush();
  const anchor = root.host.querySelector<HTMLElement>('[data-message-id="message-20"]')!.closest<HTMLElement>('[data-transcript-row-key]')!;
  const before = anchor.getBoundingClientRect().top;
  shelfHeight = 64;
  await root.rerender(view(messages, 'shelf'));
  await act(async () => { triggerObservedResize?.(viewport); });
  await flush();
  assert.equal(anchor.getBoundingClientRect().top, before, 'Showing the shelf alone must preserve the message');
  const pinned = [...messages, { id: 'pin', height: 58 }];
  await root.rerender(view(pinned, 'pin'));
  await act(async () => { triggerObservedResize?.(viewport); });
  await flush();
  assert.equal(anchor.getBoundingClientRect().top, before, 'Pin shelf and new notice must not move the visible message');
  const notice = root.host.querySelector<HTMLElement>('[data-message-id="pin"]');
  assert.ok(notice);
  {
    notice.dataset.testRowHeight = '74';
    await act(async () => { triggerObservedResize?.(notice.closest('[data-transcript-row-key]')!); });
    await flush();
  }
  assert.equal(anchor.getBoundingClientRect().top, before, 'Late notice measurement must retain the anchor');
  shelfHeight = 0;
  await root.rerender(view([...pinned, { id: 'unpin', height: 58 }], 'unpin'));
  await act(async () => { triggerObservedResize?.(viewport); });
  await flush();
  assert.equal(anchor.getBoundingClientRect().top, before, 'Removing the shelf and adding unpin must preserve the same message');
  const latest = root.host.querySelector<HTMLButtonElement>('[data-transcript-latest-button]');
  assert.ok(latest, 'New notices below the viewport remain reachable');
  await act(async () => latest.click());
  await flush();
  assert.ok(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1, 'Explicit latest navigation releases the preserved anchor');
  await act(async () => viewport.scrollTo({ top: viewport.scrollTop - 100 }));
  const readingTop = viewport.scrollTop;
  await root.rerender(view([...pinned, { id: 'unpin', height: 58 }, { id: 'message-new', height: 50 }], 'unpin', 'new-message'));
  assert.equal(viewport.scrollTop, readingTop, 'New messages still respect history reading');
});
