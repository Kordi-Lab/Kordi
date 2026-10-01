import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TranscriptTimeSeparator } from '../src/features/chat/TranscriptTimeSeparator';
import { installDom } from './helpers/transcriptAttachmentDom';

test('time labels toggle independently and retain their recorded instant across timezone changes', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-09-29T18:05:00Z');
  const today = Date.parse('2026-09-29T18:05:00Z');
  const yesterday = Date.parse('2026-09-28T09:23:00Z');
  const render = (timeZone: string) => root.render(<>
    <TranscriptTimeSeparator timestampMs={today} label={timeZone === 'UTC' ? '18:05' : '11:05'} timeZone={timeZone} />
    <TranscriptTimeSeparator timestampMs={yesterday} label={timeZone === 'UTC' ? 'Yesterday 09:23' : 'Yesterday 02:23'} timeZone={timeZone} />
  </>);
  try {
    await act(async () => render('America/Los_Angeles'));
    const [first, second] = Array.from(host.querySelectorAll('button'));
    assert.equal(first.textContent, '11:05');
    await act(async () => first.click());
    assert.equal(first.textContent, '9/29 Tuesday 11:05');
    assert.equal(first.getAttribute('aria-pressed'), 'true');
    assert.equal(second.textContent, 'Yesterday 02:23');
    await act(async () => second.click());
    assert.equal(second.textContent, '9/28 Monday 02:23');
    await act(async () => render('UTC'));
    assert.equal(first.textContent, '9/29 Tuesday 18:05');
    assert.equal(first.querySelector('time')?.dateTime, '2026-09-29T18:05:00.000Z');
    await act(async () => first.click());
    assert.equal(first.textContent, '18:05');
    assert.equal(first.getAttribute('aria-pressed'), 'false');
  } finally {
    await act(async () => root.unmount());
    Date.now = originalNow;
    installed.restore();
  }
});
