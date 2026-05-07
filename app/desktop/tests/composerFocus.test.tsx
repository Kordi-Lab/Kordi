import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  focusComposerTextarea,
} from '../src/features/chat/composerController.shared';

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
