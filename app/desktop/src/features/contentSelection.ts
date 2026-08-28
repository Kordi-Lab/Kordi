export type KordiCopySurface = 'message' | 'document';

const COPY_SURFACE_SELECTOR = '[data-kordi-copy-surface]';
const COPY_BLOCK_SELECTOR = '[data-kordi-copy-block="true"]';
const UNIFIED_SELECTION_ATTRIBUTE = 'data-kordi-copy-selection';

type SelectionKeyboardEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  target: EventTarget | null;
  currentTarget: EventTarget & HTMLElement;
  preventDefault: () => void;
  stopPropagation: () => void;
};

export function clearNativeTextSelection() {
  if (typeof window === 'undefined') return;
  window.getSelection()?.removeAllRanges();
}

export function isEditableSelectionTarget(target: EventTarget | null) {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])'));
}

export function isSelectAllShortcut(event: Pick<SelectionKeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>) {
  return event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey);
}

export function selectCopySurfaceContents(surface: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(surface);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function handleDocumentCopySurfaceKeyDown(event: SelectionKeyboardEvent) {
  if (!isSelectAllShortcut(event) || isEditableSelectionTarget(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  selectCopySurfaceContents(event.currentTarget);
}

export function copySurfaceProps(copySurface?: KordiCopySurface) {
  return {
    'data-kordi-copy-surface': copySurface,
    tabIndex: copySurface === 'document' ? 0 : undefined,
    onKeyDown: copySurface === 'document' ? handleDocumentCopySurfaceKeyDown : undefined,
  } as const;
}

function rangeIntersectsNode(range: Range, node: Node) {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function visibleRangeRects(range: Range) {
  if (typeof range.getClientRects !== 'function') return [];
  return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
}

function distinctSelectionLineCount(rects: readonly DOMRect[]) {
  const lineTops: number[] = [];
  for (const rect of rects) {
    if (lineTops.some((top) => Math.abs(top - rect.top) < 2)) continue;
    lineTops.push(rect.top);
  }
  return lineTops.length;
}

function clearUnifiedCopySelection(root: Document) {
  root.querySelectorAll<HTMLElement>(`[${UNIFIED_SELECTION_ATTRIBUTE}="unified"]`).forEach((surface) => {
    surface.removeAttribute(UNIFIED_SELECTION_ATTRIBUTE);
    surface.style.removeProperty('--app-copy-selection-top');
    surface.style.removeProperty('--app-copy-selection-height');
  });
}

export function syncCopySurfaceSelection(
  root: Document,
  selection: Selection | null = root.getSelection(),
) {
  clearUnifiedCopySelection(root);
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString()) return;

  const range = selection.getRangeAt(0);
  const selectionRects = visibleRangeRects(range);
  if (distinctSelectionLineCount(selectionRects) < 2) return;

  root.querySelectorAll<HTMLElement>(COPY_SURFACE_SELECTOR).forEach((surface) => {
    if (!rangeIntersectsNode(range, surface)) return;
    if (root.defaultView?.getComputedStyle(surface).display === 'inline') return;

    const surfaceRect = surface.getBoundingClientRect();
    const selectedBlocks = Array.from(surface.querySelectorAll<HTMLElement>(COPY_BLOCK_SELECTOR))
      .filter((block) => block.closest(COPY_SURFACE_SELECTOR) === surface)
      .filter((block) => rangeIntersectsNode(range, block));
    const selectedRects = selectedBlocks.length > 0
      ? selectedBlocks.map((block) => block.getBoundingClientRect())
      : selectionRects.filter((rect) => (
          rect.bottom >= surfaceRect.top
          && rect.top <= surfaceRect.bottom
          && rect.right >= surfaceRect.left
          && rect.left <= surfaceRect.right
        ));
    if (selectedRects.length === 0) return;

    const top = Math.max(0, Math.min(...selectedRects.map((rect) => rect.top)) - surfaceRect.top);
    const bottom = Math.min(
      surfaceRect.height,
      Math.max(...selectedRects.map((rect) => rect.bottom)) - surfaceRect.top,
    );
    if (bottom <= top) return;

    surface.style.setProperty('--app-copy-selection-top', `${top}px`);
    surface.style.setProperty('--app-copy-selection-height', `${bottom - top}px`);
    surface.setAttribute(UNIFIED_SELECTION_ATTRIBUTE, 'unified');
  });
}

export function installCopySurfaceSelectionTracking(root: Document) {
  const syncSelection = () => syncCopySurfaceSelection(root);
  const clearSelectionFromOutsidePointer = (event: PointerEvent) => {
    if (event.button !== 0 || isEditableSelectionTarget(event.target)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(COPY_SURFACE_SELECTOR)) return;
    clearNativeTextSelection();
  };
  root.addEventListener('selectionchange', syncSelection);
  root.addEventListener('pointerdown', clearSelectionFromOutsidePointer, true);
  root.defaultView?.addEventListener('resize', syncSelection);
  syncSelection();
  return () => {
    root.removeEventListener('selectionchange', syncSelection);
    root.removeEventListener('pointerdown', clearSelectionFromOutsidePointer, true);
    root.defaultView?.removeEventListener('resize', syncSelection);
    clearUnifiedCopySelection(root);
  };
}
