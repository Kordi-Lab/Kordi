import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, createRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  BlobEmojiComposerInput,
  type BlobEmojiComposerInputHandle,
} from '../src/features/emoji/BlobEmojiComposerInput';
import {
  BLOB_EMOJI_CARET_ANCHOR_ATTRIBUTE,
  BLOB_EMOJI_CARET_MARKER,
  blobEmojiComposerValue,
} from '../src/features/emoji/blobEmojiComposerDom';

test('rich composer content serializes Blob Emoji images back to stable tokens', () => {
  const dom = new JSDOM('<div id="composer">Hi <span data-blob-emoji-token=":blob:blobwave:"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></span> there</div>');
  const previousNode = globalThis.Node;
  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  try {
    const composer = dom.window.document.querySelector('#composer') as HTMLDivElement;
    assert.equal(blobEmojiComposerValue(composer), 'Hi :blob:blobwave: there');
  } finally {
    globalThis.Node = previousNode;
    globalThis.HTMLElement = previousHTMLElement;
  }
});

test('typing or pasting a known token rehydrates it as an inline image', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://desktop.kordi.test',
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  const host = document.querySelector('#host') as HTMLDivElement;
  const root = createRoot(host);
  const inputRef = createRef<BlobEmojiComposerInputHandle>();

  function Harness() {
    const [value, setValue] = useState('');
    return (
      <BlobEmojiComposerInput
        ref={inputRef}
        value={value}
        placeholder="Message"
        onChange={setValue}
      />
    );
  }

  try {
    await act(async () => root.render(<Harness />));
    const editor = host.querySelector('[contenteditable="true"]') as HTMLDivElement;
    await act(async () => {
      editor.textContent = 'Hi :blob:blobwave:';
      editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });

    assert.equal(editor.querySelector('[data-blob-emoji-token]')?.getAttribute('data-blob-emoji-token'), ':blob:blobwave:');
    assert.equal(blobEmojiComposerValue(editor), 'Hi :blob:blobwave:');

    const twoEmoji = ':blob:blobwave::blob:blobwave:';
    await act(async () => {
      editor.textContent = twoEmoji;
      editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    inputRef.current?.focus({ start: twoEmoji.length, end: twoEmoji.length });
    assert.deepEqual(inputRef.current?.selection(), {
      start: twoEmoji.length,
      end: twoEmoji.length,
    });
    const caretAnchor = editor.querySelector(`[${BLOB_EMOJI_CARET_ANCHOR_ATTRIBUTE}]`);
    assert.equal(caretAnchor?.textContent, BLOB_EMOJI_CARET_MARKER);
    assert.equal(window.getSelection()?.anchorNode, caretAnchor?.firstChild);
    assert.equal(window.getSelection()?.anchorOffset, BLOB_EMOJI_CARET_MARKER.length);
    assert.equal(blobEmojiComposerValue(editor), twoEmoji);

    await act(async () => {
      editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
      }));
    });
    assert.equal(blobEmojiComposerValue(editor), ':blob:blobwave:');
  } finally {
    await act(async () => root.unmount());
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  }
});
