import type { Virtualizer } from '@tanstack/react-virtual';

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLElement>;
export const TRANSCRIPT_SCROLL_SETTLE_MS = 250;

/** Keep native wheel/momentum scrolling independent of above-viewport resizes. */
export function createTranscriptScrollOrigin() {
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: TranscriptVirtualizer | undefined;
  const origin = {
    paddingStart: 0,
    settle(this: void) {
      clearTimeout(timer);
      active = false;
      const instance = current;
      const viewport = instance?.scrollElement;
      const padding = origin.paddingStart;
      if (!instance || !viewport || !padding) return;
      // Rebase only after momentum settles. Move layout and scroll together so
      // the reading point does not move, and restore access to the true start.
      const top = Math.max(0, viewport.scrollTop - padding);
      origin.paddingStart = 0;
      instance.options.paddingStart = 0;
      instance.scrollOffset = top;
      instance.options.onChange(instance, false);
      // Replace any unfinished tail-navigation target as well as the DOM
      // offset. Otherwise the virtualizer can reconcile that stale target on
      // its next frame and pull a history reader back toward the latest row.
      instance.scrollToOffset(top, { align: 'start', behavior: 'instant' });
    },
    wheel(instance: TranscriptVirtualizer) {
      current = instance;
      active = true;
      clearTimeout(timer);
      timer = setTimeout(origin.settle, TRANSCRIPT_SCROLL_SETTLE_MS);
    },
    scroll(instance: TranscriptVirtualizer) {
      if (!active) return;
      current = instance;
      // Normalize before reaching the leading edge; a temporary negative
      // origin must never leave the oldest message outside the scroll range.
      if (origin.paddingStart && (instance.scrollElement?.scrollTop ?? 0)
        < Math.max(0, origin.paddingStart) + 64) {
        origin.settle();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(origin.settle, TRANSCRIPT_SCROLL_SETTLE_MS);
    },
    preserve(delta: number, instance: TranscriptVirtualizer) {
      if (!active) return false;
      current = instance;
      // resizeItem will add delta to every subsequent row. Subtract it from
      // their common origin in that same layout update, without a scrollTo.
      // The virtualizer's range and DOM positions share this coordinate space.
      origin.paddingStart -= delta;
      instance.options.paddingStart = origin.paddingStart;
      return true;
    },
    dispose() {
      clearTimeout(timer);
      active = false;
    },
  };
  return origin;
}
