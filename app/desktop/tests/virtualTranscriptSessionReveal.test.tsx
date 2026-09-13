import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installVirtualTranscriptHarness } from './support/virtualTranscriptHarness';
import { useStableTranscriptSessionReveal } from '../src/features/chat/virtualTranscriptMotion';

test.before(installVirtualTranscriptHarness);

test('every entry waits for measurement, including first hydration and a rapid return', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const originalRequest = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = id => { frames.delete(id); };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const viewport = document.createElement('div');
  viewport.style.height = '600px';
  const content = document.createElement('div');
  content.dataset.virtualTranscriptSize = 'true';
  content.style.height = '50px';
  const row = document.createElement('div');
  row.dataset.transcriptWindowItem = 'true';
  row.dataset.index = '0';
  row.style.height = '50px';
  content.append(row);
  viewport.append(content);
  const viewportRef = { current: viewport };
  const sizeContainerRef = { current: content };
  let measuredSize = 50;
  const virtualizer = {
    getTotalSize: () => 50,
    getVirtualItems: () => [{ index: 0, size: measuredSize }],
    measureElement: () => {},
  };
  function Harness({ sessionKey, itemCount }: { sessionKey: string; itemCount: number }) {
    const ready = useStableTranscriptSessionReveal({ gap: 4, itemCount, sessionKey, viewportRef, sizeContainerRef, virtualizer });
    return <output>{String(ready)}</output>;
  }
  const render = async (sessionKey: string, itemCount = 1) => {
    await act(async () => root.render(<Harness sessionKey={sessionKey} itemCount={itemCount} />));
  };
  const tick = async (count = 1) => {
    for (let index = 0; index < count; index += 1) {
      await act(async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(index * 16));
      });
    }
  };
  const ready = () => host.textContent === 'true';
  try {
    await render('a');
    assert.equal(ready(), false, 'initial mount must not expose estimated row positions');
    measuredSize = 120;
    await tick(6);
    assert.equal(ready(), false, 'unmeasured rows must remain hidden');
    measuredSize = 50;
    await tick(6);
    assert.equal(ready(), true);
    await render('b');
    assert.equal(ready(), false);
    await tick(1);
    await render('a');
    assert.equal(ready(), false, 'returning before the other session settles is a new entry');
    await tick(6);
    assert.equal(ready(), true);
    await render('a', 0);
    await tick(30);
    await render('a', 1);
    assert.equal(ready(), false, 'empty-to-loaded hydration must measure again');
    await tick(6);
    assert.equal(ready(), true);
    await render('cold', 0);
    await tick(30);
    await render('cold', 1);
    assert.equal(ready(), false);
    await tick(6);
    assert.equal(ready(), true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.requestAnimationFrame = originalRequest;
    window.cancelAnimationFrame = originalCancel;
  }
});
