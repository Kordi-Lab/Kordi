import { useEffect, useState, type RefObject } from 'react';

const listeners = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;

function observeNearViewport(element: Element, listener: () => void) {
  if (typeof IntersectionObserver === 'undefined') {
    listener();
    return () => {};
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer?.unobserve(entry.target);
      listeners.get(entry.target)?.();
      listeners.delete(entry.target);
    }
  }, { rootMargin: '240px' });
  listeners.set(element, listener);
  observer.observe(element);
  return () => {
    observer?.unobserve(element);
    listeners.delete(element);
  };
}

export function useNearEmojiViewport(ref: RefObject<Element | null>, enabled: boolean) {
  const [nearViewport, setNearViewport] = useState(!enabled);
  useEffect(() => {
    if (!enabled || nearViewport || !ref.current) return;
    return observeNearViewport(ref.current, () => setNearViewport(true));
  }, [enabled, nearViewport, ref]);
  return nearViewport;
}
