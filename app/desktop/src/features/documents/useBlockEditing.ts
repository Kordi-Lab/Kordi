import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { blockSpan, isFencedBlock, isListBlock, listEnter, writeSlot, type BlockEditSlot } from './documentBlockEditing';

type Block = { id: string; source: string };
/** A caret offset, or a range to select in the editor. */
export type CaretTarget = number | { start: number; end: number };

/**
 * Live-preview editing, one block at a time: the block under the caret shows
 * its Markdown in a plain-text editor and every keystroke writes the document
 * through `writeBlocks` (and so the debounced save).
 */
export function useBlockEditing({ blocks, writeBlocks, enabled }: {
  blocks: readonly Block[];
  writeBlocks: (sources: string[]) => void;
  enabled: boolean;
}) {
  const [slot, setSlot] = useState<BlockEditSlot | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<CaretTarget | null>(null);
  const sources = blocks.map((block) => block.source);

  const move = useCallback((next: BlockEditSlot | null, caret: CaretTarget | null) => {
    pendingCaret.current = caret;
    setSlot(next);
  }, []);

  // Focus the editor and place the caret after the slot changed.
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor) {
      editor.style.height = 'auto';
      editor.style.height = `${editor.scrollHeight}px`;
    }
    const caret = pendingCaret.current;
    if (caret === null || !editor) return;
    pendingCaret.current = null;
    editor.focus();
    if (typeof caret === 'number') editor.setSelectionRange(caret, caret);
    else editor.setSelectionRange(caret.start, caret.end);
  });

  const begin = useCallback((index: number, caret: number | null) => {
    if (!enabled || index < 0 || index >= sources.length) return;
    move({ index, span: 1, text: sources[index] }, caret ?? sources[index].length);
  }, [enabled, move, sources]);

  const end = useCallback(() => setSlot(null), []);

  /** New text for the slot, written into the document. */
  const change = useCallback((text: string, caret: CaretTarget | null = null) => {
    if (!slot) return;
    const written = writeSlot(sources, slot, text);
    writeBlocks(written.sources);
    move({ ...slot, text, span: written.span }, caret);
  }, [move, slot, sources, writeBlocks]);

  const splitAt = useCallback((before: string, after: string) => {
    if (!slot) return;
    const next = [...sources];
    next.splice(slot.index, slot.span, ...(before.trim() ? [before] : []), ...(after.trim() ? [after] : []));
    writeBlocks(next);
    move({ index: slot.index + blockSpan(before), span: blockSpan(after), text: after }, 0);
  }, [move, slot, sources, writeBlocks]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!slot || event.nativeEvent.isComposing) return;
    const { selectionStart: start, selectionEnd: finish, value } = event.currentTarget;
    if (event.key === 'Escape') {
      event.preventDefault();
      end();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (isFencedBlock(value)) return;
      event.preventDefault();
      if (isListBlock(value)) {
        const result = listEnter(value, start, finish);
        if (result?.kind === 'item') { change(result.text, result.caret); return; }
        if (result?.kind === 'exit') { splitAt(result.before, result.after); return; }
      }
      splitAt(value.slice(0, start), value.slice(finish));
      return;
    }
    if (event.key === 'Backspace' && start === 0 && finish === 0 && slot.index > 0) {
      event.preventDefault();
      const previous = sources[slot.index - 1];
      const merged = value ? `${previous}${value}` : previous;
      const next = [...sources];
      next.splice(slot.index - 1, 1 + slot.span, merged);
      writeBlocks(next);
      move({ index: slot.index - 1, span: blockSpan(merged), text: merged }, previous.length);
    }
  }, [change, end, move, slot, sources, splitAt, writeBlocks]);

  return { slot, editorRef, begin, end, change, onKeyDown };
}
