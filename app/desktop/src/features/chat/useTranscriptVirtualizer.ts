import type { Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import type { createTranscriptContentMeasure } from './transcriptContentMeasure';
import { createTranscriptScrollOrigin, releaseTranscriptScrollTarget } from './transcriptScrollOrigin';
import { rememberTranscriptRowSize, settledTranscriptRowSize, transcriptRowSizeClock } from './transcriptRowSizeMemory';
import { TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT, TRANSCRIPT_WINDOW_OVERSCAN } from './transcriptWindowing';
import type { VirtualTranscriptProps } from './virtualTranscriptTypes';

type Options<Item> = Pick<VirtualTranscriptProps<Item>,
  'items' | 'sessionKey' | 'getItemKey' | 'estimateSize' | 'scrollClassName' | 'scrollStyle' | 'animateTailResize'> & {
  gap: number;
  preserving: boolean;
  stableDisclosureActive: boolean;
  isAtTail: boolean;
  internalScrollRef: RefObject<HTMLDivElement | null>;
  sizeContainerRef: RefObject<HTMLDivElement | null>;
  measureElement: ReturnType<typeof createTranscriptContentMeasure>;
};

/** Coordinate row measurement, viewport padding, and gesture-safe anchoring. */
export function useTranscriptVirtualizerOptions<Item>({
  items, sessionKey, getItemKey, estimateSize, scrollClassName, scrollStyle,
  animateTailResize, gap, preserving, stableDisclosureActive, isAtTail,
  internalScrollRef, sizeContainerRef, measureElement,
}: Options<Item>) {
  const [scrollMargin, setScrollMargin] = useState(0);
  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    const viewport = internalScrollRef.current;
    const container = sizeContainerRef.current;
    if (!viewport || !container) return;
    // Row positions are relative to the list, but scrollTop includes the pane's
    // leading padding. Use one coordinate system for range and anchor decisions.
    const update = () => setScrollMargin(container.offsetTop);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [hasItems, internalScrollRef, scrollClassName, scrollStyle, sizeContainerRef]);

  // Heights remembered from earlier visits seed this entry's estimates. Heights measured
  // during this entry are already in the virtualizer's own cache and keep its anchoring rules.
  const [entry, setEntry] = useState(() => ({ sessionKey, startedAt: transcriptRowSizeClock() }));
  let entryStartedAt = entry.startedAt;
  if (entry.sessionKey !== sessionKey) {
    // The virtualizer computes row positions in this pass and does not recompute them
    // when only estimateSize changes, so this pass must already seed remembered heights.
    entryStartedAt = transcriptRowSizeClock();
    setEntry({ sessionKey, startedAt: entryStartedAt });
  }

  const itemKeyAt = useCallback((index: number) => {
    const item = items[index];
    const itemKey = item === undefined ? `missing:${index}` : getItemKey(item, index);
    return `${sessionKey.length}:${sessionKey}:${typeof itemKey}:${String(itemKey)}`;
  }, [getItemKey, items, sessionKey]);

  const { origin: scrollOrigin } = useMemo(() => ({ sessionKey, origin: createTranscriptScrollOrigin() }), [sessionKey]);
  useLayoutEffect(() => () => scrollOrigin.dispose(), [scrollOrigin]);
  const options = {
    measureElement,
    count: items.length,
    getScrollElement: () => internalScrollRef.current,
    estimateSize: (index: number) => {
      const item = items[index];
      // A row measured on an earlier visit starts at that height, so reopening a chat
      // lays out its tail correctly in the first frame instead of converging over several.
      const remembered = item === undefined ? undefined : settledTranscriptRowSize(itemKeyAt(index), entryStartedAt);
      if (remembered !== undefined) return remembered;
      return item === undefined
        ? TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT
        : estimateSize?.(item, index) ?? TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT;
    },
    getItemKey: itemKeyAt,
    overscan: TRANSCRIPT_WINDOW_OVERSCAN,
    gap,
    scrollMargin,
    paddingStart: scrollOrigin.paddingStart,
    anchorTo: preserving || stableDisclosureActive || (animateTailResize && isAtTail) ? 'start' as const : 'end' as const,
    useFlushSync: false,
    directDomUpdates: true,
    // Keep row layout in the scroll layer instead of promoting every message
    // to a separate 3D layer with its own viewport-edge clipping during scroll.
    directDomUpdatesMode: 'position' as const,
  };
  return { options, scrollOrigin };
}

export function useMeasureTranscriptRows(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  sizeContainerRef: RefObject<HTMLDivElement | null>,
  viewportWasAtTailRef: RefObject<boolean>,
  tailAlignmentActiveRef: RefObject<boolean>,
) {
  useLayoutEffect(() => {
    const container = sizeContainerRef.current;
    // Session entry and tail following already measure in their alignment
    // transaction. Preserve that transaction's initial range and scroll target.
    if (!container || viewportWasAtTailRef.current || tailAlignmentActiveRef.current) return;
    // User scrolling skips the virtualizer's synchronous ref measurement. A
    // newly mounted image or quote can otherwise paint at an estimated position
    // and overlap its neighbor until ResizeObserver delivers the actual size.
    // Read the bounded mounted window together, then commit geometry before paint.
    const rows = [...container.querySelectorAll<HTMLDivElement>('[data-transcript-window-item]')];
    const heights = rows.map(row => {
      virtualizer.options.measureElement(row, undefined, virtualizer);
      return row.offsetHeight;
    });
    rows.forEach((row, index) => {
      virtualizer.resizeItem(Number(row.dataset.index), heights[index]);
      if (row.dataset.transcriptRowKey) rememberTranscriptRowSize(row.dataset.transcriptRowKey, heights[index]);
    });
  });
}

/**
 * Scroll to the tail row. The virtualizer learns the new offset from the next scroll
 * event, a frame later. On entry, deliver it now so the tail rows mount in this layout
 * pass and a remembered layout can show in the first paint.
 */
// Virtualizers still reconciling a scrollToIndex request for the latest row.
const pendingTailScrolls = new WeakSet<Virtualizer<HTMLDivElement, HTMLElement>>();

export function scrollTranscriptToTail(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  viewport: HTMLDivElement | null,
  tailIndex: number,
  entering: boolean,
) {
  pendingTailScrolls.add(virtualizer);
  virtualizer.scrollToIndex(tailIndex, { align: 'end' });
  if (entering) viewport?.dispatchEvent(new Event('scroll'));
}

/** Navigate to a row; any pending tail target is superseded by this one. */
export function scrollTranscriptToIndex(virtualizer: Virtualizer<HTMLDivElement, HTMLElement>, index: number) {
  pendingTailScrolls.delete(virtualizer);
  virtualizer.scrollToIndex(index, { align: 'center' });
}

/**
 * The reader left the tail by keyboard, scrollbar or script (the wheel path
 * releases it itself). Drop a pending tail target so a later row measurement
 * that moves it cannot pull the reader back to the latest message.
 */
export function releasePendingTranscriptTailScroll(virtualizer: Virtualizer<HTMLDivElement, HTMLElement>) {
  if (pendingTailScrolls.delete(virtualizer)) releaseTranscriptScrollTarget(virtualizer);
}
