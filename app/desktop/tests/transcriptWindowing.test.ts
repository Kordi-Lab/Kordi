import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT,
  TRANSCRIPT_WINDOW_TAIL_COUNT,
  TRANSCRIPT_WINDOW_THRESHOLD,
  transcriptWindowRange,
  transcriptWindowScrollAnchorIndex,
} from '../src/features/chat/transcriptWindowing';

test('short transcripts render the full history without window spacers', () => {
  assert.deepEqual(transcriptWindowRange(TRANSCRIPT_WINDOW_THRESHOLD), {
    start: 0,
    end: TRANSCRIPT_WINDOW_THRESHOLD,
    windowed: false,
  });
});

test('long transcripts initially mount only the recent tail window', () => {
  const range = transcriptWindowRange(1000);

  assert.equal(range.windowed, true);
  assert.equal(range.end, 1000);
  assert.equal(range.start, 1000 - TRANSCRIPT_WINDOW_TAIL_COUNT);
  assert.equal(range.end - range.start, TRANSCRIPT_WINDOW_TAIL_COUNT);
});

test('long transcripts mount an overscanned window around the scroll anchor', () => {
  const range = transcriptWindowRange(1000, 300);

  assert.equal(range.windowed, true);
  assert.ok(range.start < 300, 'window should include messages just before the anchor');
  assert.ok(range.end > 300, 'window should include messages after the anchor');
  assert.equal(range.end - range.start, TRANSCRIPT_WINDOW_TAIL_COUNT);
});

test('long transcript windows clamp at the start and end of history', () => {
  assert.deepEqual(transcriptWindowRange(1000, -50), {
    start: 0,
    end: TRANSCRIPT_WINDOW_TAIL_COUNT,
    windowed: true,
  });
  assert.deepEqual(transcriptWindowRange(1000, 2000), {
    start: 1000 - TRANSCRIPT_WINDOW_TAIL_COUNT,
    end: 1000,
    windowed: true,
  });
});

test('scroll anchor resists variable-height transcript content', () => {
  const messageHeights = Array.from({ length: 260 }, () => TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT);
  messageHeights[0] = TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT * 18;

  const scrollTopInsideSecondMessage = messageHeights[0] + Math.floor(TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT / 2);

  assert.equal(
    transcriptWindowScrollAnchorIndex(scrollTopInsideSecondMessage, messageHeights),
    1,
    'a tall first message should not make the scroll anchor skip many transcript items',
  );
});
