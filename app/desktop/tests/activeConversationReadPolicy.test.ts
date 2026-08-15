import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canMarkActiveConversationRead,
  documentHasActivePresentation,
  transcriptIsAtLatest,
} from '../src/features/cloud/activeConversationReadPolicy';

test('marks read only when the selected transcript is foregrounded and at latest', () => {
  const baseline = {
    isSelected: true,
    isTranscriptPresented: true,
    isAppForeground: true,
    isAtLatest: true,
  };

  assert.equal(canMarkActiveConversationRead(baseline), true);
  assert.equal(canMarkActiveConversationRead({
    ...baseline,
    isAppForeground: false,
  }), false);
  assert.equal(canMarkActiveConversationRead({
    ...baseline,
    isTranscriptPresented: false,
  }), false);
  assert.equal(canMarkActiveConversationRead({
    ...baseline,
    isAtLatest: false,
  }), false);
});

test('requires both document visibility and focus', () => {
  assert.equal(documentHasActivePresentation({
    visibilityState: 'visible',
    hasFocus: () => true,
  }), true);
  assert.equal(documentHasActivePresentation({
    visibilityState: 'hidden',
    hasFocus: () => true,
  }), false);
  assert.equal(documentHasActivePresentation({
    visibilityState: 'visible',
    hasFocus: () => false,
  }), false);
});

test('uses the transcript bottom threshold as a boolean boundary', () => {
  assert.equal(transcriptIsAtLatest({
    scrollHeight: 1_000,
    scrollTop: 761,
    clientHeight: 100,
  }), true);
  assert.equal(transcriptIsAtLatest({
    scrollHeight: 1_000,
    scrollTop: 760,
    clientHeight: 100,
  }), false);
});
