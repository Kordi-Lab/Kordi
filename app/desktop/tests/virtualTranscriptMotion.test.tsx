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

test.before(async () => {
  await installVirtualTranscriptHarness();
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

test('an outgoing append lifts only existing rows by its measured height and honors reduced motion', async () => {
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
    assert.equal(previousRow.style.getPropertyValue('--app-transcript-row-lift'), '144px');
    assert.equal(
      previousRow.style.animation,
      'app-transcript-existing-row-lift 150ms cubic-bezier(0.23, 1, 0.32, 1)',
    );
    assert.equal(appendedRow.style.animation, '');

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }) as MediaQueryList,
    });
    await view.rerender(transcript({
      items: [...initialItems, { id: 'motion-20', height: 140 }, { id: 'motion-21', height: 80 }],
      sessionKey: 'motion-tail-follow',
      animateLatestAppend: true,
    }));
    assert.equal(previousRow.style.animation, 'none');
    assert.equal(view.host.querySelector<HTMLElement>('[data-index="21"]')?.style.animation, '');
  } finally {
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else delete (window as Partial<Window>).matchMedia;
  }
});
