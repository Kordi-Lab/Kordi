import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupVirtualTranscriptHarness,
  flush,
  installVirtualTranscriptHarness,
  render,
  rows,
  transcript,
  virtualRowStart,
} from './support/virtualTranscriptHarness';

const animations = new WeakMap<HTMLElement, { frames: Keyframe[]; cancelled: boolean }>();
test.before(async () => {
  await installVirtualTranscriptHarness();
  HTMLElement.prototype.getBoundingClientRect = function() {
    const y = virtualRowStart(this);
    const offset = Number.parseFloat(this.style.translate.split(/\s+/)[1] ?? '0') || 0;
    const scrollTop = this.closest<HTMLElement>('[data-virtual-transcript-scroll]')?.scrollTop ?? 0;
    return { top: y + offset - scrollTop, bottom: y + offset - scrollTop + this.offsetHeight,
      left: 0, right: 800, width: 800, height: this.offsetHeight, x: 0, y: y + offset - scrollTop, toJSON() {} };
  };
  HTMLElement.prototype.animate = function(frames) {
    const record = { frames: frames as Keyframe[], cancelled: false };
    animations.set(this, record);
    return { cancel: () => { record.cancelled = true; }, onfinish: null } as unknown as Animation;
  };
});

test.afterEach(async () => {
  await cleanupVirtualTranscriptHarness();
});

test('a switched session stays hidden until its measured tail is stable', async () => {
  const view = await render(transcript({ items: rows('a', 0, 1_000), sessionKey: 'a' }));
  await view.rerender(transcript({ items: rows('b', 0, 1_000), sessionKey: 'b' }));
  const sizeContainer = view.host.querySelector<HTMLElement>('[data-virtual-transcript-size]');
  assert.equal(sizeContainer?.dataset.virtualTranscriptSessionReady, 'false');
  for (let frame = 0; frame < 5; frame += 1) await flush();
  assert.equal(sizeContainer?.dataset.virtualTranscriptSessionReady, 'true');
});

test('an outgoing append preserves actual row displacement through interruption and reduced motion', async () => {
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  try {
    const initialItems = rows('motion-', 0, 20, 50);
    const view = await render(transcript({
      items: initialItems,
      sessionKey: 'motion-tail-follow',
      animateLatestAppend: true,
    }));
    await view.rerender(transcript({
      items: [...initialItems, { id: 'motion-20', height: 140 }],
      sessionKey: 'motion-tail-follow',
      animateLatestAppend: true,
    }));

    const previousRow = view.host.querySelector<HTMLElement>('[data-index="19"]');
    const appendedRow = view.host.querySelector<HTMLElement>('[data-index="20"]');
    assert.ok(previousRow);
    assert.ok(appendedRow);
    assert.deepEqual(animations.get(previousRow)?.frames, [
      { translate: '0 144px' }, { translate: '0 0' },
    ]);
    assert.deepEqual(animations.get(appendedRow)?.frames, [
      { translate: '0 144px' }, { translate: '0 0' },
    ]);
    const firstAnimation = animations.get(previousRow);
    // Simulate an unfinished lift when a second message arrives.
    previousRow.style.translate = '0 60px';
    await view.rerender(transcript({
      items: [...initialItems, { id: 'motion-20', height: 140 }, { id: 'motion-21', height: 80 }],
      sessionKey: 'motion-tail-follow', animateLatestAppend: true,
    }));
    assert.equal(firstAnimation?.cancelled, true);
    assert.deepEqual(animations.get(previousRow)?.frames, [
      { translate: '0 144px' }, { translate: '0 0' },
    ]);

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }) as MediaQueryList,
    });
    await view.rerender(transcript({
      items: [...initialItems, { id: 'motion-20', height: 140 }, { id: 'motion-21', height: 80 }, { id: 'motion-22', height: 80 }],
      sessionKey: 'motion-tail-follow',
      animateLatestAppend: true,
    }));
    assert.equal(animations.get(previousRow)?.cancelled, true);
    assert.equal(view.host.querySelector<HTMLElement>('[data-index="21"]')?.style.animation, '');
  } finally {
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else delete (window as Partial<Window>).matchMedia;
  }
});

test('moving the viewport does not invent an outgoing row animation', async () => {
  const { captureTranscriptRowLayoutTops, alignAndRevealMeasuredTranscriptRows } = await import('../src/features/chat/virtualTranscriptMotion');
  const viewport = document.createElement('div');
  viewport.dataset.virtualTranscriptScroll = 'true';
  const content = document.createElement('div');
  const row = document.createElement('div');
  row.dataset.transcriptWindowItem = 'true';
  row.dataset.index = '0';
  viewport.append(content);
  content.append(row);
  let viewportTop = 20;
  viewport.getBoundingClientRect = () => new window.DOMRect(0, viewportTop, 400, 200);
  row.getBoundingClientRect = () => new window.DOMRect(0, viewportTop + 80, 400, 40);
  Object.defineProperty(row, 'offsetHeight', { value: 40 });
  const previousRowTops = captureTranscriptRowLayoutTops(content);
  viewportTop = 10;
  const animated = alignAndRevealMeasuredTranscriptRows({
    alignToTail: () => {}, gap: 4, reduceMotion: false, revealFromIndex: 1,
    sizeContainer: content, previousRowTops,
    virtualizer: {
      getTotalSize: () => 120,
      getVirtualItems: () => [{ index: 0, size: 40, start: 80 }],
      measureElement: () => {},
    },
  });
  assert.deepEqual(animated, []);
  assert.equal(animations.has(row), false);
});

test('rows filled in around a remembered row do not slide it from the half-loaded layout', async () => {
  const { captureTranscriptRowLayoutTops, alignAndRevealMeasuredTranscriptRows } = await import('../src/features/chat/virtualTranscriptMotion');
  const viewport = document.createElement('div');
  viewport.dataset.virtualTranscriptScroll = 'true';
  const content = document.createElement('div');
  viewport.append(content);
  viewport.getBoundingClientRect = () => new window.DOMRect(0, 0, 400, 600);
  const makeRow = (index: number, top: number) => {
    const row = document.createElement('div');
    row.dataset.transcriptWindowItem = 'true';
    row.dataset.index = String(index);
    row.getBoundingClientRect = () => new window.DOMRect(0, top, 400, 40);
    Object.defineProperty(row, 'offsetHeight', { value: 40 });
    return row;
  };
  // A chat opens with only its newest reply drawn near the top.
  const reply = makeRow(0, 130);
  content.append(reply);
  const previousRowTops = captureTranscriptRowLayoutTops(content);
  // History fills in above it and a new request is appended below.
  content.replaceChildren(makeRow(0, 300), makeRow(1, 340), makeRow(2, 380), reply, makeRow(4, 590));
  reply.dataset.index = '3';
  reply.getBoundingClientRect = () => new window.DOMRect(0, 550, 400, 40);
  const animated = alignAndRevealMeasuredTranscriptRows({
    alignToTail: () => {}, gap: 4, reduceMotion: false, revealFromIndex: 4,
    sizeContainer: content, previousRowTops,
    virtualizer: {
      getTotalSize: () => 640,
      getVirtualItems: () => [0, 1, 2, 3, 4].map((index) => ({ index, size: 40, start: 300 + index * 40 })),
      measureElement: () => {},
    },
  });
  assert.deepEqual(animated, []);
  assert.equal(animations.has(reply), false);
});
