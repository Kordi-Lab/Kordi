import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { TranscriptMediaActivity } from './transcriptMediaActivity';

/** Keep posters and card state mounted; only heavy players react to activity. */
export function TranscriptMediaBoundary({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(true);
  const [active, setActive] = useState(true);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const root = node.closest<HTMLElement>('[data-virtual-transcript-scroll]');
    let observer: IntersectionObserver | null = null;
    const update = (near: boolean) => {
      const next = near && document.visibilityState !== 'hidden';
      if (activeRef.current === next) return;
      activeRef.current = next;
      setActive(next);
    };
    const measureRange = () => {
      const viewport = root?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight, height: window.innerHeight };
      const rect = node.getBoundingClientRect();
      if (viewport.height > 0) update(rect.bottom >= viewport.top - viewport.height * 2 && rect.top <= viewport.bottom + viewport.height * 2);
      observer?.disconnect();
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) update(entry.isIntersecting);
      }, { root, rootMargin: `${Math.max(0, viewport.height * 2)}px 0px` });
      observer.observe(node);
    };
    measureRange();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureRange);
    if (root) resize?.observe(root);
    else window.addEventListener('resize', measureRange);
    document.addEventListener('visibilitychange', measureRange);
    return () => {
      observer?.disconnect(); resize?.disconnect();
      window.removeEventListener('resize', measureRange);
      document.removeEventListener('visibilitychange', measureRange);
    };
  }, []);

  return <div ref={ref} data-transcript-media-active={String(active)}>
    <TranscriptMediaActivity.Provider value={active}>{children}</TranscriptMediaActivity.Provider>
  </div>;
}
