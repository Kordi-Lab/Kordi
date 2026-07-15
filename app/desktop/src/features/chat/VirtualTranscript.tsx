import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  olderLoadingLabel?: ReactNode;
  emptyState?: ReactNode;
  tail?: ReactNode;
  estimateSize?: (item: Item, index: number) => number;
  gap?: number;
};

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
  olderLoadingLabel = 'Loading earlier messages…',
  emptyState,
  tail,
  estimateSize,
  gap = 4,
}: VirtualTranscriptProps<Item>) {
  const renderPerformanceSpan = beginChatPerformanceSpan('transcript-virtual-render');
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const loadAttemptSignatureRef = useRef<string | null>(null);
  const olderLoadPromiseRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const alignedSessionRef = useRef<{
    sessionKey: string;
    itemCount: number;
    lastItemKey: string;
  } | null>(null);
  const viewportWasAtTailRef = useRef(true);
  const handledNavigationRequestRef = useRef<string | null>(null);

  const setScrollElement = useCallback((node: HTMLDivElement | null) => {
    internalScrollRef.current = node;
    if (scrollRef) scrollRef.current = node;
  }, [scrollRef]);

  const itemKeyAt = useCallback((index: number) => {
    const item = items[index];
    return item === undefined ? `missing:${index}` : getItemKey(item, index);
  }, [getItemKey, items]);

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
    anchorTo: 'end',
    useFlushSync: false,
  });

  const scopedNavigationRequest = navigationRequest?.sessionKey === sessionKey
    ? navigationRequest
    : null;

  const navigationTargetIndex = useMemo(() => {
    const id = scopedNavigationRequest?.id.trim() ?? '';
    if (!id) return -1;
    return items.findIndex((item, index) => (
      findNavigationIndex?.(item, id, index) ?? String(getItemKey(item, index)) === id
    ));
  }, [findNavigationIndex, getItemKey, items, scopedNavigationRequest?.id]);

  const oldestItemKey = items.length > 0 ? String(getItemKey(items[0]!, 0)) : 'empty';
  const newestItemKey = items.length > 0 ? String(getItemKey(items[items.length - 1]!, items.length - 1)) : 'empty';

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const requestOlder = useCallback((signature?: string) => {
    if (!hasOlder || !onLoadOlder) return null;
    if (signature && loadAttemptSignatureRef.current === signature) return olderLoadPromiseRef.current;
    if (olderLoadPromiseRef.current) return olderLoadPromiseRef.current;
    if (signature) loadAttemptSignatureRef.current = signature;
    setIsLoadingOlder(true);
    let succeeded = false;
    const request = Promise.resolve(onLoadOlder())
      .then(() => { succeeded = true; })
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        if (olderLoadPromiseRef.current === request) olderLoadPromiseRef.current = null;
        if (!succeeded && loadAttemptSignatureRef.current === signature) loadAttemptSignatureRef.current = null;
        if (mountedRef.current) setIsLoadingOlder(false);
      });
    olderLoadPromiseRef.current = request;
    return request;
  }, [hasOlder, onLoadOlder]);

  useEffect(() => {
    const request = scopedNavigationRequest;
    if (!request || navigationTargetIndex >= 0 || !hasOlder || !onLoadOlder) return;
    const signature = `${request.sessionKey}:${request.nonce}:${request.id}:${items.length}:${oldestItemKey}`;
    void requestOlder(signature);
  }, [hasOlder, items.length, navigationTargetIndex, oldestItemKey, onLoadOlder, requestOlder, scopedNavigationRequest]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const distanceFromTail = element.scrollHeight - (element.scrollTop + element.clientHeight);
    viewportWasAtTailRef.current = distanceFromTail <= Math.max(4, gap);
    onScroll?.(event);
    if (element.scrollTop > Math.max(160, element.clientHeight * 0.25)) return;
    void requestOlder(`scroll:${sessionKey}:${items.length}:${oldestItemKey}`);
  }, [gap, items.length, oldestItemKey, onScroll, requestOlder, sessionKey]);

  useLayoutEffect(() => {
    if (items.length === 0) {
      if (alignedSessionRef.current?.sessionKey !== sessionKey) alignedSessionRef.current = null;
      return;
    }
    const aligned = alignedSessionRef.current;
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
    const shouldAlign = aligned?.sessionKey !== sessionKey
      || firstPageReplacedLoadingCopy
      || catalogPreviewHydrated;
    alignedSessionRef.current = {
      sessionKey,
      itemCount: items.length,
      lastItemKey: newestItemKey,
    };
    if (shouldAlign) {
      viewportWasAtTailRef.current = true;
      virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    }
  }, [items.length, newestItemKey, sessionKey, virtualizer]);

  useLayoutEffect(() => {
    const request = scopedNavigationRequest;
    if (!request || navigationTargetIndex < 0) return undefined;
    const requestIdentity = JSON.stringify([request.sessionKey, request.nonce, request.id.trim()]);
    if (handledNavigationRequestRef.current === requestIdentity) return undefined;
    virtualizer.scrollToIndex(navigationTargetIndex, { align: 'center' });
    const frameId = window.requestAnimationFrame(() => {
      handledNavigationRequestRef.current = requestIdentity;
      onNavigationReady?.(request.id);
      onNavigationHandled?.(request);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [navigationTargetIndex, onNavigationHandled, onNavigationReady, scopedNavigationRequest, virtualizer]);

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
      data-virtual-transcript-scroll="true"
    >
      {isLoadingOlder ? (
        <div
          data-transcript-older-loading="true"
          className="pointer-events-none sticky top-1 z-10 flex h-0 justify-center overflow-visible text-[11px] text-[color:var(--utility-muted-text)]"
          role="status"
        >
          {olderLoadingLabel}
        </div>
      ) : null}
      {items.length > 0 ? (
        <div
          data-virtual-transcript-size="true"
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
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
                style={{ transform: `translateY(${virtualItem.start}px)` }}
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
