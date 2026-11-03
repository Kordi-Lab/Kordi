import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Retain opened content so closing can animate and nested disclosures keep their state. */
export function ProgressDisclosure({ expanded, children, id }: { expanded: boolean; children: ReactNode; id?: string }) {
  const [visited, setVisited] = useState(expanded);
  if (expanded && !visited) setVisited(true);
  const mounted = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    const inner = content.current;
    if (!element || !inner) return;
    // Capture auto height before closing; CSS layout pixels exclude ancestor zoom.
    if (element.style.height === 'auto') element.style.height = window.getComputedStyle(element).height;
    if (!mounted.current) element.style.transition = 'none';
    element.getBoundingClientRect();
    const duration = parseFloat(window.getComputedStyle(element).transitionDuration) * 1000 || 0;
    let settleTimer: number | undefined;
    const resize = () => {
      if (expanded && element.style.height === 'auto') return;
      const height = expanded ? parseFloat(window.getComputedStyle(inner).height) : 0;
      element.style.height = `${height}px`;
      window.clearTimeout(settleTimer);
      // Once open, nested details grow naturally instead of reanimating every
      // ancestor and waking tail-following after the clicked control settles.
      if (expanded) {
        if (!duration) element.style.height = 'auto';
        else settleTimer = window.setTimeout(() => { element.style.height = 'auto'; }, duration + 34);
      }
    };
    resize();
    if (!mounted.current) {
      element.getBoundingClientRect();
      element.style.removeProperty('transition');
      mounted.current = true;
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(inner);
    return () => { observer?.disconnect(); window.clearTimeout(settleTimer); };
  }, [expanded, visited]);
  return <div id={id} ref={body} className="app-progress-disclosure" data-expanded={expanded}
    data-transcript-stable-disclosure-body="true" data-transcript-disclosure-scroll="conversation" aria-hidden={!expanded} inert={!expanded}>
    <div ref={content} className="app-progress-disclosure-content">{visited || expanded ? children : null}</div>
  </div>;
}
