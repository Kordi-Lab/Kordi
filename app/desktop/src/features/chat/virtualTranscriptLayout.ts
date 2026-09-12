import type { MutableRefObject } from 'react';

export const STABLE_DISCLOSURE_SETTLE_MS = 320;
export const TRANSCRIPT_DISCLOSURE_VIEWPORT_GAP = 12;
export const TRANSCRIPT_DISCLOSURE_MIN_BODY_HEIGHT = 72;
export const preserveMeasuredDisclosurePosition = () => false;

export function preserveMeasuredTranscriptRow(
  item: { start: number; end: number },
  delta: number,
  instance: {
    scrollOffset: number | null;
    scrollRect: { height: number } | null;
  },
  tailAlignmentActiveRef: MutableRefObject<boolean>,
  tailAlignmentTargetRef: MutableRefObject<number | null>,
) {
  const scrollTop = instance.scrollOffset ?? 0;
  // History readers anchor the first visible row, including its pixel offset.
  // Resizing that row or anything below it must not move the viewport. Tail
  // following has a separate policy so late media still lands at the bottom.
  const preserve = tailAlignmentActiveRef.current
    ? item.start < scrollTop + (instance.scrollRect?.height ?? 0)
    : item.end <= scrollTop;
  if (
    preserve
    && tailAlignmentActiveRef.current
    && tailAlignmentTargetRef.current !== null
  ) {
    tailAlignmentTargetRef.current += delta;
  }
  return preserve;
}

/** Transforms can extend scrollHeight; the flow marker records layout extent only. */
export function transcriptLayoutMaxScrollTop(container: HTMLElement) {
  const end = container.querySelector<HTMLElement>('[data-virtual-transcript-end]');
  const paddingBottom = Number.parseFloat(getComputedStyle(container).paddingBottom) || 0;
  const layoutHeight = end?.offsetTop ? end.offsetTop + paddingBottom : container.scrollHeight;
  return Math.max(0, layoutHeight - container.clientHeight);
}
