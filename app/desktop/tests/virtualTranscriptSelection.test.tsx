import assert from 'node:assert/strict';
import test from 'node:test';

import { act } from 'react';
import {
  cleanupVirtualTranscriptHarness,
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

test('transcript owns Cmd+A and Escape for semantic message selection', async () => {
  let selectAllCount = 0;
  let cancelCount = 0;
  const view = await render(transcript({
    items: rows('selection-', 0, 3),
    sessionKey: 'selection-shortcuts',
    selectionMode: true,
    onSelectAllMessages: () => { selectAllCount += 1; },
    onCancelMessageSelection: () => { cancelCount += 1; },
  }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);
  assert.equal(viewport.tabIndex, 0);
  assert.equal(viewport.getAttribute('role'), 'region');
  assert.equal(viewport.dataset.messageSelectionMode, 'true');

  await act(async () => {
    const selectAll = new window.KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    viewport.dispatchEvent(selectAll);
    assert.equal(selectAll.defaultPrevented, true);
  });
  await act(async () => {
    const escape = new window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    viewport.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
  });

  assert.equal(selectAllCount, 1);
  assert.equal(cancelCount, 1);
});
