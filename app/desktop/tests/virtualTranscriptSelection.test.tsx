import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('transcript only exposes its focus ring after keyboard input', async () => {
  const view = await render(transcript({
    items: rows('focus-', 0, 3),
    sessionKey: 'focus-origin',
  }));
  const viewport = view.host.querySelector<HTMLElement>('[data-virtual-transcript-scroll]');
  assert.ok(viewport);

  await act(async () => viewport.focus());
  assert.equal(viewport.dataset.transcriptKeyboardFocus, undefined);

  await act(async () => {
    viewport.dispatchEvent(new window.KeyboardEvent('keyup', {
      key: 'Tab',
      bubbles: true,
    }));
  });
  assert.equal(viewport.dataset.transcriptKeyboardFocus, 'true');

  await act(async () => {
    viewport.dispatchEvent(new window.MouseEvent('pointerdown', {
      button: 0,
      bubbles: true,
      cancelable: true,
    }));
  });
  assert.equal(document.activeElement, viewport);
  assert.equal(viewport.dataset.transcriptKeyboardFocus, undefined);

  await act(async () => {
    viewport.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
    }));
  });
  assert.equal(viewport.dataset.transcriptKeyboardFocus, 'true');

  await act(async () => {
    viewport.dispatchEvent(new window.MouseEvent('pointerdown', {
      button: 0,
      bubbles: true,
      cancelable: true,
    }));
  });
  assert.equal(viewport.dataset.transcriptKeyboardFocus, undefined);

  await act(async () => viewport.blur());
  await act(async () => viewport.focus());
  assert.equal(viewport.dataset.transcriptKeyboardFocus, undefined);

  await act(async () => {
    viewport.dispatchEvent(new window.KeyboardEvent('keyup', {
      key: 'Tab',
      bubbles: true,
    }));
  });
  assert.equal(viewport.dataset.transcriptKeyboardFocus, 'true');

  await act(async () => viewport.blur());
  assert.equal(viewport.dataset.transcriptKeyboardFocus, undefined);
});

test('transcript replaces the blue viewport outline with a quiet keyboard focus inset', () => {
  const css = readFileSync(new URL('../src/styles/shell-transcript.css', import.meta.url), 'utf8');

  assert.match(css, /\[data-virtual-transcript-scroll\]\s*\{[^}]*outline:\s*none;/s);
  assert.match(
    css,
    /\[data-virtual-transcript-scroll\]\[data-transcript-keyboard-focus='true'\]:focus\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px color-mix\(in oklab, var\(--utility-muted-text\) 24%, transparent\);/s,
  );
  assert.match(css, /@media \(forced-colors:\s*active\)/);
});
