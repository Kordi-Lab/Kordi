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

test('every transcript event gets its own timestamp component', () => {
  const start = Date.parse('2026-08-08T10:00:00.000Z');
  const messages = [
    message(start),
    message(start + 60_000, { role: 'system', messageKind: 'session-title-update' }),
    message(start + 2 * 60_000, { role: 'system', messageKind: 'group-member-joined' }),
  ];

  assert.deepEqual(
    transcriptTimeSeparatorLabels(messages, {
      now: start + 10 * 60_000,
      timeZone: 'UTC',
      locales: 'en-US',
    }),
    ['10:00', '10:01', '10:02'],
  );
});

test('a time separator breaks same-sender avatar grouping', () => {
  const messages = [message(1), message(2)];
  const separators = ['10:00', '10:06'];

  assert.equal(isGroupedWithAdjacentHumanMessage(messages, 0, 1, separators), false);
  assert.equal(isGroupedWithAdjacentHumanMessage(messages, 1, -1, separators), false);
  assert.equal(isGroupedWithAdjacentHumanMessage(messages, 0, 1, ['10:00', null]), true);
});

test('cached separators reuse unchanged receipts and reformat only an appended suffix', async () => {
  const { createTranscriptTimeSeparatorCache } = await import('../src/features/chat/transcriptTimestamps');
  const cache = createTranscriptTimeSeparatorCache();
  const start = Date.parse('2026-08-08T10:00:00.000Z');
  const options = { now: start, timeZone: 'UTC', locales: 'en-US' };
  const messages = Array.from({ length: 2000 }, (_, index) => message(start + index * 1000));
  const initial = cache(messages, options);
  const changedReceipt = messages.map(item => ({ ...item, statusChips: ['read'] }));
  assert.strictEqual(cache(changedReceipt, options), initial);
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let dateFormats = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function(...args) {
    dateFormats += 1;
    return original.apply(this, args);
  };
  const appended = [...messages, message(start + 2000 * 1000)];
  let next: Array<string | null>;
  try { next = cache(appended, options); }
  finally { Intl.DateTimeFormat.prototype.formatToParts = original; }
  assert.ok(dateFormats < 8, `Expected suffix-only date formatting, got ${dateFormats}`);
  assert.deepEqual(next, transcriptTimeSeparatorLabels(appended, options));
  assert.equal(initial.length, 2000, 'Previously returned labels stay immutable');
});

test('cached separators handle prepend, deletion, edits, midnight, locale, and timezone changes', async () => {
  const { createTranscriptTimeSeparatorCache } = await import('../src/features/chat/transcriptTimestamps');
  const cache = createTranscriptTimeSeparatorCache();
  const start = Date.parse('2026-08-08T23:59:00.000Z');
  const original = [message(start), message(start + 120_000), message(null)];
  const cases = [
    { messages: original, now: start, timeZone: 'UTC', locales: 'en-US' },
    { messages: [message(start - 3600_000), ...original], now: start, timeZone: 'UTC', locales: 'en-US' },
    { messages: original.slice(1), now: start, timeZone: 'UTC', locales: 'en-US' },
    { messages: [message(start, { role: 'system' }), ...original], now: start + 86400_000, timeZone: 'UTC', locales: 'en-US' },
    { messages: original, now: start + 86400_000, timeZone: 'America/New_York', locales: 'en-GB' },
    { messages: [], now: start, timeZone: 'UTC', locales: 'en-US' },
  ];
  for (const { messages, ...options } of cases) {
    assert.deepEqual(cache(messages, options), transcriptTimeSeparatorLabels(messages, options));
  }
});
