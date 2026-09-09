import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

type TranscriptVirtualizer = {
  getTotalSize: () => number;
  getVirtualItems: () => Array<{ index: number; size: number; start?: number }>;
  measureElement: (node: HTMLDivElement | null) => void;
  resizeItem?: (index: number, size: number) => void;
};

const rowLiftAnimations = new WeakMap<HTMLElement, Animation>();

export function hasActiveTranscriptRowLift(rows: readonly HTMLElement[]) {
  return rows.some(row => rowLiftAnimations.has(row));
}

export function cancelTranscriptRowLift(rows: readonly HTMLElement[]) {
  for (const row of rows) {
    rowLiftAnimations.get(row)?.cancel();
    rowLiftAnimations.delete(row);
  }
}

function rowLiftOffset(row: HTMLElement) {
  if (!rowLiftAnimations.has(row)) return 0;
  return Number.parseFloat(getComputedStyle(row).translate.split(/\s+/)[1] ?? '0') || 0;
}

function transcriptViewportTop(sizeContainer: HTMLDivElement | null) {
  return sizeContainer?.closest<HTMLElement>('[data-virtual-transcript-scroll]')?.getBoundingClientRect().top ?? 0;
}

export function captureTranscriptRowLayoutTops(sizeContainer: HTMLDivElement | null) {
  // A composer resize can move the whole pane without moving rows within it.
  const viewportTop = transcriptViewportTop(sizeContainer);
  return new Map([...(sizeContainer?.querySelectorAll<HTMLElement>('[data-transcript-window-item="true"]') ?? [])]
    .map(row => [row, row.getBoundingClientRect().top - viewportTop - rowLiftOffset(row)]));
}

export function alignAndRevealMeasuredTranscriptRows({
  alignToTail, reduceMotion, revealFromIndex, sizeContainer, virtualizer, previousRowTops,
}: {
  alignToTail: () => void;
  gap: number;
  reduceMotion: boolean;
  revealFromIndex?: number;
  sizeContainer: HTMLDivElement | null;
  virtualizer: TranscriptVirtualizer;
  previousRowTops?: ReadonlyMap<HTMLElement, number>;
}) {
  if (!sizeContainer) {
    alignToTail();
    return [];
  }
  const rows = [...sizeContainer.querySelectorAll<HTMLDivElement>('[data-transcript-window-item="true"]')];
  const previousRows = revealFromIndex === undefined ? [] : rows.filter(row => Number(row.dataset.index) < revealFromIndex);
  const viewportTop = transcriptViewportTop(sizeContainer);
  const presentationTops = previousRows.map(row => {
    const previousTop = previousRowTops?.get(row);
    return previousTop === undefined ? undefined : previousTop + viewportTop + rowLiftOffset(row);
  });
  // A new neighbor can change the previous bubble's grouping height too.
  // Commit measured geometry before the first paint, rather than aligning to
  // estimates and correcting the container and row positions on the next frame.
  const heights = rows.map(row => row.offsetHeight);
  rows.forEach((row, index) => {
    virtualizer.measureElement(row);
    // measureElement intentionally returns cached dimensions for existing rows.
    // Grouping changes need an explicit same-frame size update.
    virtualizer.resizeItem?.(Number(row.dataset.index), heights[index]);
  });
  sizeContainer.style.height = `${virtualizer.getTotalSize()}px`;
  const measuredRows = new Map(virtualizer.getVirtualItems().map(item => [item.index, item]));
  for (const row of rows) {
    const item = measuredRows.get(Number(row.dataset.index));
    if (item?.start !== undefined) row.style.transform = `translate3d(0px, ${item.start}px, 0px)`;
  }
  alignToTail();
  if (reduceMotion) {
    cancelTranscriptRowLift(rows);
    return [];
  }
  const layoutTops = previousRows.map(row => row.getBoundingClientRect().top - rowLiftOffset(row));
  const animatedRows: HTMLElement[] = [];
  const animateRow = (row: HTMLElement, distance: number) => {
    rowLiftAnimations.get(row)?.cancel();
    rowLiftAnimations.delete(row);
    // Short histories have no displacement. Never invent a lift from the new
    // message's height, and preserve the presentation position during bursts.
    if (Math.abs(distance) <= 1 || typeof row.animate !== 'function') return;
    const animation = row.animate([
      { translate: `0 ${distance}px` },
      { translate: '0 0' },
    ], { duration: 150, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    rowLiftAnimations.set(row, animation);
    animatedRows.push(row);
    animation.onfinish = () => {
      if (rowLiftAnimations.get(row) === animation) rowLiftAnimations.delete(row);
    };
  };
  previousRows.forEach((row, index) => {
    const previousTop = presentationTops[index];
    if (previousTop !== undefined) animateRow(row, previousTop - layoutTops[index]);
  });
  const lastPresentationTop = presentationTops[presentationTops.length - 1];
  const enteringDistance = lastPresentationTop === undefined ? 0 : lastPresentationTop - layoutTops[layoutTops.length - 1];
  if (enteringDistance > 1 && revealFromIndex !== undefined) {
    // New and existing rows share one displacement curve, so they never overlap
    // while making room for a send. Bubble styling supplies opacity only here.
    for (const row of rows) {
      if (Number(row.dataset.index) >= revealFromIndex) animateRow(row, enteringDistance);
    }
  }
  return animatedRows;
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
