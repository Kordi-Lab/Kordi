export const APP_WINDOW_DRAG_HEIGHT = 64;

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

function closestCapableTarget(target: EventTarget | null): ClosestCapableTarget | null {
  if (!target || typeof target !== 'object') return null;

  const candidate = target as ClosestCapableTarget;
  if (typeof candidate.closest === 'function') return candidate;

  return candidate.parentElement ?? null;
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
