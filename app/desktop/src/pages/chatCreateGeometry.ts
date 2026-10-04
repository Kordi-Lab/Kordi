import type { CSSProperties } from 'react';

export type ChatCreatePopoverAnchor = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PopoverPlacement = 'right' | 'left' | 'floating';
type PopoverStyle = CSSProperties & {
  '--app-create-enter-x'?: string;
  '--app-popover-origin'?: string;
};

type PopoverGeometry = {
  style: PopoverStyle;
  arrowStyle: CSSProperties;
  placement: PopoverPlacement;
};

export function popoverGeometry(anchorRect?: ChatCreatePopoverAnchor | null): PopoverGeometry {
  const width = 284;
  const gap = 10;
  const margin = 10;
  const fallbackLeft = 92;
  const fallbackTop = 74;

  if (!anchorRect) {
    return {
      placement: 'floating',
      arrowStyle: { top: 18 },
      style: {
        left: fallbackLeft,
        top: fallbackTop,
        '--app-create-enter-x': '-6px',
        '--app-popover-origin': 'left 22px',
      },
    };
  }

  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const rightLeft = anchorRect.left + anchorRect.width + gap;
  const leftLeft = anchorRect.left - width - gap;
  const canFitRight = rightLeft + width <= viewportWidth - margin;
  const canFitLeft = leftLeft >= margin;
  const placement: PopoverPlacement = canFitRight || !canFitLeft ? 'right' : 'left';
  const unclampedLeft = placement === 'right' ? rightLeft : leftLeft;
  const left = Math.min(Math.max(margin, unclampedLeft), Math.max(margin, viewportWidth - width - margin));
  const top = Math.min(Math.max(margin, anchorRect.top - 4), Math.max(margin, viewportHeight - 220));
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;
  const arrowTop = Math.min(Math.max(18, anchorCenterY - top - 6), 54);

  return {
    placement,
    arrowStyle: { top: arrowTop },
    style: {
      left,
      top,
      '--app-create-enter-x': placement === 'right' ? '-8px' : '8px',
      '--app-popover-origin': placement === 'right' ? 'left 22px' : 'right 22px',
    },
  };
}
