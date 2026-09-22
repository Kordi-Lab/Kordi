import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../src/kordi-app/types';
import { estimateTranscriptMessageHeight, transcriptContentColumns } from '../src/features/chat/transcriptHeightEstimate';

function message(overrides: Partial<Message> = {}): Message {
  return { role: 'person', text: '', time: '10:00', ...overrides };
}

test('known media dimensions reserve useful geometry before the first row measurement', () => {
  const photo = message({ attachments: [{ kind: 'image', name: 'photo.png', widthPixels: 1280, heightPixels: 720 }] });
  const sticker = message({ attachments: [{ kind: 'image', subtype: 'sticker', name: 'sticker.png', widthPixels: 512, heightPixels: 512 }] });
  assert.equal(estimateTranscriptMessageHeight(photo), 297);
  assert.equal(estimateTranscriptMessageHeight(sticker), 216);
  assert.equal(estimateTranscriptMessageHeight(photo, true), 329);
});

test('long text, wide glyphs, and explicit line breaks no longer share a one-row estimate', () => {
  const short = estimateTranscriptMessageHeight(message({ text: 'A short message' }));
  assert.ok(estimateTranscriptMessageHeight(message({ text: 'word '.repeat(200) })) > short);
  assert.ok(estimateTranscriptMessageHeight(message({ text: '\u4e2d'.repeat(128) }))
    > estimateTranscriptMessageHeight(message({ text: 'a'.repeat(128) })));
  assert.ok(estimateTranscriptMessageHeight(message({ text: 'line\n'.repeat(10) })) > short);
  assert.ok(estimateTranscriptMessageHeight(message({ text: 'x'.repeat(1_000_000) })) < 1_500);
});

test('unknown media and collapsed collages stay conservative without reserving every full image', () => {
  const attachment = { kind: 'image' as const, name: 'image.png' };
  assert.equal(estimateTranscriptMessageHeight(message({ attachments: [attachment] })), 276);
  assert.ok(estimateTranscriptMessageHeight(message({ attachments: Array.from({ length: 30 }, () => attachment) })) < 500);
  assert.ok(estimateTranscriptMessageHeight(message({ attachments: [{ kind: 'file', name: 'clip.mp4' }] })) > 250);
});

test('a one-line message reserves a compact row instead of a generic floor', () => {
  // The rendered one-line bubble is roughly 44px tall. Over-reserving here is
  // what made the transcript apply a large scroll correction while scrolling.
  assert.ok(estimateTranscriptMessageHeight(message({ text: 'Thanks!' })) <= 50);
});

test('the same text wraps into more lines in a narrow pane', () => {
  const text = 'word '.repeat(60);
  const narrow = estimateTranscriptMessageHeight(message({ text }), false, { contentColumns: 40 });
  const wide = estimateTranscriptMessageHeight(message({ text }), false, { contentColumns: 120 });
  assert.ok(narrow > wide, 'a narrow pane must reserve more height for the same text');
});

test('Agent messages reserve their sender header above person messages', () => {
  const text = 'Sounds good, I will take a look.';
  assert.ok(
    estimateTranscriptMessageHeight(message({ role: 'owned-agent', sender: 'Agent', text }))
      > estimateTranscriptMessageHeight(message({ role: 'person', sender: 'Person', text })),
  );
});

test('markdown list items reserve their spacing', () => {
  assert.ok(
    estimateTranscriptMessageHeight(message({ text: '1. one\n2. two\n3. three' }))
      > estimateTranscriptMessageHeight(message({ text: 'one\ntwo\nthree' })),
  );
});

test('the inline sender line is reserved only for the first message of a run', () => {
  const peer = message({ role: 'person', sender: 'Person', showSenderMeta: true, text: 'hi' });
  const first = estimateTranscriptMessageHeight(peer);
  const grouped = estimateTranscriptMessageHeight(peer, false, { isGroupedWithPrevious: true });
  assert.ok(first > grouped, 'the first message of a grouped run shows the sender line');
});

test('viewport width maps to a bounded body-text column count', () => {
  assert.equal(transcriptContentColumns(0), 96);
  assert.equal(transcriptContentColumns(800), 96);
  assert.equal(transcriptContentColumns(100), 40);
  assert.equal(transcriptContentColumns(100_000), 140);
});
