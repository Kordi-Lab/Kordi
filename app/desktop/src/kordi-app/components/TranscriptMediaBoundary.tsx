import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

function MediaContents({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      node?.querySelectorAll('img').forEach(image => {
        image.removeAttribute('src');
        image.removeAttribute('srcset');
      });
      node?.querySelectorAll('video, audio').forEach(element => {
        const media = element as HTMLMediaElement;
        media.pause();
        media.removeAttribute('src');
        media.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
        media.load();
      });
    };
  }, []);
  return <div ref={ref}>{children}</div>;
}

/** Release heavy media beyond two viewport heights without collapsing its row. */
export function TranscriptMediaBoundary({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const activeRef = useRef(true);
  const [active, setActive] = useState(true);
  const [reserved, setReserved] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const root = node.closest<HTMLElement>('[data-virtual-transcript-scroll]');
    let observer: IntersectionObserver | null = null;
    const update = (near: boolean) => {
      const next = near && document.visibilityState !== 'hidden';
      if (activeRef.current === next) return;
      if (!next) {
        const rect = node.getBoundingClientRect();
        setSize({ width: rect.width, height: rect.height });
        setReserved(true);
      }
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

  useLayoutEffect(() => {
    const node = ref.current;
    if (!active || !reserved || !node) return;
    const settled = () => {
      const loading = node.querySelector('[data-attachment-image-loading="true"], [data-attachment-video-sizing="resolving"]');
      if (!loading && [...node.querySelectorAll('img')].every(image => image.complete)) setReserved(false);
    };
    settled();
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(settled);
    observer?.observe(node, { subtree: true, childList: true, attributes: true });
    node.addEventListener('load', settled, true); node.addEventListener('error', settled, true);
    return () => { observer?.disconnect(); node.removeEventListener('load', settled, true); node.removeEventListener('error', settled, true); };
  }, [active, reserved]);

  return <div ref={ref} data-transcript-media-active={String(active)} aria-hidden={active ? undefined : true}
    style={active ? reserved ? { minHeight: size.height, minWidth: size.width, maxWidth: '100%' } : undefined
      : { height: size.height, width: size.width, maxWidth: '100%' }}>
    {active ? <MediaContents>{children}</MediaContents> : null}
  </div>;
}
