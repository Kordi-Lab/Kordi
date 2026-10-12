import { nthOccurrence, occurrencesBefore, stripWhitespace } from './documentSourceMap';

/** A text range inside one block, kept as text plus occurrence so it survives re-rendering. */
export type DocumentTextSelection = {
  blockId: string;
  text: string;
  occurrence: number;
  rect: { top: number; bottom: number; left: number; width: number };
};

export type DocumentSelectionRead =
  | { kind: 'range'; selection: DocumentTextSelection }
  | { kind: 'caret'; blockId: string }
  | null;

function blockOf(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest<HTMLElement>('[data-document-block]') ?? null;
}

function textRoot(block: HTMLElement) {
  return block.querySelector<HTMLElement>('.app-document-markdown') ?? block;
}

/** Reads the window selection when it lies inside one block of `container`. */
export function readDocumentSelection(container: HTMLElement | null): DocumentSelectionRead {
  const view = container?.ownerDocument.defaultView;
  const selection = view?.getSelection();
  if (!container || !selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const startBlock = blockOf(range.startContainer);
  const blockId = startBlock?.dataset.documentBlock;
  if (!startBlock || !blockId || blockOf(range.endContainer) !== startBlock) return null;
  if (range.collapsed) return { kind: 'caret', blockId };
  const text = range.toString();
  const needle = stripWhitespace(text);
  if (!needle) return null;
  const root = textRoot(startBlock);
  const prefix = root.ownerDocument.createRange();
  prefix.setStart(root, 0);
  prefix.setEnd(range.startContainer, range.startOffset);
  const position = stripWhitespace(prefix.toString()).length;
  const occurrence = occurrencesBefore(stripWhitespace(root.textContent ?? ''), needle, position);
  const box = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : startBlock.getBoundingClientRect();
  return { kind: 'range', selection: { blockId, text, occurrence, rect: { top: box.top, bottom: box.bottom, left: box.left, width: box.width } } };
}

/** Point in the block's text nodes at a whitespace-free character index. */
function pointAt(root: HTMLElement, index: number, edge: 'start' | 'end') {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    for (let offset = 0; offset < value.length; offset += 1) {
      if (/\s/.test(value[offset])) continue;
      if (seen === index) return { node, offset: edge === 'start' ? offset : offset + 1 };
      seen += 1;
    }
  }
  return null;
}

/** Selects the same text again after the block re-rendered. */
export function restoreDocumentSelection(container: HTMLElement | null, target: Pick<DocumentTextSelection, 'blockId' | 'text' | 'occurrence'>) {
  const block = container?.querySelector<HTMLElement>(`[data-document-block="${target.blockId.replace(/["\\]/g, "")}"]`);
  const selection = container?.ownerDocument.defaultView?.getSelection();
  if (!block || !selection) return false;
  const root = textRoot(block);
  const needle = stripWhitespace(target.text);
  const index = nthOccurrence(stripWhitespace(root.textContent ?? ''), needle, target.occurrence);
  const start = index >= 0 ? pointAt(root, index, 'start') : null;
  const end = index >= 0 ? pointAt(root, index + needle.length - 1, 'end') : null;
  if (!start || !end) return false;
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
