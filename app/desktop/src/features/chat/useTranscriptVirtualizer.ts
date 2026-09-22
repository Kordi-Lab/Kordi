import type { Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import type { createTranscriptContentMeasure } from './transcriptContentMeasure';
import { createTranscriptScrollOrigin } from './transcriptScrollOrigin';
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
    });
  });
}
