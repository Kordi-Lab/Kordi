import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { createTranscriptTimeSeparatorCache } from '../src/features/chat/transcriptTimestamps';
import { useTranscriptTimeZone } from '../src/features/chat/useTranscriptTimeZone';
import type { Message } from '../src/kordi-app/types';

test('transcript clock context refreshes while open and when the app resumes', async () => {
  const originalTimeZone = process.env.TZ;
  const originalNow = Date.now;
  let now = Date.parse('2026-08-08T23:59:00.000Z');
  Date.now = () => now;
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  let visible = true;
  Object.defineProperty(dom.window.document, 'hidden', { get: () => !visible, configurable: true });
  let tick: (() => void) | undefined;
  let clearedInterval = false;
  const originalSetInterval = dom.window.setInterval.bind(dom.window);
  dom.window.setInterval = ((callback: TimerHandler) => {
    tick = callback as () => void;
    return 1;
  }) as typeof dom.window.setInterval;
  dom.window.clearInterval = (() => { clearedInterval = true; }) as typeof dom.window.clearInterval;
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const rendered: string[] = [];
  const days: string[] = [];
  const timestampMs = Date.parse('2026-08-08T01:03:00.000Z');
  const messages = [{ role: 'person', text: 'hello', time: '01:03', timestampMs }] as Message[];
  function Clock() {
    const { timeZone, day } = useTranscriptTimeZone();
    const cache = useMemo(createTranscriptTimeSeparatorCache, []);
    const labels = useMemo(() => cache(messages, { timeZone, now: timestampMs, locales: 'en-US' }), [cache, timeZone]);
    rendered.push(`${timeZone}:${labels[0]}`);
    days.push(day);
    return <span>{labels[0]}</span>;
  }
  try {
    process.env.TZ = 'UTC';
    await act(async () => root.render(<Clock />));
    assert.equal(rendered.at(-1), 'UTC:01:03');
    assert.equal(days.at(-1), '2026-08-08');

    process.env.TZ = 'America/Los_Angeles';
    await act(async () => tick?.());
    assert.equal(rendered.at(-1), 'America/Los_Angeles:18:03');
    assert.equal(host.textContent, '18:03');
    const renderCount = rendered.length;
    await act(async () => tick?.());
    assert.equal(rendered.length, renderCount, 'unchanged context should not rerender');

    visible = false;
    process.env.TZ = 'America/New_York';
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')));
    assert.equal(rendered.at(-1), 'America/Los_Angeles:18:03');
    visible = true;
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')));
    assert.equal(rendered.at(-1), 'America/New_York:21:03');

    process.env.TZ = 'UTC';
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(rendered.at(-1), 'UTC:01:03');
    process.env.TZ = 'America/Los_Angeles';
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('pageshow')));
    assert.equal(rendered.at(-1), 'America/Los_Angeles:18:03');

    process.env.TZ = 'UTC';
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    now = Date.parse('2026-08-09T00:01:00.000Z');
    await act(async () => tick?.());
    assert.equal(days.at(-1), '2026-08-09', 'midnight changes relative date context');
  } finally {
    await act(async () => root.unmount());
    assert.equal(clearedInterval, true);
    dom.window.setInterval = originalSetInterval;
    Date.now = originalNow;
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
    for (const [key, descriptor] of [
      ['window', previousWindow], ['document', previousDocument], ['IS_REACT_ACT_ENVIRONMENT', previousAct],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
