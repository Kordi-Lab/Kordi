import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  focusComposerTextarea,
  focusComposerTextareaForNativeInput,
  resizeComposerTextarea,
} from '../src/features/chat/composerController.shared';

test('native composer focus activates the Tauri window before refocusing the textarea', async () => {
  const events: string[] = [];
  const textarea = {
    focus: () => {
      events.push('textarea-focus');
    },
  };

  focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, true, {
    focusNativeWindow: () => {
      events.push('window-focus');
    },
    requestAnimationFrame: (callback) => {
      callback(0);
      return 1;
    },
    querySelector: (selector) => (selector === CHAT_COMPOSER_TEXTAREA_SELECTOR ? textarea : null),
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(events, ['window-focus', 'textarea-focus']);
});

test('focusComposerTextarea restores focus to the chat composer after selector changes', async () => {
  let focused = false;
  const textarea = {
    focus: () => {
      focused = true;
    },
  };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;

  try {
    globalThis.window = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    } as Window & typeof globalThis;
    globalThis.document = {
      querySelector: (selector: string) => (selector === CHAT_COMPOSER_TEXTAREA_SELECTOR ? textarea : null),
    } as unknown as Document;

    focusComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);

    assert.equal(focused, true);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test('clearing the composer resets its autosized height after a long message', () => {
  let focused = false;
  const textarea = {
    value: 'long message',
    style: { height: '220px' },
    get scrollHeight() {
      return this.value ? 220 : 24;
    },
    focus: () => {
      focused = true;
    },
    setSelectionRange: () => undefined,
  };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;

  try {
    globalThis.window = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    } as Window & typeof globalThis;
    globalThis.document = {
      querySelector: (selector: string) => (selector === CHAT_COMPOSER_TEXTAREA_SELECTOR ? textarea : null),
    } as unknown as Document;

    resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);

    assert.equal(textarea.value, '');
    assert.equal(textarea.style.height, '24px');
    assert.equal(focused, false);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
