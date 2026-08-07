import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  handleDocumentCopySurfaceKeyDown,
  isEditableSelectionTarget,
  isSelectAllShortcut,
  syncCopySurfaceSelection,
} from '../src/features/contentSelection';

function rect(top: number, bottom: number, left = 0, right = 300): DOMRect {
  return {
    x: left,
    y: top,
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

test('document Cmd+A selects only the focused document surface', () => {
  const dom = new JSDOM('<div id="surface">Agent <strong>document</strong></div><div>Interface chrome</div>');
  const surface = dom.window.document.querySelector<HTMLElement>('#surface');
  assert.ok(surface);
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  let prevented = false;
  let stopped = false;

  try {
    handleDocumentCopySurfaceKeyDown({
      key: 'a',
      metaKey: true,
      ctrlKey: false,
      target: surface,
      currentTarget: surface,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    });

    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(dom.window.getSelection()?.toString(), 'Agent document');
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
    });
  }
});

test('selection helpers preserve editor shortcuts and recognize both platform modifiers', () => {
  const dom = new JSDOM('<textarea></textarea><div></div>');
  const textarea = dom.window.document.querySelector('textarea');
  const div = dom.window.document.querySelector('div');
  assert.ok(textarea);
  assert.ok(div);
  const previousElement = globalThis.Element;
  globalThis.Element = dom.window.Element;

  try {
    assert.equal(isEditableSelectionTarget(textarea), true);
    assert.equal(isEditableSelectionTarget(div), false);
    assert.equal(isSelectAllShortcut({ key: 'A', metaKey: true, ctrlKey: false }), true);
    assert.equal(isSelectAllShortcut({ key: 'a', metaKey: false, ctrlKey: true }), true);
    assert.equal(isSelectAllShortcut({ key: 'a', metaKey: false, ctrlKey: false }), false);
  } finally {
    globalThis.Element = previousElement;
  }
});

test('multi-line markdown selection becomes one bounded surface instead of stacked fragments', () => {
  const dom = new JSDOM(`
    <div data-kordi-copy-surface="message" id="surface">
      <p data-kordi-copy-block="true" id="before">Earlier text</p>
      <h2 data-kordi-copy-block="true" id="first">Selected heading</h2>
      <ol data-kordi-copy-block="true" id="middle"><li>First</li><li>Second</li></ol>
      <p data-kordi-copy-block="true" id="last">Selected ending</p>
    </div>
  `);
  const document = dom.window.document;
  const surface = document.querySelector<HTMLElement>('#surface');
  const first = document.querySelector<HTMLElement>('#first');
  const middle = document.querySelector<HTMLElement>('#middle');
  const last = document.querySelector<HTMLElement>('#last');
  assert.ok(surface);
  assert.ok(first);
  assert.ok(middle);
  assert.ok(last);
  surface.getBoundingClientRect = () => rect(0, 120);
  first.getBoundingClientRect = () => rect(20, 40);
  middle.getBoundingClientRect = () => rect(44, 76);
  last.getBoundingClientRect = () => rect(80, 100);

  const range = document.createRange();
  range.setStart(first.firstChild!, 0);
  range.setEnd(last.firstChild!, last.textContent!.length);
  Object.defineProperty(range, 'getClientRects', {
    value: () => [rect(20, 40), rect(48, 66), rect(80, 100)],
  });
  const selection = document.getSelection();
  assert.ok(selection);
  selection.removeAllRanges();
  selection.addRange(range);

  syncCopySurfaceSelection(document, selection);

  assert.equal(surface.dataset.kordiCopySelection, 'unified');
  assert.equal(surface.style.getPropertyValue('--app-copy-selection-top'), '20px');
  assert.equal(surface.style.getPropertyValue('--app-copy-selection-height'), '80px');

  selection.collapse(first.firstChild, 1);
  syncCopySurfaceSelection(document, selection);
  assert.equal(surface.hasAttribute('data-kordi-copy-selection'), false);
});
