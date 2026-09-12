import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../src/kordi-app/types';
import { estimateTranscriptMessageHeight } from '../src/features/chat/transcriptHeightEstimate';

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
