export const APP_WINDOW_DRAG_HEIGHT = 64;
export const APP_WINDOW_RESIZE_GUARD = 12;

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
  clientX: number;
  clientY: number;
  shellLeft: number;
  shellRight: number;
  shellTop: number;
  target: EventTarget | null;
};

function closestCapableTarget(target: EventTarget | null): ClosestCapableTarget | null {
  if (!target || typeof target !== 'object') return null;

  const candidate = target as ClosestCapableTarget;
  if (typeof candidate.closest === 'function') return candidate;

  return candidate.parentElement ?? null;
}

export function shouldStartNativeWindowDrag({
  isNativeShell,
  button,
  clientX,
  clientY,
  shellLeft,
  shellRight,
  shellTop,
  target,
}: NativeWindowDragGesture) {
  if (!isNativeShell || button !== 0) return false;

  const localX = clientX - shellLeft;
  const localY = clientY - shellTop;
  const shellWidth = shellRight - shellLeft;
  if (
    localX <= APP_WINDOW_RESIZE_GUARD
    || localX >= shellWidth - APP_WINDOW_RESIZE_GUARD
    || localY <= APP_WINDOW_RESIZE_GUARD
    || localY > APP_WINDOW_DRAG_HEIGHT
  ) return false;

  const closestTarget = closestCapableTarget(target);
  if (closestTarget?.closest?.(WINDOW_DRAG_BLOCK_SELECTOR)) return false;

  return true;
}
