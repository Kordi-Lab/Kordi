import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  handleDocumentCopySurfaceKeyDown,
  installCopySurfaceSelectionTracking,
  isEditableSelectionTarget,
  isSelectAllShortcut,
} from '../src/features/contentSelection';

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

test('primary click outside copy surfaces clears native text selection', () => {
  const dom = new JSDOM(`
    <div data-kordi-copy-surface="message" id="surface">Keep me selected</div>
    <button id="outside">Outside</button>
    <textarea id="editor"></textarea>
  `);
  const surface = dom.window.document.querySelector<HTMLElement>('#surface');
  const outside = dom.window.document.querySelector<HTMLButtonElement>('#outside');
  const editor = dom.window.document.querySelector<HTMLTextAreaElement>('#editor');
  assert.ok(surface);
  assert.ok(outside);
  assert.ok(editor);
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousElement = globalThis.Element;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
  });
  const selection = dom.window.getSelection();
  assert.ok(selection);
  const selectSurface = () => {
    const range = dom.window.document.createRange();
    range.selectNodeContents(surface);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const stopTracking = installCopySurfaceSelectionTracking(dom.window.document);

  try {
    selectSurface();
    outside.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    assert.equal(selection.rangeCount, 0);

    selectSurface();
    surface.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    assert.equal(selection.toString(), 'Keep me selected');

    outside.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 2 }));
    assert.equal(selection.toString(), 'Keep me selected');

    editor.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    assert.equal(selection.toString(), 'Keep me selected');
  } finally {
    stopTracking();
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      Element: previousElement,
    });
    dom.window.close();
  }
});
