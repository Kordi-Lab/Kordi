import assert from 'node:assert/strict';
import { test } from 'node:test';

import { transcriptTimeSeparatorLabels } from '../src/features/chat/transcriptTimestamps';
import { isGroupedWithAdjacentHumanMessage } from '../src/pages/chatsPage.transcriptViewport';
import type { Message } from '../src/kordi-app/types';

function message(timestampMs: number | null, overrides: Partial<Message> = {}): Message {
  return {
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'hello',
    time: timestampMs === null ? 'Unknown' : '20:23',
    timestampMs,
    ...overrides,
  };
}

test('transcript separators follow the thirty-minute last-label rule', () => {
  const start = Date.parse('2026-08-08T10:00:00.000Z');
  const messages = [
    message(start),
    message(start + 29 * 60_000 + 59_000),
    message(start + 30 * 60_000),
    message(start + 30 * 60_000 + 1),
  ];

  assert.deepEqual(
    transcriptTimeSeparatorLabels(messages, {
      now: start + 60 * 60_000,
      timeZone: 'UTC',
      locales: 'en-US',
    }),
    ['10:00', null, '10:30', null],
  );
});

test('transcript separators appear across a calendar change inside thirty minutes', () => {
  const messages = [
    message(Date.parse('2026-08-07T23:59:00.000Z')),
    message(Date.parse('2026-08-08T00:01:00.000Z')),
  ];

  assert.deepEqual(
    transcriptTimeSeparatorLabels(messages, {
      now: Date.parse('2026-08-08T12:00:00.000Z'),
      timeZone: 'UTC',
      locales: 'en-US',
    }),
    ['Yesterday 23:59', '00:01'],
  );
});

test('messages without exact timestamps do not create guessed separators', () => {
  const start = Date.parse('2026-08-08T10:00:00.000Z');
  const messages = [message(null), message(start)];

  assert.deepEqual(
    transcriptTimeSeparatorLabels(messages, {
      now: start,
      timeZone: 'UTC',
      locales: 'en-US',
    }),
    [null, '10:00'],
  );
});

test('a time separator breaks same-sender avatar grouping', () => {
  const messages = [message(1), message(2)];
  const separators = ['10:00', '10:06'];

  assert.equal(isGroupedWithAdjacentHumanMessage(messages, 0, 1, separators), false);
  assert.equal(isGroupedWithAdjacentHumanMessage(messages, 1, -1, separators), false);
  assert.equal(isGroupedWithAdjacentHumanMessage(messages, 0, 1, ['10:00', null]), true);
});
