import type { TourRect } from './helpTourGeometry';

const clips = /^(auto|scroll|hidden|clip)$/;
const scrolls = /^(auto|scroll)$/;

function clientBounds(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const left = rect.left + element.clientLeft;
  const top = rect.top + element.clientTop;
  return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
}

/** Reveal late-loading content, then measure only the part its containers actually show. */
export function trackHelpTourTarget(element: HTMLElement) {
  const ancestors: HTMLElement[] = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
  let reveal = true;
  const observer = new ResizeObserver(() => { reveal = true; });
  [element, ...ancestors].forEach((node) => observer.observe(node));
  const marked = ancestors.filter((node) => scrolls.test(getComputedStyle(node).overflowY));
  marked.forEach((node) => node.setAttribute('data-help-tour-scroll', ''));

  return {
    measure(): TourRect | null {
      if (reveal) {
        reveal = false;
        for (const parent of ancestors) {
          const style = getComputedStyle(parent);
          const bounds = element.getBoundingClientRect();
          const area = clientBounds(parent);
          // Scroll the actual content viewport, not an overflow-hidden dialog frame.
          if (scrolls.test(style.overflowY) && parent.scrollHeight > parent.clientHeight
            && (bounds.top < area.top + 8 || bounds.bottom > area.bottom - 8)) {
            parent.scrollTop += bounds.top - area.top - (bounds.height <= parent.clientHeight - 16 ? (parent.clientHeight - bounds.height) / 2 : 8);
          }
          if (scrolls.test(style.overflowX) && parent.scrollWidth > parent.clientWidth
            && (bounds.left < area.left || bounds.right > area.right)) {
            parent.scrollLeft += bounds.left - area.left;
          }
        }
      }
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height || element.closest('[inert], [aria-hidden="true"]')) return null;
      let left = 4, top = 4, right = innerWidth - 4, bottom = innerHeight - 4;
      for (const parent of ancestors) {
        const style = getComputedStyle(parent);
        const area = clientBounds(parent);
        if (clips.test(style.overflowX)) { left = Math.max(left, area.left); right = Math.min(right, area.right); }
        if (clips.test(style.overflowY)) { top = Math.max(top, area.top); bottom = Math.min(bottom, area.bottom); }
      }
      if (bounds.right <= left || bounds.left >= right || bounds.bottom <= top || bounds.top >= bottom) return null;
      left = Math.max(left, bounds.left - 5); top = Math.max(top, bounds.top - 5);
      right = Math.min(right, bounds.right + 5); bottom = Math.min(bottom, bounds.bottom + 5);
      return { left, top, width: right - left, height: bottom - top };
    },
    dispose() {
      observer.disconnect();
      marked.forEach((node) => node.removeAttribute('data-help-tour-scroll'));
    },
  };
}
