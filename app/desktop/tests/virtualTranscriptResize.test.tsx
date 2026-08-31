import assert from 'node:assert/strict';
import test from 'node:test';

import { act } from 'react';
import {
  cleanupVirtualTranscriptHarness,
  flush,
  installVirtualTranscriptHarness,
  render,
  rows,
  transcript,
  triggerObservedResize,
  virtualRowStart,
} from './support/virtualTranscriptHarness';

test.before(async () => {
  await installVirtualTranscriptHarness();
});

test.afterEach(async () => {
  await cleanupVirtualTranscriptHarness();
});

test('a visible reaction resize moves earlier content while keeping later messages fixed', async () => {
  const view = await render(transcript({
    items: rows('reaction-', 0, 30, 50),
    sessionKey: 'reaction-resize',
  }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);
  await act(async () => viewport.scrollTo({ top: 300 }));
  await flush();

  const reactedMessage = view.host.querySelector<HTMLElement>('[data-message-id="reaction-8"]');
  const reactedRow = reactedMessage?.closest<HTMLElement>('[data-transcript-window-item]');
  const laterRow = view.host.querySelector<HTMLElement>('[data-message-id="reaction-9"]')
    ?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(reactedMessage);
  assert.ok(reactedRow);
  assert.ok(laterRow);
  const reactedBottom = virtualRowStart(reactedRow) - viewport.scrollTop + reactedRow.offsetHeight;
  const laterTop = virtualRowStart(laterRow) - viewport.scrollTop;

  await act(async () => {
    reactedMessage.dataset.testRowHeight = '80';
    assert.ok((triggerObservedResize?.(reactedRow) ?? 0) > 0);
  });

  assert.equal(
    virtualRowStart(reactedRow) - viewport.scrollTop + reactedRow.offsetHeight,
    reactedBottom,
  );
  assert.equal(virtualRowStart(laterRow) - viewport.scrollTop, laterTop);
});

test('late media growth keeps a newly opened transcript pinned to its final message', async () => {
  const view = await render(transcript({
    items: rows('media-', 0, 20, 50),
    sessionKey: 'late-media-tail',
  }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  const finalMessage = view.host.querySelector<HTMLElement>('[data-message-id="media-19"]');
  const finalRow = finalMessage?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(viewport);
  assert.ok(finalMessage);
  assert.ok(finalRow);

  await act(async () => {
    finalMessage.dataset.testRowHeight = '320';
    assert.ok((triggerObservedResize?.(finalRow) ?? 0) > 0);
  });
  await flush();

  assert.ok(
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1,
    'late media measurement should preserve the visible transcript tail',
  );
});
