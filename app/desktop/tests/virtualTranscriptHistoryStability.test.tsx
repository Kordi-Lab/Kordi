import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import {
  cleanupVirtualTranscriptHarness, flush, installVirtualTranscriptHarness,
  render, rows, transcript, triggerObservedResize, virtualRowStart,
} from './support/virtualTranscriptHarness';

test.before(installVirtualTranscriptHarness);
test.afterEach(cleanupVirtualTranscriptHarness);

function visibleAnchor(host: HTMLElement, viewport: HTMLElement) {
  const row = [...host.querySelectorAll<HTMLElement>('[data-transcript-window-item]')]
    .find((item) => virtualRowStart(item) <= viewport.scrollTop
      && virtualRowStart(item) + item.offsetHeight > viewport.scrollTop)!;
  assert.ok(row);
  return { id: row.querySelector<HTMLElement>('[data-message-id]')!.dataset.messageId!,
    offset: virtualRowStart(row) - viewport.scrollTop };
}

function assertAnchor(host: HTMLElement, viewport: HTMLElement, anchor: ReturnType<typeof visibleAnchor>) {
  const row = host.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`)?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(row, 'the reading anchor should stay mounted');
  assert.ok(Math.abs(virtualRowStart(row) - viewport.scrollTop - anchor.offset) < 1,
    'the reading anchor must retain its screen position');
}

async function resizeRow(host: HTMLElement, id: string, height: number) {
  const content = host.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
  const row = content?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(content); assert.ok(row);
  await act(async () => {
    content.dataset.testRowHeight = String(height);
    assert.ok((triggerObservedResize?.(row) ?? 0) > 0);
  });
  await flush();
}

test('late growth inside the viewport does not move a history reader', async () => {
  const view = await render(transcript({ items: rows('m', 0, 100, 74) }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
  await act(async () => viewport.scrollTo({ top: 1_000 }));
  const anchor = visibleAnchor(view.host, viewport);
  await resizeRow(view.host, 'm18', 300);
  assert.equal(viewport.scrollTop, 1_000, 'a visible 74-to-300px resize must not add a 226px scroll');
  assertAnchor(view.host, viewport, anchor);
});

test('the partially visible anchor stays fixed while above-anchor growth is compensated', async () => {
  const view = await render(transcript({ items: rows('m', 0, 100, 74) }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
  await act(async () => viewport.scrollTo({ top: 1_100 }));
  const anchor = visibleAnchor(view.host, viewport);
  await resizeRow(view.host, anchor.id, 174);
  assert.equal(viewport.scrollTop, 1_100);
  assertAnchor(view.host, viewport, anchor);
  await resizeRow(view.host, 'm12', 224);
  assert.equal(viewport.scrollTop, 1_250);
  assertAnchor(view.host, viewport, anchor);
});

test('a variable-height older page and delayed media preserve the latest user scroll anchor', async () => {
  const initial = rows('m', 100, 100, 74);
  const view = await render(transcript({ items: initial }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
  await act(async () => viewport.scrollTo({ top: 200 }));
  // The reader continues moving while the older page is in flight.
  await act(async () => viewport.scrollTo({ top: 80 }));
  const anchor = visibleAnchor(view.host, viewport);
  const older = rows('m', 50, 50).map((row, index) => ({ ...row, height: index % 2 ? 50 : 180 }));
  await view.rerender(transcript({ items: [...older, ...initial] }));
  assertAnchor(view.host, viewport, anchor);
  await resizeRow(view.host, 'm104', 300);
  assertAnchor(view.host, viewport, anchor);
  await act(async () => viewport.scrollTo({ top: viewport.scrollTop - 24 }));
  const movedAnchor = visibleAnchor(view.host, viewport);
  await resizeRow(view.host, 'm99', 220);
  assertAnchor(view.host, viewport, movedAnchor);
});

test('older history is prefetched two screens ahead and remains single-flight', async () => {
  let calls = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const view = await render(transcript({ items: rows('m', 0, 100, 74), hasOlder: true,
    onLoadOlder: () => { calls += 1; return pending; } }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
  assert.equal(calls, 0, 'opening at the latest message should not backfill the entire history');
  await act(async () => viewport.scrollTo({ top: 1_100 }));
  assert.equal(calls, 1);
  await act(async () => viewport.scrollTo({ top: 900 }));
  assert.equal(calls, 1);
  await act(async () => { finish(); await pending; });
});

test('an upward wheel can request history when the current page is too short to scroll', async () => {
  let calls = 0;
  const view = await render(transcript({ items: rows('short', 0, 3, 74), hasOlder: true,
    onLoadOlder: async () => { calls += 1; } }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
  assert.equal(calls, 0);
  await act(async () => viewport.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: -40 })));
  assert.equal(calls, 1);
});

test('upward wheel input suspends tail following before a scroll event arrives', async () => {
  const tailChanges: boolean[] = [];
  const view = await render(transcript({ items: rows('m', 0, 20, 74), onTailChange: (atTail) => tailChanges.push(atTail) }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]')!;
  const before = viewport.scrollTop;
  await act(async () => viewport.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: -40 })));
  await flush();
  assert.equal(tailChanges.at(-1), false);
  assert.equal(viewport.scrollTop, before, 'wheel handling must not replace native scrolling with a synthetic animation');
});
