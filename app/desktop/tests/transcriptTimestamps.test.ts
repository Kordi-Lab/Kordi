import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTranscriptTimeSeparatorCache, transcriptTimeSeparatorLabels } from '../src/features/chat/transcriptTimestamps';
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

test('Threads labels only local calendar-day boundaries, never same-day inactivity gaps', () => {
  const messages = [
    message(Date.parse('2026-10-02T09:00:00Z')),
    message(Date.parse('2026-10-02T18:00:00Z')),
    message(Date.parse('2026-10-03T00:01:00Z')),
    message(Date.parse('2026-10-03T00:02:00Z'), { role: 'system' }),
  ];
  const options = { dateOnly: true, locales: 'en-US', timeZone: 'UTC' };
  assert.deepEqual(transcriptTimeSeparatorLabels(messages, options), ['October 2, 2026', null, 'October 3, 2026', null]);
  assert.deepEqual(transcriptTimeSeparatorLabels(messages, { ...options, timeZone: 'America/Los_Angeles' }), ['October 2, 2026', null, null, null]);
});

test('daily cache keeps mode switches, missing timestamps, and prepended history accurate', () => {
  const first = Date.parse('2026-10-02T23:59:00Z');
  const messages = [message(null), message(first), message(first + 120_000)];
  const options = { now: first, timeZone: 'UTC', locales: 'en-US' };
  const cache = createTranscriptTimeSeparatorCache();
  assert.deepEqual(cache(messages, options), [null, '23:59', 'Oct 3 00:01']);
  assert.deepEqual(cache(messages, { ...options, dateOnly: true }), [null, 'October 2, 2026', 'October 3, 2026']);
  const prepended = [message(first - 3_600_000), ...messages];
  assert.deepEqual(cache(prepended, { ...options, dateOnly: true }), ['October 2, 2026', null, null, 'October 3, 2026']);
  assert.deepEqual(cache(messages, options), transcriptTimeSeparatorLabels(messages, options));
});

test('transcript separators follow gaps between adjacent messages', () => {
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
    ['10:00', null, null, null],
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

test('nearby transcript events share the surrounding time boundary', () => {
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
    ['10:00', null, null],
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

test('same transcript instants are relabeled after travel without reordering messages', async () => {
  const { createTranscriptTimeSeparatorCache } = await import('../src/features/chat/transcriptTimestamps');
  const cache = createTranscriptTimeSeparatorCache();
  const first = Date.parse('2026-08-08T01:03:00.000Z');
  const second = Date.parse('2026-08-08T01:49:00.000Z');
  const messages = [message(first), message(second)];
  const originalInstants = messages.map(item => item.timestampMs);
  const options = { now: second, locales: 'en-US' };

  assert.deepEqual(cache(messages, { ...options, timeZone: 'UTC' }), ['01:03', '01:49']);
  assert.deepEqual(cache(messages, { ...options, timeZone: 'America/Los_Angeles' }), ['18:03', '18:49']);
  assert.deepEqual(messages.map(item => item.timestampMs), originalInstants);
  assert.strictEqual(messages[0].timestampMs! < messages[1].timestampMs!, true);
});


test('prepending history changes only the old boundary label, not later labels', () => {
  const start = Date.UTC(2026, 0, 1);
  const original = [20, 40, 60, 120].map((minute) => message(start + minute * 60_000));
  const options = { now: start, timeZone: 'UTC', locales: 'en-US' };
  const before = transcriptTimeSeparatorLabels(original, options);
  const after = transcriptTimeSeparatorLabels([message(start), ...original], options);
  assert.equal(before[0], '00:20');
  assert.equal(after[1], null);
  assert.deepEqual(after.slice(2), before.slice(1));
  assert.equal(after.at(-1), '02:00', 'real inactivity gaps still get labels');
});
