import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';

export const GROUP_MANAGEMENT_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');
export const GROUP_MEMBER_GRID_COLUMNS = 5;
const COLLAPSED_MEMBER_GRID_ROWS = 4;
export const COLLAPSED_MEMBER_GRID_ITEMS = GROUP_MEMBER_GRID_COLUMNS * COLLAPSED_MEMBER_GRID_ROWS;

export type GroupManagementPopoverAnchor = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PopoverPlacement = 'right' | 'left' | 'floating';
type GroupPopoverStyle = CSSProperties & {
  '--app-group-management-enter-x'?: string;
  '--app-group-management-origin'?: string;
};

type GroupPopoverGeometry = {
  style: GroupPopoverStyle;
  arrowStyle: CSSProperties;
  placement: PopoverPlacement;
};

export type ViewportSize = {
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function groupManagementGeometry(
  anchorRect?: GroupManagementPopoverAnchor | null,
  viewport?: ViewportSize,
): GroupPopoverGeometry {
  const margin = 12;
  const gap = 10;
  const viewportWidth = viewport?.width
    ?? (typeof window === 'undefined' ? 1280 : window.innerWidth);
  const viewportHeight = viewport?.height
    ?? (typeof window === 'undefined' ? 800 : window.innerHeight);
  const width = Math.min(372, Math.max(0, viewportWidth - margin * 2));
  const height = Math.min(760, Math.max(0, viewportHeight - margin * 2));
  const floatingGeometry = (): GroupPopoverGeometry => ({
    placement: 'floating',
    arrowStyle: { top: 22 },
    style: {
      left: clamp((viewportWidth - width) / 2, margin, viewportWidth - width - margin),
      top: clamp((viewportHeight - height) / 2, margin, viewportHeight - height - margin),
      width,
      maxHeight: height,
      '--app-group-management-enter-x': '0px',
      '--app-group-management-origin': 'center',
    },
  });

  if (!anchorRect) return floatingGeometry();

  const rightLeft = anchorRect.left + anchorRect.width + gap;
  const leftLeft = anchorRect.left - width - gap;
  const canFitRight = rightLeft + width <= viewportWidth - margin;
  const canFitLeft = leftLeft >= margin;
  if (!canFitRight && !canFitLeft) return floatingGeometry();
  const placement: PopoverPlacement = canFitRight || !canFitLeft ? 'right' : 'left';
  const unclampedLeft = placement === 'right' ? rightLeft : leftLeft;
  const left = clamp(unclampedLeft, margin, viewportWidth - width - margin);
  const top = clamp(anchorRect.top - 18, margin, viewportHeight - height - margin);
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;
  const arrowTop = clamp(anchorCenterY - top - 6, 22, height - 34);

  return {
    placement,
    arrowStyle: { top: arrowTop },
    style: {
      left,
      top,
      width,
      maxHeight: height,
      '--app-group-management-enter-x': placement === 'right' ? '-8px' : '8px',
      '--app-group-management-origin': placement === 'right' ? 'left 26px' : 'right 26px',
    },
  };
}

function gridColumnCount(grid: HTMLElement) {
  if (typeof window === 'undefined') return GROUP_MEMBER_GRID_COLUMNS;
  const columns = window.getComputedStyle(grid).gridTemplateColumns
    .split(' ')
    .filter(Boolean).length;
  return Math.max(1, columns || GROUP_MEMBER_GRID_COLUMNS);
}

export function handleGridArrowNavigation(event: ReactKeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const grid = event.currentTarget.closest<HTMLElement>('[data-group-member-grid]');
  if (!grid) return;
  const items = Array.from(grid.querySelectorAll<HTMLButtonElement>('[data-group-member-grid-item]'));
  const currentIndex = items.indexOf(event.currentTarget);
  if (currentIndex < 0 || items.length === 0) return;
  const columns = gridColumnCount(grid);
  let nextIndex = currentIndex;
  if (event.key === 'ArrowLeft') nextIndex -= 1;
  if (event.key === 'ArrowRight') nextIndex += 1;
  if (event.key === 'ArrowUp') nextIndex -= columns;
  if (event.key === 'ArrowDown') nextIndex += columns;
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = items.length - 1;
  nextIndex = clamp(nextIndex, 0, items.length - 1);
  if (nextIndex === currentIndex) return;
  event.preventDefault();
  items[nextIndex]?.focus();
}
