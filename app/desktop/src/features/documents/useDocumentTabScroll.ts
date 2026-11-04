import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const GAP = 3;
const MIN_TAB_WIDTH = 88;
const MAX_TAB_WIDTH = 240;

/** Native inertia with whole-tab snap points; arrows keep a pending target for rapid clicks. */
export function useDocumentTabScroll(activeIndex: number, count: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const lastGeometry = useRef({ width: 0, count: 0 });
  const [width, setWidth] = useState(600);
  const [edges, setEdges] = useState({ left: false, right: false });
  const capacity = Math.max(1, Math.floor(width / MIN_TAB_WIDTH));
  const visibleCount = Math.max(1, Math.min(capacity, count));
  const tabWidth = Math.min(MAX_TAB_WIDTH, Math.max(1, (width - GAP * (visibleCount - 1)) / visibleCount));
  const step = tabWidth + GAP;

  const syncEdges = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const left = list.scrollLeft > 1;
    const right = list.scrollWidth - list.clientWidth - list.scrollLeft > 1;
    // Scroll events fire every frame; rerender only when an end becomes available/unavailable.
    setEdges(current => current.left === left && current.right === right ? current : { left, right });
  }, []);

  const scrollTo = useCallback((left: number, smooth = true) => {
    const list = listRef.current;
    if (!list) return;
    const target = Math.max(0, Math.min(list.scrollWidth - list.clientWidth, left));
    pendingScroll.current = target;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (list.scrollTo) list.scrollTo({ left: target, behavior: smooth && !reducedMotion ? 'smooth' : 'instant' });
    else list.scrollLeft = target;
  }, []);

  const reveal = useCallback((index: number, smooth = true) => {
    const list = listRef.current;
    if (!list || index < 0) return;
    const left = index * step;
    if (left < list.scrollLeft - 1) scrollTo(left, smooth);
    else if (left + tabWidth > list.scrollLeft + list.clientWidth + 1) {
      scrollTo((index - visibleCount + 1) * step, smooth);
    }
  }, [scrollTo, step, tabWidth, visibleCount]);

  const move = useCallback((direction: -1 | 1) => {
    const list = listRef.current;
    if (!list) return;
    scrollTo((Math.round((pendingScroll.current ?? list.scrollLeft) / step) + direction) * step);
  }, [scrollTo, step]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
      syncEdges();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [syncEdges]);

  useLayoutEffect(() => {
    const resized = lastGeometry.current.width !== width || lastGeometry.current.count !== count;
    lastGeometry.current = { width, count };
    reveal(activeIndex, !resized);
  }, [activeIndex, count, reveal, width]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onEnd = () => { pendingScroll.current = null; syncEdges(); };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || (!event.deltaX && !event.shiftKey)) return;
      if (event.shiftKey && !event.deltaX) {
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1;
        scrollTo((pendingScroll.current ?? list.scrollLeft) + event.deltaY * unit);
      } else {
        // The browser owns horizontal trackpad inertia and snap settling.
        pendingScroll.current = null;
      }
    };
    list.addEventListener('scroll', syncEdges, { passive: true });
    list.addEventListener('scrollend', onEnd);
    list.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      list.removeEventListener('scroll', syncEdges);
      list.removeEventListener('scrollend', onEnd);
      list.removeEventListener('wheel', onWheel);
    };
  }, [scrollTo, syncEdges]);

  return { listRef, tabWidth, visibleCount, overflow: count > capacity, edges, reveal, move };
}
