import type { MutableRefObject } from 'react';

export const STABLE_DISCLOSURE_SETTLE_MS = 320;
export const TRANSCRIPT_DISCLOSURE_VIEWPORT_GAP = 12;
export const TRANSCRIPT_DISCLOSURE_MIN_BODY_HEIGHT = 72;
export const preserveMeasuredDisclosurePosition = () => false;

export function preserveMeasuredTranscriptRow(
  item: { start: number },
  delta: number,
  instance: {
    scrollOffset: number | null;
    scrollRect: { height: number } | null;
  },
  tailAlignmentActiveRef: MutableRefObject<boolean>,
  tailAlignmentTargetRef: MutableRefObject<number | null>,
) {
  const preserve = item.start < (instance.scrollOffset ?? 0)
    + (instance.scrollRect?.height ?? 0);
  if (
    preserve
    && tailAlignmentActiveRef.current
    && tailAlignmentTargetRef.current !== null
  ) {
    tailAlignmentTargetRef.current += delta;
  }
  return preserve;
}
