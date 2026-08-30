import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

type TranscriptVirtualizer = {
  getTotalSize: () => number;
  getVirtualItems: () => Array<{ index: number; size: number }>;
  measureElement: (node: HTMLDivElement | null) => void;
};

export function cancelTranscriptRowLift(rows: readonly HTMLElement[]) {
  for (const row of rows) {
    row.style.animation = 'none';
    row.style.removeProperty('--app-transcript-row-lift');
  }
}

export function alignAndRevealMeasuredTranscriptRows({
  alignToTail,
  gap,
  reduceMotion,
  revealFromIndex,
  sizeContainer,
  virtualizer,
}: {
  alignToTail: () => void;
  gap: number;
  reduceMotion: boolean;
  revealFromIndex?: number;
  sizeContainer: HTMLDivElement | null;
  virtualizer: TranscriptVirtualizer;
}) {
  if (!sizeContainer || revealFromIndex === undefined) {
    alignToTail();
    return [];
  }
  const rows = [
    ...sizeContainer.querySelectorAll<HTMLDivElement>('[data-transcript-window-item="true"]'),
  ];
  const appendedRows = rows.filter((row) => Number(row.dataset.index) >= revealFromIndex);
  for (const row of appendedRows) virtualizer.measureElement(row);
  alignToTail();
  if (reduceMotion) return [];

  const liftDistance = appendedRows.reduce(
    (height, row) => height + row.offsetHeight + gap,
    0,
  );
  if (liftDistance <= 1) return [];

  const previousRows = rows.filter((row) => Number(row.dataset.index) < revealFromIndex);
  for (const row of previousRows) {
    row.style.setProperty('--app-transcript-row-lift', `${liftDistance}px`);
    row.style.animation = 'none';
  }
  void sizeContainer.offsetWidth;
  for (const row of previousRows) {
    row.style.animation = 'app-transcript-existing-row-lift 150ms cubic-bezier(0.23, 1, 0.32, 1)';
  }
  return previousRows;
}

export function useStableTranscriptSessionReveal({
  gap,
  itemCount,
  sessionKey,
  sizeContainerRef,
  viewportRef,
  virtualizer,
}: {
  gap: number;
  itemCount: number;
  sessionKey: string;
  sizeContainerRef: RefObject<HTMLDivElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  virtualizer: TranscriptVirtualizer;
}) {
  const [revealedSessionKey, setRevealedSessionKey] = useState(sessionKey);
  const frameRef = useRef<number | null>(null);
  const sessionRevealed = revealedSessionKey === sessionKey;

  useLayoutEffect(() => {
    if (sessionRevealed || itemCount === 0) return;
    // ponytail: fail open after 20 frames; use a virtualizer readiness event if one becomes available.
    let framesRemaining = 20;
    let stableFrames = 0;
    let previousSignature = '';
    const revealWhenMeasured = () => {
      frameRef.current = null;
      const viewport = viewportRef.current;
      const sizeContainer = sizeContainerRef.current;
      const measuredItems = virtualizer.getVirtualItems();
      const rowsByIndex = new Map(
        [...(sizeContainer?.querySelectorAll<HTMLDivElement>('[data-transcript-window-item="true"]') ?? [])]
          .map((row) => [Number(row.dataset.index), row]),
      );
      const allMountedRowsMeasured = measuredItems.length > 0 && measuredItems.every((item) => {
        const row = rowsByIndex.get(item.index);
        return Boolean(row && Math.abs(row.offsetHeight - item.size) <= 1);
      });
      const distanceFromBottom = viewport
        ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
        : Number.POSITIVE_INFINITY;
      const signature = viewport
        ? `${viewport.scrollHeight}:${viewport.scrollTop}:${virtualizer.getTotalSize()}`
        : '';
      if (
        allMountedRowsMeasured
        && rowsByIndex.has(itemCount - 1)
        && distanceFromBottom <= Math.max(1, gap)
        && signature === previousSignature
      ) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
      previousSignature = signature;
      if (stableFrames >= 5 || --framesRemaining <= 0) {
        setRevealedSessionKey(sessionKey);
      } else {
        frameRef.current = window.requestAnimationFrame(revealWhenMeasured);
      }
    };
    frameRef.current = window.requestAnimationFrame(revealWhenMeasured);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [gap, itemCount, sessionKey, sessionRevealed, sizeContainerRef, viewportRef, virtualizer]);

  return sessionRevealed;
}
