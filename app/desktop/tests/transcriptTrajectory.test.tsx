import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { installTranscriptTrajectoryRecorder } from '../src/features/performance/transcriptTrajectory';

test('scroll diagnostics distinguish input and corrections without recording content, then restore the viewport', async () => {
  const dom = new JSDOM('<div data-virtual-transcript-scroll>Private synthetic content</div>');
  const viewport = dom.window.document.querySelector<HTMLElement>('div')!;
  let frame: FrameRequestCallback | undefined;
  const batches: number[][][] = [];
  let accepting = true;
  const scrollTo = function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', { value: scrollTo, configurable: true, writable: true });
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: false }),
    __TAURI_INTERNALS__: { invoke: async (_command: string, args: { frames: number[][] }) => {
      batches.push(args.frames);
      return accepting;
    } },
  });
  const globals = {
    window: dom.window, document: dom.window.document,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frame = callback; return 1; },
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  try {
    await installTranscriptTrajectoryRecorder();
    frame!(0);
    viewport.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 8 }));
    viewport.scrollTop = 40;
    viewport.scrollTo({ top: 65 });
    viewport.dispatchEvent(new dom.window.Event('scroll'));
    for (let i = 0; i < 240; i += 1) viewport.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 1 }));
    frame!(0);
    await new Promise(resolve => setImmediate(resolve));
    const records = batches.flat();
    const events = records.filter(record => record[1] === 2);
    assert.ok(events.some(event => event[4] === 1 && event[6] === 8));
    assert.ok(events.some(event => event[4] === 3 && event[5] === 40 && event[6] === 0 && event[7] === 40));
    assert.ok(events.some(event => event[4] === 4 && event[5] === 65 && event[6] === 40 && event[7] === 65));
    assert.ok(events.some(event => event[4] === 2 && event[5] === 65));
    assert.ok(records.every(record => record.every(Number.isFinite)));
    assert.ok(batches.every(batch => batch.length <= 120));
    assert.ok(!JSON.stringify(batches).includes('Private synthetic content'));
    accepting = false;
    for (let i = 0; i < 60; i += 1) viewport.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 1 }));
    frame!(0);
    await new Promise(resolve => setImmediate(resolve));
    frame!(0);
    assert.equal(Object.hasOwn(viewport, 'scrollTop'), false);
    assert.equal(viewport.scrollTo, scrollTo);
    assert.equal(viewport.scrollTop, 65);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
