import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { readDocumentSelection, readEditorSelection, restoreDocumentSelection, type DocumentTextSelection } from './documentSelectionDom';
import type { SelectionMenuPosition } from './DocumentSelectionMenu';

const MENU_HEIGHT = 40;
const MENU_GAP = 8;
const EDGE = 8;
/** Room the tallest panel (the Aa menu) needs above the bar. */
const PANEL_HEIGHT = 190;

/**
 * Centered over the selection's bounding box, 8px above it (the menu is
 * translated up by its own height), or 8px below when there is no room above.
 */
export function selectionMenuPosition(
  body: HTMLElement,
  rect: DocumentTextSelection['rect'],
  menuWidth: number,
): SelectionMenuPosition {
  const bounds = body.getBoundingClientRect();
  const fitsAbove = rect.top - bounds.top >= MENU_HEIGHT + MENU_GAP;
  const top = fitsAbove
    ? rect.top - bounds.top + body.scrollTop - MENU_GAP
    : rect.bottom - bounds.top + body.scrollTop + MENU_GAP;
  const center = rect.left - bounds.left + rect.width / 2;
  const half = Math.min(menuWidth, body.clientWidth - EDGE * 2) / 2;
  const left = Math.max(EDGE + half, Math.min(center, body.clientWidth - EDGE - half));
  const panelsFitAbove = rect.top - bounds.top >= MENU_HEIGHT + MENU_GAP + PANEL_HEIGHT;
  return { top, left, placement: fitsAbove ? 'above' : 'below', panels: fitsAbove && panelsFitAbove ? 'above' : 'below' };
}

type Target = Pick<DocumentTextSelection, 'blockId' | 'text' | 'occurrence'>;

/**
 * Tracks the text selection inside the reader body: the selected range (for
 * the floating menu) and the block holding the caret (for inserts).
 */
export function useDocumentSelection(bodyRef: RefObject<HTMLElement | null>, menuRef: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<{ selection: DocumentTextSelection; position: SelectionMenuPosition } | null>(null);
  const [currentBlockId, setCurrentBlockId] = useState<string | null>(null);
  const pendingRestore = useRef<Target | null>(null);

  const update = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const active = body.ownerDocument.activeElement;
    // Typing a link URL moves focus into the menu; the text selection stays as it was.
    if (menuRef.current && active && menuRef.current.contains(active)) return;
    const editor = active?.tagName === 'TEXTAREA' && (active as HTMLTextAreaElement).dataset.documentEditor && body.contains(active) ? active as HTMLTextAreaElement : null;
    const read = editor ? readEditorSelection(editor) : readDocumentSelection(body);
    if (!read) {
      setState(null);
      return;
    }
    if (read.kind === 'caret') {
      setCurrentBlockId(read.blockId);
      setState(null);
      return;
    }
    setCurrentBlockId(read.selection.blockId);
    setState({ selection: read.selection, position: selectionMenuPosition(body, read.selection.rect, menuRef.current?.offsetWidth || 330) });
  }, [bodyRef, menuRef]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    const ownerDocument = body.ownerDocument;
    ownerDocument.addEventListener('selectionchange', update);
    body.addEventListener('scroll', update, { passive: true });
    return () => {
      ownerDocument.removeEventListener('selectionchange', update);
      body.removeEventListener('scroll', update);
    };
  }, [bodyRef, update]);

  // After a format re-renders the block, select the same text again.
  useLayoutEffect(() => {
    const target = pendingRestore.current;
    if (!target) return;
    pendingRestore.current = null;
    if (restoreDocumentSelection(bodyRef.current, target)) update();
  });

  const clear = useCallback(() => {
    setState(null);
    bodyRef.current?.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
  }, [bodyRef]);

  const restoreAfterRender = useCallback((target: Target) => { pendingRestore.current = target; }, []);

  return { selection: state?.selection ?? null, position: state?.position ?? null, currentBlockId, update, clear, restoreAfterRender };
}
