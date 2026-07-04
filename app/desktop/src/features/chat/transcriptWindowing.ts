export const TRANSCRIPT_WINDOW_THRESHOLD = 180;
export const TRANSCRIPT_WINDOW_TAIL_COUNT = 140;
export const TRANSCRIPT_WINDOW_OVERSCAN = 20;
export const TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT = 74;

function safeTranscriptMessageHeight(height: number | null | undefined) {
  const value = typeof height === 'number' ? height : Number.NaN;
  return Number.isFinite(value) && value > 0
    ? value
    : TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT;
}

export function transcriptWindowSpacerHeight(
  messageHeights: readonly (number | null | undefined)[],
  startIndex: number,
  endIndex: number,
) {
  const start = Math.max(0, Math.min(messageHeights.length, startIndex));
  const end = Math.max(start, Math.min(messageHeights.length, endIndex));
  let total = 0;
  for (let index = start; index < end; index += 1) {
    total += safeTranscriptMessageHeight(messageHeights[index]);
  }
  return total;
}

export function transcriptWindowScrollAnchorIndex(
  scrollTop: number,
  messageHeights: readonly (number | null | undefined)[],
) {
  const safeScrollTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  let offset = 0;
  for (let index = 0; index < messageHeights.length; index += 1) {
    offset += safeTranscriptMessageHeight(messageHeights[index]);
    if (safeScrollTop < offset) return index;
  }
  return Math.max(0, messageHeights.length - 1);
}

export type TranscriptWindowRange = {
  start: number;
  end: number;
  windowed: boolean;
};

export function transcriptWindowRange(messageCount: number, anchorIndex = messageCount - 1): TranscriptWindowRange {
  if (messageCount <= TRANSCRIPT_WINDOW_THRESHOLD) {
    return { start: 0, end: messageCount, windowed: false };
  }
  const safeAnchorIndex = Math.max(0, Math.min(messageCount - 1, anchorIndex));
  const start = safeAnchorIndex >= messageCount - TRANSCRIPT_WINDOW_TAIL_COUNT
    ? Math.max(0, messageCount - TRANSCRIPT_WINDOW_TAIL_COUNT)
    : Math.max(0, safeAnchorIndex - TRANSCRIPT_WINDOW_OVERSCAN);
  const end = Math.min(messageCount, start + TRANSCRIPT_WINDOW_TAIL_COUNT);
  return { start, end, windowed: true };
}
