export type KordiCopySurface = 'message' | 'document';

const COPY_SURFACE_SELECTOR = '[data-kordi-copy-surface]';

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

export function installCopySurfaceSelectionTracking(root: Document) {
  const clearSelectionFromOutsidePointer = (event: PointerEvent) => {
    if (event.button !== 0 || isEditableSelectionTarget(event.target)) return;
    const target = event.target instanceof Element ? event.target : null;
    // Controls that act on the current selection (the document selection menu) keep it.
    if (target?.closest(`${COPY_SURFACE_SELECTOR}, [data-kordi-keeps-selection]`)) return;
    clearNativeTextSelection();
  };
  root.addEventListener('pointerdown', clearSelectionFromOutsidePointer, true);
  return () => {
    root.removeEventListener('pointerdown', clearSelectionFromOutsidePointer, true);
  };
}
