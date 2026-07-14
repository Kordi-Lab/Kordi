import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldFollowTranscriptUpdate } from '../src/app/useKordiUiEffects';

test('an outgoing message forces transcript follow after replying from older history', () => {
  assert.equal(shouldFollowTranscriptUpdate({
    followRequested: true,
    latestMessageIsOwn: true,
    previousDistanceFromBottom: 4_800,
    currentDistanceFromBottom: 4_900,
  }), true);
});

test('an incoming message does not pull a reader away from older history', () => {
  assert.equal(shouldFollowTranscriptUpdate({
    followRequested: true,
    latestMessageIsOwn: false,
    previousDistanceFromBottom: 4_800,
    currentDistanceFromBottom: 4_900,
  }), false);
});

test('normal tail updates continue following while already near the bottom', () => {
  assert.equal(shouldFollowTranscriptUpdate({
    followRequested: true,
    latestMessageIsOwn: false,
    previousDistanceFromBottom: 60,
    currentDistanceFromBottom: 190,
  }), true);
  assert.equal(shouldFollowTranscriptUpdate({
    followRequested: false,
    latestMessageIsOwn: true,
    previousDistanceFromBottom: 0,
    currentDistanceFromBottom: 0,
  }), false);
});
