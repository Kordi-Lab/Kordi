import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Retain opened content so closing can animate and nested disclosures keep their state. */
export function ProgressDisclosure({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(expanded);
  if (expanded && !visited) setVisited(true);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    const inner = content.current;
    if (!element || !inner) return;
    // Resolve the current height before retargeting, including a reversed transition.
    element.getBoundingClientRect();
    const resize = () => {
      const maxHeight = Number.parseFloat(getComputedStyle(element).maxHeight);
      const height = expanded ? Math.min(inner.getBoundingClientRect().height, Number.isFinite(maxHeight) ? maxHeight : Infinity) : 0;
      if (element.style.height !== `${height}px`) element.style.height = `${height}px`;
    };
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(resize);
    observer.observe(inner);
    // Viewport constraints can arrive after the first measured animation frame.
    const constraints = new MutationObserver(resize);
    constraints.observe(element, { attributes: true, attributeFilter: ['style'] });
    return () => { observer.disconnect(); constraints.disconnect(); };
  }, [expanded, visited]);
  return <div ref={body} className="app-progress-disclosure" data-expanded={expanded}
    data-transcript-stable-disclosure-body="true" aria-hidden={!expanded} inert={!expanded}>
    <div ref={content} className="app-progress-disclosure-content">{visited || expanded ? children : null}</div>
  </div>;
}
