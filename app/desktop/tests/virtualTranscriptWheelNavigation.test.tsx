import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { cleanupVirtualTranscriptHarness, flush, installVirtualTranscriptHarness, render, rows, transcript, virtualRowStart } from './support/virtualTranscriptHarness';

test.before(installVirtualTranscriptHarness);
test.afterEach(cleanupVirtualTranscriptHarness);
test('an unfinished latest-row target yields to wheel input before history is prepended', async () => {
  const originalRequest = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  // Hold entry-alignment frames until the reader has scrolled into history.
  // A prepend then changes the still-pending latest-row navigation target.
  const scheduled = new Map<number, FrameRequestCallback>();
  let frameId = 10000;
  window.requestAnimationFrame = callback => { const id = ++frameId; scheduled.set(id, callback); return id; };
  window.cancelAnimationFrame = id => { scheduled.delete(id); };
  try {
    const initial = rows('m', 100, 100, 50);
    const view = await render(transcript({ items: initial }));
    const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
    await act(async () => {
      viewport.scrollTo({ top: 1000 });
    });
    const nativeScrollTo = viewport.scrollTo;
    let wheelScrollWrites = 0;
    viewport.scrollTo = (...args) => { wheelScrollWrites += 1; nativeScrollTo.apply(viewport, args); };
    await act(async () => {
      viewport.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: -40 }));
    });
    assert.equal(wheelScrollWrites, 0, 'cancelling navigation must not interrupt native momentum with a DOM scroll');
    viewport.scrollTo = nativeScrollTo;
    const reference = [...view.host.querySelectorAll<HTMLElement>('[data-transcript-window-item]')].find(row => virtualRowStart(row) <= viewport.scrollTop && virtualRowStart(row) + row.offsetHeight > viewport.scrollTop)!;
    assert.ok(reference);
    const id = reference.querySelector<HTMLElement>('[data-message-id]')!.dataset.messageId!;
    const offset = virtualRowStart(reference) - viewport.scrollTop;
    await view.rerender(transcript({ items: [...rows('m', 50, 50, 50), ...initial] }));
    await act(async () => {
      for (let frame = 0; frame < 8; frame += 1) {
        const callbacks = [...scheduled.values()]; scheduled.clear();
        for (const callback of callbacks) callback(Date.now());
        await Promise.resolve();
      }
    });
    await flush();
    const current = view.host.querySelector<HTMLElement>(`[data-message-id="${id}"]`)?.closest<HTMLElement>('[data-transcript-window-item]');
    assert.ok(current, 'reading row must remain mounted');
    assert.ok(Math.abs(virtualRowStart(current) - viewport.scrollTop - offset) < 1, 'pending tail target must not pull a history reader away after prepend');
  } finally { window.requestAnimationFrame = originalRequest; window.cancelAnimationFrame = originalCancel; }
});
