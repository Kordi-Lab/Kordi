import assert from 'node:assert/strict';
import test from 'node:test';

import { isImeCompositionKeyDown } from '../src/features/chat/imeComposition';

test('IME guard ignores Enter while browser reports native composition', () => {
  assert.equal(isImeCompositionKeyDown({ nativeEvent: { isComposing: true } }, false), true);
});

test('IME guard ignores Safari-style Enter while local composition state is still active', () => {
  assert.equal(isImeCompositionKeyDown({ key: 'Enter', nativeEvent: { isComposing: false } }, true), true);
});

test('IME guard ignores process key events with keyCode 229', () => {
  assert.equal(isImeCompositionKeyDown({ nativeEvent: { keyCode: 229 } }, false), true);
});

test('IME guard allows normal Enter after composition is clear', () => {
  assert.equal(isImeCompositionKeyDown({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }, false), false);
});
