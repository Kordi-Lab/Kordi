export type MenuRect = { left: number; top: number; width: number; height: number };
export type MenuBounds = { left: number; top: number; right: number; bottom: number };
export type MenuPlacement = { left: number; top: number; side: 'below' | 'above' };

const GAP = 6;
const MARGIN = 8;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where the group avatar menu opens: below the avatar (above it when only that
 * fits), centred on it when the menu fits inside the bounds, otherwise aligned
 * to the avatar's left edge, and never past the bounds. The bounds are the
 * window, narrowed horizontally to the dialog that holds the avatar.
 */
export function groupAvatarMenuPlacement(anchor: MenuRect, menu: { width: number; height: number }, bounds: MenuBounds): MenuPlacement {
  const minLeft = bounds.left + MARGIN;
  const maxLeft = bounds.right - MARGIN - menu.width;
  const centered = anchor.left + (anchor.width - menu.width) / 2;
  const preferred = centered >= minLeft && centered <= maxLeft ? centered : anchor.left;
  const left = clamp(preferred, minLeft, maxLeft);

  const below = anchor.top + anchor.height + GAP;
  const above = anchor.top - GAP - menu.height;
  const fitsBelow = below + menu.height <= bounds.bottom - MARGIN;
  const side = fitsBelow || above < bounds.top + MARGIN ? 'below' : 'above';
  const top = clamp(side === 'below' ? below : above, bounds.top + MARGIN, bounds.bottom - MARGIN - menu.height);
  return { left: Math.round(left), top: Math.round(top), side };
}

/** The window, narrowed horizontally to the dialog or popover around `element`. */
export function groupAvatarMenuBounds(element: Element): MenuBounds {
  const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const container = element.closest('[role="dialog"]')?.getBoundingClientRect();
  if (!container || container.width <= 0) return viewport;
  return { ...viewport, left: Math.max(viewport.left, container.left), right: Math.min(viewport.right, container.right) };
}
