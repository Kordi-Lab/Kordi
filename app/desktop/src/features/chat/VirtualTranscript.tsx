import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { ScrollArea } from '@/components/ui/scroll-area';
import {
  TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT,
  TRANSCRIPT_WINDOW_OVERSCAN,
} from '@/features/chat/transcriptWindowing';
import {
  beginChatPerformanceSpan,
  completeSessionClickToFirstMessage,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';

export type VirtualTranscriptNavigationRequest = {
  id: string;
  nonce: number;
  sessionKey: string;
};

export type VirtualTranscriptProps<Item> = {
  items: readonly Item[];
  sessionKey: string;
  getItemKey: (item: Item, index: number) => string | number;
  renderItem: (item: Item, index: number) => ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
  scrollClassName?: string;
  scrollStyle?: CSSProperties;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  navigationRequest?: VirtualTranscriptNavigationRequest | null;
  findNavigationIndex?: (item: Item, messageId: string, index: number) => boolean;
  onNavigationReady?: (messageId: string) => void;
  onNavigationHandled?: (request: VirtualTranscriptNavigationRequest) => void;
  hasOlder?: boolean;
  onLoadOlder?: () => Promise<void> | void;
  emptyState?: ReactNode;
  tail?: ReactNode;
  tailKey?: string | number;
  estimateSize?: (item: Item, index: number) => number;
  gap?: number;
};

const preserveMeasuredDisclosurePosition = () => false;
const STABLE_DISCLOSURE_SETTLE_MS = 320;

export function VirtualTranscript<Item>({
  items,
  sessionKey,
  getItemKey,
  renderItem,
  scrollRef,
  scrollClassName,
  scrollStyle,
  onScroll,
  navigationRequest,
  findNavigationIndex,
  onNavigationReady,
  onNavigationHandled,
  hasOlder = false,
  onLoadOlder,
  emptyState,
  tail,
  tailKey,
  estimateSize,
  gap = 4,
}: VirtualTranscriptProps<Item>) {
  const renderPerformanceSpan = beginChatPerformanceSpan('transcript-virtual-render');
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [stableDisclosureActive, setStableDisclosureActive] = useState(false);
  const loadAttemptSignatureRef = useRef<string | null>(null);
  const olderLoadPromiseRef = useRef<Promise<void> | null>(null);
  const olderLoadGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const alignedSessionRef = useRef<{
    sessionKey: string;
    itemCount: number;
    lastItemKey: string;
    tailKey: string;
    totalSize: number;
    viewportSize: number;
  } | null>(null);
  const viewportWasAtTailRef = useRef(true);
  const tailAlignmentActiveRef = useRef(false);
  const tailAlignmentFrameRef = useRef<number | null>(null);
  const tailAlignmentTargetRef = useRef<number | null>(null);
  const stableDisclosureAnchorRef = useRef<{
    sessionKey: string;
    scrollTop: number;
  } | null>(null);
  const stableDisclosureReleaseFrameRef = useRef<number | null>(null);
  const handledNavigationRequestRef = useRef<string | null>(null);

  const setScrollElement = useCallback((node: HTMLDivElement | null) => {
    internalScrollRef.current = node;
    if (scrollRef) scrollRef.current = node;
  }, [scrollRef]);

  const itemKeyAt = useCallback((index: number) => {
    const item = items[index];
    const itemKey = item === undefined ? `missing:${index}` : getItemKey(item, index);
    return `${sessionKey.length}:${sessionKey}:${typeof itemKey}:${String(itemKey)}`;
  }, [getItemKey, items, sessionKey]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => internalScrollRef.current,
    estimateSize: (index) => {
      const item = items[index];
      return item === undefined
        ? TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT
        : estimateSize?.(item, index) ?? TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT;
    },
    getItemKey: itemKeyAt,
    overscan: TRANSCRIPT_WINDOW_OVERSCAN,
    gap,
    anchorTo: stableDisclosureActive ? 'start' : 'end',
    useFlushSync: false,
    directDomUpdates: true,
    directDomUpdatesMode: 'transform',
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = stableDisclosureActive
    ? preserveMeasuredDisclosurePosition
    : undefined;

  const scopedNavigationRequest = navigationRequest?.sessionKey === sessionKey
    ? navigationRequest
    : null;
  const pagingEnabled = hasOlder && Boolean(onLoadOlder);
  const olderLoadScopeRef = useRef({ sessionKey, pagingEnabled });
  const committedOlderLoadScopeRef = useRef({ sessionKey, pagingEnabled });
  olderLoadScopeRef.current = { sessionKey, pagingEnabled };

  const navigationTargetIndex = useMemo(() => {
    const id = scopedNavigationRequest?.id.trim() ?? '';
    if (!id) return -1;
    return items.findIndex((item, index) => (
      findNavigationIndex?.(item, id, index) ?? String(getItemKey(item, index)) === id
    ));
  }, [findNavigationIndex, getItemKey, items, scopedNavigationRequest?.id]);

  const oldestItemKey = items.length > 0 ? String(getItemKey(items[0]!, 0)) : 'empty';
  const newestItemKey = items.length > 0 ? String(getItemKey(items[items.length - 1]!, items.length - 1)) : 'empty';
  const normalizedTailKey = String(tailKey ?? '');
  const totalSize = virtualizer.getTotalSize();
  const viewportSize = virtualizer.scrollRect?.height ?? 0;
  const setSizeContainer = useCallback((node: HTMLDivElement | null) => {
    virtualizer.containerRef(node);
    // Commit the new extent before layout effects restore a prepend anchor;
    // otherwise the browser can clamp that anchor against the previous size.
    if (node) node.style.height = `${totalSize}px`;
  }, [totalSize, virtualizer]);

  const cancelTailAlignment = useCallback(() => {
    tailAlignmentActiveRef.current = false;
    tailAlignmentTargetRef.current = null;
    if (tailAlignmentFrameRef.current !== null) {
      window.cancelAnimationFrame(tailAlignmentFrameRef.current);
      tailAlignmentFrameRef.current = null;
    }
  }, []);

  const cancelStableDisclosureRelease = useCallback(() => {
    if (stableDisclosureReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(stableDisclosureReleaseFrameRef.current);
      stableDisclosureReleaseFrameRef.current = null;
    }
  }, []);

  const scheduleStableDisclosureRelease = useCallback((anchor: {
    sessionKey: string;
    scrollTop: number;
  }) => {
    cancelStableDisclosureRelease();
    const releaseAfter = Date.now() + STABLE_DISCLOSURE_SETTLE_MS;
    const release = () => {
      stableDisclosureReleaseFrameRef.current = null;
      if (Date.now() < releaseAfter) {
        stableDisclosureReleaseFrameRef.current = window.requestAnimationFrame(release);
      } else if (stableDisclosureAnchorRef.current === anchor) {
        stableDisclosureAnchorRef.current = null;
        setStableDisclosureActive(false);
      }
    };
    stableDisclosureReleaseFrameRef.current = window.requestAnimationFrame(release);
  }, [cancelStableDisclosureRelease]);

  const alignViewportToTail = useCallback(() => {
    const element = internalScrollRef.current;
    if (!element) return;
    const target = Math.max(0, element.scrollHeight - element.clientHeight);
    tailAlignmentTargetRef.current = target;
    element.scrollTop = target;
    viewportWasAtTailRef.current = true;
  }, []);

  const scheduleTailAlignment = useCallback(() => {
    if (tailAlignmentFrameRef.current !== null) {
      window.cancelAnimationFrame(tailAlignmentFrameRef.current);
    }
    tailAlignmentActiveRef.current = true;
    alignViewportToTail();
    let framesRemaining = 4;
    const settle = () => {
      tailAlignmentFrameRef.current = null;
      if (!tailAlignmentActiveRef.current) return;
      alignViewportToTail();
      framesRemaining -= 1;
      if (framesRemaining > 0) {
        tailAlignmentFrameRef.current = window.requestAnimationFrame(settle);
      }
    };
    tailAlignmentFrameRef.current = window.requestAnimationFrame(settle);
  }, [alignViewportToTail]);

  useEffect(() => {
    // React Strict Mode intentionally runs an extra setup/cleanup cycle in
    // development. Re-arm the ref during setup so a history request that
    // completes after that cycle can still clear its loading state.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelTailAlignment();
      cancelStableDisclosureRelease();
      stableDisclosureAnchorRef.current = null;
    };
  }, [cancelStableDisclosureRelease, cancelTailAlignment]);

  useLayoutEffect(() => {
    const previousScope = committedOlderLoadScopeRef.current;
    if (previousScope.sessionKey === sessionKey && previousScope.pagingEnabled === pagingEnabled) return;
    committedOlderLoadScopeRef.current = { sessionKey, pagingEnabled };
    // A request can begin against a canonical catalog shell just before the
    // native runtime transcript arrives. Detach that request when its session
    // changes or paging becomes unavailable so its sticky loading label cannot
    // follow the user into another chat.
    olderLoadGenerationRef.current += 1;
    loadAttemptSignatureRef.current = null;
    olderLoadPromiseRef.current = null;
    setIsLoadingOlder(false);
  }, [pagingEnabled, sessionKey]);

  const requestOlder = useCallback((signature?: string) => {
    const currentScope = olderLoadScopeRef.current;
    if (
      !pagingEnabled
      || !onLoadOlder
      || !currentScope.pagingEnabled
      || currentScope.sessionKey !== sessionKey
    ) return null;
    if (signature && loadAttemptSignatureRef.current === signature) return olderLoadPromiseRef.current;
    if (olderLoadPromiseRef.current) return olderLoadPromiseRef.current;
    if (signature) loadAttemptSignatureRef.current = signature;
    setIsLoadingOlder(true);
    const generation = olderLoadGenerationRef.current;
    let succeeded = false;
    let loadResult: Promise<void> | void;
    try {
      loadResult = onLoadOlder();
    } catch (error) {
      loadResult = Promise.reject(error);
    }
    const request = Promise.resolve(loadResult)
      .then(() => { succeeded = true; })
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        if (olderLoadGenerationRef.current !== generation || olderLoadPromiseRef.current !== request) return;
        olderLoadPromiseRef.current = null;
        if (!succeeded && loadAttemptSignatureRef.current === signature) loadAttemptSignatureRef.current = null;
        if (mountedRef.current) setIsLoadingOlder(false);
      });
    olderLoadPromiseRef.current = request;
    return request;
  }, [onLoadOlder, pagingEnabled, sessionKey]);

  useEffect(() => {
    const request = scopedNavigationRequest;
    if (!request || navigationTargetIndex >= 0 || !hasOlder || !onLoadOlder) return;
    const signature = `${request.sessionKey}:${request.nonce}:${request.id}:${items.length}:${oldestItemKey}`;
    void requestOlder(signature);
  }, [hasOlder, items.length, navigationTargetIndex, oldestItemKey, onLoadOlder, requestOlder, scopedNavigationRequest]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const distanceFromTail = element.scrollHeight - (element.scrollTop + element.clientHeight);
    const isAtTail = distanceFromTail <= Math.max(4, gap);
    const matchesAlignmentTarget = tailAlignmentActiveRef.current
      && tailAlignmentTargetRef.current !== null
      && Math.abs(element.scrollTop - tailAlignmentTargetRef.current) <= 1;
    if (isAtTail) {
      viewportWasAtTailRef.current = true;
    } else if (!matchesAlignmentTarget) {
      viewportWasAtTailRef.current = false;
      cancelTailAlignment();
    }
    onScroll?.(event);
    if (element.scrollTop > Math.max(160, element.clientHeight * 0.25)) return;
    void requestOlder(`scroll:${sessionKey}:${items.length}:${oldestItemKey}`);
  }, [cancelTailAlignment, gap, items.length, oldestItemKey, onScroll, requestOlder, sessionKey]);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[data-transcript-stable-disclosure="true"]')) return;
    const element = internalScrollRef.current;
    if (!element) return;
    cancelTailAlignment();
    cancelStableDisclosureRelease();
    setStableDisclosureActive(true);
    const anchor = {
      sessionKey,
      scrollTop: element.scrollTop,
    };
    stableDisclosureAnchorRef.current = anchor;
    scheduleStableDisclosureRelease(anchor);
  }, [cancelStableDisclosureRelease, cancelTailAlignment, scheduleStableDisclosureRelease, sessionKey]);

  useLayoutEffect(() => {
    const anchor = stableDisclosureAnchorRef.current;
    if (!anchor || anchor.sessionKey === sessionKey) return;
    cancelStableDisclosureRelease();
    stableDisclosureAnchorRef.current = null;
    setStableDisclosureActive(false);
  }, [cancelStableDisclosureRelease, sessionKey]);

  useLayoutEffect(() => {
    const aligned = alignedSessionRef.current;
    const stableDisclosureAnchor = stableDisclosureAnchorRef.current?.sessionKey === sessionKey
      ? stableDisclosureAnchorRef.current
      : null;
    const firstPageReplacedLoadingCopy = Boolean(
      aligned
      && aligned.sessionKey === sessionKey
      && aligned.itemCount <= 1
      && items.length > aligned.itemCount,
    );
    const catalogPreviewHydrated = Boolean(
      aligned
      && aligned.sessionKey === sessionKey
      && items.length > aligned.itemCount
      && newestItemKey === aligned.lastItemKey
      && viewportWasAtTailRef.current,
    );
    const latestItemAppended = Boolean(
      aligned
      && aligned.sessionKey === sessionKey
      && items.length > aligned.itemCount
      && newestItemKey !== aligned.lastItemKey
      && (viewportWasAtTailRef.current || tailAlignmentActiveRef.current),
    );
    const tailContentChanged = Boolean(
      aligned
      && aligned.sessionKey === sessionKey
      && normalizedTailKey !== aligned.tailKey
      && (viewportWasAtTailRef.current || tailAlignmentActiveRef.current),
    );
    const measuredSizeChanged = Boolean(
      aligned
      && aligned.sessionKey === sessionKey
      && totalSize !== aligned.totalSize
      && (viewportWasAtTailRef.current || tailAlignmentActiveRef.current),
    );
    const stableDisclosureSizeChanged = Boolean(
      stableDisclosureAnchor
      && aligned
      && aligned.sessionKey === sessionKey
      && totalSize !== aligned.totalSize,
    );
    const viewportSizeChanged = Boolean(
      aligned
      && aligned.sessionKey === sessionKey
      && viewportSize !== aligned.viewportSize
      && (viewportWasAtTailRef.current || tailAlignmentActiveRef.current),
    );
    const shouldAlign = aligned?.sessionKey !== sessionKey
      || firstPageReplacedLoadingCopy
      || catalogPreviewHydrated
      || latestItemAppended
      || tailContentChanged
      || measuredSizeChanged
      || viewportSizeChanged;
    alignedSessionRef.current = {
      sessionKey,
      itemCount: items.length,
      lastItemKey: newestItemKey,
      tailKey: normalizedTailKey,
      totalSize,
      viewportSize,
    };
    if (stableDisclosureSizeChanged && stableDisclosureAnchor) {
      cancelTailAlignment();
      const element = internalScrollRef.current;
      if (element) {
        element.scrollTop = stableDisclosureAnchor.scrollTop;
        const distanceFromTail = element.scrollHeight - (element.scrollTop + element.clientHeight);
        viewportWasAtTailRef.current = distanceFromTail <= Math.max(4, gap);
      }
      scheduleStableDisclosureRelease(stableDisclosureAnchor);
    } else if (shouldAlign) {
      viewportWasAtTailRef.current = true;
      tailAlignmentActiveRef.current = true;
      if (items.length > 0) {
        virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
      }
      scheduleTailAlignment();
    }
  }, [cancelTailAlignment, gap, items.length, newestItemKey, normalizedTailKey, scheduleStableDisclosureRelease, scheduleTailAlignment, sessionKey, totalSize, viewportSize, virtualizer]);

  useLayoutEffect(() => {
    const request = scopedNavigationRequest;
    if (!request || navigationTargetIndex < 0) return undefined;
    const requestIdentity = JSON.stringify([request.sessionKey, request.nonce, request.id.trim()]);
    if (handledNavigationRequestRef.current === requestIdentity) return undefined;
    cancelTailAlignment();
    virtualizer.scrollToIndex(navigationTargetIndex, { align: 'center' });
    const frameId = window.requestAnimationFrame(() => {
      handledNavigationRequestRef.current = requestIdentity;
      onNavigationReady?.(request.id);
      onNavigationHandled?.(request);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [cancelTailAlignment, navigationTargetIndex, onNavigationHandled, onNavigationReady, scopedNavigationRequest, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    finishChatPerformanceSpan(renderPerformanceSpan, {
      messageCount: items.length,
      visibleRowCount: virtualItems.length,
    });
    if (items.length > 0 && virtualItems.length > 0) {
      completeSessionClickToFirstMessage(sessionKey, {
        messageCount: items.length,
        visibleRowCount: virtualItems.length,
      });
    }
  }, [items.length, renderPerformanceSpan, sessionKey, virtualItems.length]);

  return (
    <ScrollArea
      ref={setScrollElement}
      className={scrollClassName}
      style={scrollStyle}
      onScroll={handleScroll}
      onClickCapture={handleClickCapture}
      onWheelCapture={cancelTailAlignment}
      onPointerDownCapture={cancelTailAlignment}
      onTouchStartCapture={cancelTailAlignment}
      data-virtual-transcript-scroll="true"
      data-transcript-loading-older={isLoadingOlder ? 'true' : undefined}
      aria-busy={isLoadingOlder || undefined}
    >
      {items.length > 0 ? (
        <div
          ref={setSizeContainer}
          data-virtual-transcript-size="true"
          className="relative w-full"
        >
          {virtualItems.map((virtualItem) => {
            const item = items[virtualItem.index];
            if (item === undefined) return null;
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                data-transcript-window-item="true"
                className="absolute left-0 top-0 w-full"
              >
                {renderItem(item, virtualItem.index)}
              </div>
            );
          })}
        </div>
      ) : emptyState}
      {tail}
    </ScrollArea>
  );
}
