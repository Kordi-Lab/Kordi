import assert from 'node:assert/strict';
import test from 'node:test';

import { createImeCompositionState, isImeCompositionKeyDown } from '../src/features/chat/imeComposition';

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

test('IME composition state clears only after the scheduled composition-end delay', () => {
  let nextTimerId = 1;
  const scheduledCallbacks = new Map<number, () => void>();
  const state = createImeCompositionState({
    schedule: (callback) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      scheduledCallbacks.set(timerId, callback);
      return timerId;
    },
    cancel: (timerId) => {
      scheduledCallbacks.delete(timerId);
    },
  });

  assert.equal(state.isComposing(), false);

  state.beginComposition();
  assert.equal(state.isComposing(), true);

  state.endComposition();
  assert.equal(state.isComposing(), true);
  assert.equal(scheduledCallbacks.size, 1);

  const scheduledEntry = scheduledCallbacks.entries().next().value;
  assert.ok(scheduledEntry);
  const [timerId, callback] = scheduledEntry;
  scheduledCallbacks.delete(timerId);
  callback();

  assert.equal(state.isComposing(), false);
  assert.equal(scheduledCallbacks.size, 0);
});

test('IME composition state cancels a pending clear when composition restarts', () => {
  let nextTimerId = 1;
  const scheduledCallbacks = new Map<number, () => void>();
  const cancelledTimerIds: number[] = [];
  const state = createImeCompositionState({
    schedule: (callback) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      scheduledCallbacks.set(timerId, callback);
      return timerId;
    },
    cancel: (timerId) => {
      cancelledTimerIds.push(timerId);
      scheduledCallbacks.delete(timerId);
    },
  });

  state.beginComposition();
  state.endComposition();
  assert.equal(scheduledCallbacks.size, 1);

  state.beginComposition();

  assert.deepEqual(cancelledTimerIds, [1]);
  assert.equal(scheduledCallbacks.size, 0);
  assert.equal(state.isComposing(), true);
});
