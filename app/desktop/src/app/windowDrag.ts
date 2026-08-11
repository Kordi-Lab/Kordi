export const APP_WINDOW_DRAG_HEIGHT = 64;
export const APP_WINDOW_RESIZE_EDGE = 12;
export const APP_WINDOW_RESIZE_CORNER = 24;
export const CLOUD_LOGIN_WINDOW_DRAG_STYLE = {
  left: `${APP_WINDOW_RESIZE_EDGE}px`,
  right: `${APP_WINDOW_RESIZE_EDGE}px`,
  top: `${APP_WINDOW_RESIZE_EDGE}px`,
  height: `${48 - APP_WINDOW_RESIZE_EDGE}px`,
  WebkitAppRegion: 'drag',
} as const;

export type NativeWindowResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West';

export const WINDOW_DRAG_BLOCK_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'option',
  '[contenteditable="true"]',
  '[draggable="true"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="tab"]',
  '[data-kordi-window-drag="false"]',
  '[data-tauri-drag-region="false"]',
].join(',');

type ClosestCapableTarget = EventTarget & {
  closest?: (selector: string) => unknown;
  parentElement?: ClosestCapableTarget | null;
};

type NativeWindowDragGesture = {
  isNativeShell: boolean;
  button: number;
  clientY: number;
  shellTop: number;
  target: EventTarget | null;
};

type NativeWindowResizeGesture = {
  isNativeShell: boolean;
  button: number;
  clientX: number;
  clientY: number;
  shellBounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  edgeSize?: number;
  cornerSize?: number;
};

function closestCapableTarget(target: EventTarget | null): ClosestCapableTarget | null {
  if (!target || typeof target !== 'object') return null;

  const candidate = target as ClosestCapableTarget;
  if (typeof candidate.closest === 'function') return candidate;

  return candidate.parentElement ?? null;
}

export function nativeWindowResizeDirection({
  isNativeShell,
  button,
  clientX,
  clientY,
  shellBounds,
  edgeSize = APP_WINDOW_RESIZE_EDGE,
  cornerSize = APP_WINDOW_RESIZE_CORNER,
}: NativeWindowResizeGesture): NativeWindowResizeDirection | null {
  if (!isNativeShell || button !== 0 || edgeSize <= 0 || cornerSize < edgeSize) return null;

  const withinHorizontalBounds = clientX >= shellBounds.left && clientX <= shellBounds.right;
  const withinVerticalBounds = clientY >= shellBounds.top && clientY <= shellBounds.bottom;
  if (!withinHorizontalBounds || !withinVerticalBounds) return null;

  const nearLeft = clientX - shellBounds.left <= edgeSize;
  const nearRight = shellBounds.right - clientX <= edgeSize;
  const nearTop = clientY - shellBounds.top <= edgeSize;
  const nearBottom = shellBounds.bottom - clientY <= edgeSize;
  const withinLeftCorner = clientX - shellBounds.left <= cornerSize;
  const withinRightCorner = shellBounds.right - clientX <= cornerSize;
  const withinTopCorner = clientY - shellBounds.top <= cornerSize;
  const withinBottomCorner = shellBounds.bottom - clientY <= cornerSize;

  if ((nearTop && withinLeftCorner) || (nearLeft && withinTopCorner)) return 'NorthWest';
  if ((nearTop && withinRightCorner) || (nearRight && withinTopCorner)) return 'NorthEast';
  if ((nearBottom && withinLeftCorner) || (nearLeft && withinBottomCorner)) return 'SouthWest';
  if ((nearBottom && withinRightCorner) || (nearRight && withinBottomCorner)) return 'SouthEast';
  if (nearTop) return 'North';
  if (nearBottom) return 'South';
  if (nearLeft) return 'West';
  if (nearRight) return 'East';
  return null;
}

export function shouldStartNativeWindowDrag({
  isNativeShell,
  button,
  clientY,
  shellTop,
  target,
}: NativeWindowDragGesture) {
  if (!isNativeShell || button !== 0) return false;

  const localY = clientY - shellTop;
  if (localY < 0 || localY > APP_WINDOW_DRAG_HEIGHT) return false;

  const closestTarget = closestCapableTarget(target);
  if (closestTarget?.closest?.(WINDOW_DRAG_BLOCK_SELECTOR)) return false;

  return true;
}
