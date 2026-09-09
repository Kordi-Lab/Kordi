import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupVirtualTranscriptHarness,
  flush,
  installVirtualTranscriptHarness,
  render,
  rows,
  transcript,
} from './support/virtualTranscriptHarness';

const animations = new WeakMap<HTMLElement, { frames: Keyframe[]; cancelled: boolean }>();
test.before(async () => {
  await installVirtualTranscriptHarness();
  HTMLElement.prototype.getBoundingClientRect = function() {
    const y = Number(this.style.transform.match(/translate3d\([^,]+,\s*([-\d.]+)px/)?.[1] ?? 0);
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
