import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearTranscriptRowSizeMemoryForTests,
  rememberedTranscriptRowSize,
  rememberTranscriptRowSize,
  settledTranscriptRowSize,
  transcriptRowSizeClock,
} from '../src/features/chat/transcriptRowSizeMemory';

test('remembered row heights outlive a transcript mount and are settled only before the next entry', async () => {
  clearTranscriptRowSizeMemoryForTests();
  rememberTranscriptRowSize('chat:a', 84);
  rememberTranscriptRowSize('chat:a', 116);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const entry = transcriptRowSizeClock();
  assert.equal(rememberedTranscriptRowSize('chat:a'), 116);
  assert.equal(settledTranscriptRowSize('chat:a', entry), 116);
  // Measuring the same height again during the entry keeps it settled.
  rememberTranscriptRowSize('chat:a', 116);
  assert.equal(settledTranscriptRowSize('chat:a', entry), 116);
  // A height first seen during this entry is not a remembered layout.
  rememberTranscriptRowSize('chat:a', 130);
  assert.equal(settledTranscriptRowSize('chat:a', entry), undefined);
  assert.equal(rememberedTranscriptRowSize('chat:missing'), undefined);
  rememberTranscriptRowSize('chat:zero', 0);
  assert.equal(rememberedTranscriptRowSize('chat:zero'), undefined);
});

test('row height memory stays bounded', () => {
  clearTranscriptRowSizeMemoryForTests();
  for (let index = 0; index < 4_100; index += 1) rememberTranscriptRowSize(`chat:${index}`, 40);
  assert.equal(rememberedTranscriptRowSize('chat:0'), undefined);
  assert.equal(rememberedTranscriptRowSize('chat:4099'), 40);
});
