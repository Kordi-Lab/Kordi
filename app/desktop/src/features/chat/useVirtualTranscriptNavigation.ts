import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from 'react';

export const TRANSCRIPT_NAVIGATION_HIGHLIGHT_CLASS = 'app-transcript-message-highlight';
const NAVIGATION_HIGHLIGHT_DURATION_MS = 1_500;

export type VirtualTranscriptNavigationRequest = {
  id: string;
  nonce: number;
  sessionKey: string;
  lookupIds?: readonly string[];
};

function navigationRequestIdentity(request: VirtualTranscriptNavigationRequest) {
  return JSON.stringify([request.sessionKey, request.nonce, request.id.trim()]);
}

function navigationRequestLookupIds(request: VirtualTranscriptNavigationRequest) {
  const seen = new Set<string>();
  return [request.id, ...(request.lookupIds ?? [])].flatMap((value) => {
    const id = value.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
}

export function useVirtualTranscriptNavigation<Item>({
  items,
  sessionKey,
  navigationRequest,
  findNavigationIndex,
  getItemKey,
  virtualItems,
  scrollRef,
  cancelTailAlignment,
  scrollToIndex,
  onNavigationReady,
  onNavigationHandled,
}: {
  items: readonly Item[];
  sessionKey: string;
  navigationRequest?: VirtualTranscriptNavigationRequest | null;
  findNavigationIndex?: (item: Item, messageId: string, index: number) => boolean;
  getItemKey: (item: Item, index: number) => string | number;
  virtualItems: readonly { index: number }[];
  scrollRef: RefObject<HTMLElement | null>;
  cancelTailAlignment: () => void;
  scrollToIndex: (index: number) => void;
  onNavigationReady?: (messageId: string) => void;
  onNavigationHandled?: (request: VirtualTranscriptNavigationRequest) => void;
}) {
  const [handledRequestIdentity, setHandledRequestIdentity] = useState<string | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<{
    identity: string;
    request: VirtualTranscriptNavigationRequest;
    startedAtMs: number;
  } | null>(null);
  const scopedRequest = navigationRequest?.sessionKey === sessionKey
    ? navigationRequest
    : null;
  const scopedRequestIdentity = scopedRequest
    ? navigationRequestIdentity(scopedRequest)
    : null;
  const pendingRequest = scopedRequest
    && handledRequestIdentity !== scopedRequestIdentity
    ? scopedRequest
    : null;
  const scopedActiveRequest = activeHighlight?.request.sessionKey === sessionKey
    ? activeHighlight.request
    : null;
  const displayedRequest = pendingRequest ?? scopedActiveRequest;
  const displayedLookupIds = useMemo(
    () => displayedRequest ? navigationRequestLookupIds(displayedRequest) : [],
    [displayedRequest],
  );
  const targetIndex = useMemo(() => {
    if (displayedLookupIds.length === 0) return -1;
    return items.findIndex((item, index) => (
      displayedLookupIds.some((id) => (
        findNavigationIndex?.(item, id, index) ?? String(getItemKey(item, index)) === id
      ))
    ));
  }, [displayedLookupIds, findNavigationIndex, getItemKey, items]);
  const pendingTargetIndex = pendingRequest ? targetIndex : -1;
  const pendingTargetMounted = pendingTargetIndex >= 0
    && virtualItems.some((virtualItem) => virtualItem.index === pendingTargetIndex);

  const activeHighlightIdentity = activeHighlight?.identity ?? null;
  const activeHighlightStartedAtMs = activeHighlight?.startedAtMs ?? 0;
  useEffect(() => {
    if (!activeHighlightIdentity) return undefined;
    const elapsedMs = Date.now() - activeHighlightStartedAtMs;
    const timeoutId = window.setTimeout(() => {
      setActiveHighlight((current) => (
        current?.identity === activeHighlightIdentity ? null : current
      ));
    }, Math.max(0, NAVIGATION_HIGHLIGHT_DURATION_MS - elapsedMs));
    return () => window.clearTimeout(timeoutId);
  }, [activeHighlightIdentity, activeHighlightStartedAtMs]);

  useLayoutEffect(() => {
    if (!pendingRequest || pendingTargetIndex < 0) return;
    cancelTailAlignment();
    scrollToIndex(pendingTargetIndex);
  }, [cancelTailAlignment, pendingRequest, pendingTargetIndex, scrollToIndex]);

  useLayoutEffect(() => {
    if (
      !pendingRequest
      || !scopedRequestIdentity
      || pendingTargetIndex < 0
      || !pendingTargetMounted
      || handledRequestIdentity === scopedRequestIdentity
    ) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-transcript-window-item="true"][data-index="${pendingTargetIndex}"]`,
    );
    if (
      !target?.isConnected
      || !target.classList.contains(TRANSCRIPT_NAVIGATION_HIGHLIGHT_CLASS)
    ) return;

    setHandledRequestIdentity(scopedRequestIdentity);
    setActiveHighlight({
      identity: scopedRequestIdentity,
      request: pendingRequest,
      startedAtMs: Date.now(),
    });
    onNavigationReady?.(pendingRequest.id);
    onNavigationHandled?.(pendingRequest);
  }, [
    onNavigationHandled,
    onNavigationReady,
    handledRequestIdentity,
    pendingRequest,
    pendingTargetIndex,
    pendingTargetMounted,
    scopedRequestIdentity,
    scrollRef,
  ]);

  return {
    navigationTargetIndex: targetIndex,
    pendingNavigationRequest: pendingRequest,
    pendingNavigationTargetIndex: pendingTargetIndex,
  };
}
