export const TRANSCRIPT_WINDOW_THRESHOLD = 180;
export const TRANSCRIPT_WINDOW_TAIL_COUNT = 140;
export const TRANSCRIPT_WINDOW_OVERSCAN = 20;
export const TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT = 74;

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
