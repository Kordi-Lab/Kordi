import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT,
  TRANSCRIPT_WINDOW_OVERSCAN,
  transcriptWindowMessageIdentity,
  transcriptWindowMessageMatchesId,
} from '../src/features/chat/transcriptWindowing';
import type { Message } from '../src/kordi-app/types';

function message(overrides: Partial<Message> = {}): Message {
  return {
    role: 'user',
    text: 'hello',
    time: '10:00',
    ...overrides,
  };
}

test('measured transcript virtualization uses a bounded overscan and conservative estimate', () => {
  assert.equal(TRANSCRIPT_WINDOW_OVERSCAN, 12);
  assert.equal(TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT, 74);
});

test('transcript message identity prefers stable persisted and runtime ids', () => {
  assert.equal(transcriptWindowMessageIdentity(message({ id: 'message:1', entryId: 'entry:1' }), 4), 'message:1');
  assert.equal(
    transcriptWindowMessageIdentity(message({
      id: 'message:1',
      clientMessageId: 'client:1',
    }), 4),
    'client:1',
  );
  assert.equal(transcriptWindowMessageIdentity(message({ entryId: 'entry:1' }), 4), 'entry:1');
  assert.equal(transcriptWindowMessageIdentity(message({ turn: { id: 'turn:1' } as Message['turn'] }), 4), 'turn:1');
  assert.equal(transcriptWindowMessageIdentity(message({ sender: 'Me' }), 4), '4:user:Me:10:00');
});

test('jump matching covers message, entry, runtime, and fallback ids', () => {
  const target = message({
    id: 'message:1',
    entryId: 'entry:1',
    replyAliasIds: ['reply:1'],
    turn: { id: 'turn:1', transcriptEntryId: 'turn-entry:1' } as Message['turn'],
  });
  assert.equal(transcriptWindowMessageMatchesId(target, 'message:1', 4), true);
  assert.equal(transcriptWindowMessageMatchesId(target, 'entry:1', 4), true);
  assert.equal(transcriptWindowMessageMatchesId(target, 'turn:1', 4), true);
  assert.equal(transcriptWindowMessageMatchesId(target, 'turn-entry:1', 4), true);
  assert.equal(transcriptWindowMessageMatchesId(target, 'reply:1', 4), true);
  assert.equal(transcriptWindowMessageMatchesId(message(), 'transcript-message:4', 4), true);
});

test('legacy manual spacer and scroll-anchor math is removed', () => {
  const source = readFileSync(new URL('../src/features/chat/transcriptWindowing.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /transcriptWindowRange|transcriptWindowSpacerHeight|transcriptWindowScrollAnchorIndex/);
});
