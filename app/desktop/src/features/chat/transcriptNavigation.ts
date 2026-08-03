import type { RefObject } from 'react';

export function transcriptMessageDomId(messageId: string) {
  return `app-transcript-message-${messageId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

const transcriptHighlightTimeouts = new WeakMap<Element, number>();

function findVisibleTranscriptMessage(messageId: string) {
  if (typeof document === 'undefined') return null;
  const target = document.getElementById(transcriptMessageDomId(messageId));
  if (!target) return null;
  return target.closest?.('[data-transcript-message-root]') ?? target;
}

function highlightVisibleTranscriptMessage(target: Element) {
  const existingTimeout = transcriptHighlightTimeouts.get(target);
  if (existingTimeout !== undefined) window.clearTimeout(existingTimeout);

  target.classList.add('app-transcript-message-highlight');
  const timeoutId = window.setTimeout(() => {
    target.classList.remove('app-transcript-message-highlight');
    transcriptHighlightTimeouts.delete(target);
  }, 1500);
  transcriptHighlightTimeouts.set(target, timeoutId);
}

export function highlightTranscriptMessage(messageId: string) {
  const visibleTarget = findVisibleTranscriptMessage(messageId);
  if (!visibleTarget) return false;
  highlightVisibleTranscriptMessage(visibleTarget);
  return true;
}

function scrollTranscriptElementIntoContainer(
  target: Element,
  scrollContainer?: HTMLElement | null,
) {
  if (!scrollContainer || !scrollContainer.contains(target)) return false;
  if (
    typeof target.getBoundingClientRect !== 'function'
    || typeof scrollContainer.getBoundingClientRect !== 'function'
  ) {
    return false;
  }

  const targetRect = target.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  const nextTop = scrollContainer.scrollTop
    + (targetRect.top - containerRect.top)
    - (scrollContainer.clientHeight / 2)
    + (targetRect.height / 2);

  if (typeof scrollContainer.scrollTo === 'function') {
    scrollContainer.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
  } else {
    scrollContainer.scrollTop = Math.max(0, nextTop);
  }
  return true;
}

export function navigateToTranscriptMessage(
  messageId: string,
  scrollRef?: RefObject<HTMLElement | null> | null,
) {
  const visibleTarget = findVisibleTranscriptMessage(messageId);
  if (!visibleTarget) return false;
  const discoveredScrollContainer = visibleTarget.closest?.(
    '.app-scroll-area',
  ) as HTMLElement | null | undefined;
  if (
    !scrollTranscriptElementIntoContainer(
      visibleTarget,
      scrollRef?.current ?? discoveredScrollContainer ?? null,
    )
  ) {
    visibleTarget.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  highlightVisibleTranscriptMessage(visibleTarget);
  return true;
}

export function scrollTranscriptToBottom(
  scrollRef?: RefObject<HTMLElement | null> | null,
) {
  const scrollContainer = scrollRef?.current;
  if (!scrollContainer) return false;
  if (typeof scrollContainer.scrollTo === 'function') {
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: 'smooth',
    });
  } else {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }
  return true;
}

export function navigateToTranscriptMessageOrScrollBottom(
  messageId: string,
  scrollRef?: RefObject<HTMLElement | null> | null,
) {
  return navigateToTranscriptMessage(messageId, scrollRef)
    || scrollTranscriptToBottom(scrollRef);
}
