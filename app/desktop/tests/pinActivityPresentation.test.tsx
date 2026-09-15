import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installVirtualTranscriptHarness } from './support/virtualTranscriptHarness';

test('pin notices use compact chat times and animate only once without changing geometry', async () => {
  await installVirtualTranscriptHarness();
  const { PinActivityNotice } = await import('../src/pages/chatsPage.pins');
  const calls: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  HTMLElement.prototype.animate = function (frames, options) {
    calls.push({ frames: frames as Keyframe[], options: options as KeyframeAnimationOptions });
    return { cancel() {} } as Animation;
  };
  const style = document.createElement('style');
  style.textContent = '[data-pin-activity] { --app-motion-base: .22s; --app-motion-ease: cubic-bezier(0.22, 1, 0.36, 1); }';
  document.head.append(style);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const today = new Date(); today.setHours(13, 5, 0, 0);
  const activity = { id: 'new-pin', label: 'You pinned a message', timestampMs: today.getTime(), animate: true };
  try {
    await act(async () => root.render(<PinActivityNotice activity={activity} />));
    const row = host.querySelector('[data-pin-activity]');
    assert.equal(row?.querySelector('time')?.textContent, '13:05');
    assert.deepEqual(calls[0].frames, [{ opacity: 0, transform: 'translateY(25%)' }, { opacity: 1, transform: 'translateY(0)' }]);
    assert.equal(calls[0].options.duration, 220);
    assert.equal(calls[0].options.delay ?? 0, 0);
    assert.equal(calls[0].options.easing?.replace(/\s/g, ''), 'cubic-bezier(0.22,1,0.36,1)');
    await act(async () => root.render(<PinActivityNotice activity={{ ...activity, timestampMs: activity.timestampMs + 1000 }} />));
    assert.equal(host.querySelector('[data-pin-activity]'), row);
    assert.equal(calls.length, 1);
    await act(async () => root.render(null));
    await act(async () => root.render(<PinActivityNotice activity={activity} />));
    assert.equal(calls.length, 1, 'Returning to a virtualized row must not replay the animation');
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    await act(async () => root.render(<PinActivityNotice activity={{ ...activity, id: 'history', timestampMs: yesterday.getTime(), animate: false }} />));
    assert.equal(host.querySelector('time')?.textContent, 'Yesterday 13:05');
    assert.equal(calls.length, 1, 'Existing history renders without a delayed entrance');
    window.matchMedia = (() => ({ matches: true })) as typeof window.matchMedia;
    await act(async () => root.render(<PinActivityNotice activity={{ ...activity, id: 'reduced' }} />));
    assert.deepEqual(calls[1].frames, [{ opacity: 0.7 }, { opacity: 1 }]);
    assert.equal(calls[1].options.duration, 100);
  } finally { await act(async () => root.unmount()); host.remove(); style.remove(); }
});
