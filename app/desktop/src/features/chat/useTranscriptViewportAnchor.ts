import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

type Anchor = { rowKey: string; screenTop: number; scrollTop: number; viewportTop: number };
type Snapshot = { sessionKey: string; updateKey: string; contentKey: string; anchor: Anchor | null; active: boolean };

/** Pin decorations preserve the visible message, including changes to the shelf above it. */
export function useTranscriptViewportAnchor({ sessionKey, updateKey, contentKey, viewportRef }: {
  sessionKey: string;
  updateKey?: string;
  contentKey: string;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const snapshot = useRef<Snapshot | null>(null);
  const [revision, setRevision] = useState({ sessionKey, updateKey, contentKey, preserving: false });
  let preserving = revision.preserving;
  if (revision.sessionKey !== sessionKey || revision.updateKey !== updateKey || revision.contentKey !== contentKey) {
    preserving = updateKey !== undefined && revision.sessionKey === sessionKey && revision.contentKey === contentKey
      && (revision.preserving || revision.updateKey !== updateKey);
    setRevision({ sessionKey, updateKey, contentKey, preserving });
  }
  // Callers keep these in effect and callback dependencies, so they must hold
  // their identity between renders. A fresh object per render re-ran the
  // transcript's tail alignment on every commit and let the tail row drift.
  const restore = useCallback(() => {
    const element = viewportRef.current;
    const saved = snapshot.current;
    if (!element || !saved?.active || !saved.anchor) return;
    const anchor = saved.anchor;
    const row = [...element.querySelectorAll<HTMLElement>('[data-transcript-row-key]')]
      .find(node => node.dataset.transcriptRowKey === anchor.rowKey);
    const target = row
      ? element.scrollTop + row.getBoundingClientRect().top - anchor.screenTop
      : anchor.scrollTop + element.getBoundingClientRect().top - anchor.viewportTop;
    if (Math.abs(element.scrollTop - target) > 0.5) element.scrollTop = Math.max(0, target);
  }, [viewportRef]);
  const release = useCallback(() => {
    if (snapshot.current) snapshot.current.active = false;
    setRevision(current => current.preserving ? { ...current, preserving: false } : current);
  }, []);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || updateKey === undefined) { snapshot.current = null; return; }
    const capture = () => {
      const current = snapshot.current;
      if (current?.active) return;
      const viewportTop = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>('[data-transcript-row-key]')]
        .find(node => node.getBoundingClientRect().bottom > viewportTop);
      snapshot.current = { sessionKey, updateKey, contentKey, active: false, anchor: row ? {
        rowKey: row.dataset.transcriptRowKey!, screenTop: row.getBoundingClientRect().top,
        scrollTop: element.scrollTop, viewportTop,
      } : null };
    };
    const previous = snapshot.current;
    snapshot.current = { sessionKey, updateKey, contentKey, active: preserving,
      anchor: preserving ? previous?.anchor ?? null : null };
    const settle = () => { if (snapshot.current?.active) restore(); else capture(); };
    settle();
    // Virtual rows can receive their final measured transforms after layout effects.
    const mutations = preserving ? new window.MutationObserver(settle) : null;
    mutations?.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    const sizes = new ResizeObserver(settle);
    sizes.observe(element);
    const handleInteraction = () => { release(); capture(); };
    element.addEventListener('scroll', capture);
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) element.addEventListener(type, handleInteraction);
    let disposed = false;
    queueMicrotask(() => { if (!disposed) settle(); });
    return () => {
      disposed = true;
      mutations?.disconnect(); sizes.disconnect();
      element.removeEventListener('scroll', capture);
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) element.removeEventListener(type, handleInteraction);
    };
  });
  return useMemo(() => ({ preserving, restore, release }), [preserving, restore, release]);
}
