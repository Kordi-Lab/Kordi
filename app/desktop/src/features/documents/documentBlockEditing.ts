import { splitMarkdownBlocks } from './documentBlocks';
import { projectMarkdown } from './documentSourceMap';

/** The block being typed into: its position in the block list, how many blocks its text spans now, and its text. */
export type BlockEditSlot = { index: number; span: number; text: string };

/** Number of blocks a text occupies once split; an empty text occupies none. */
export function blockSpan(text: string) {
  return text.trim() ? splitMarkdownBlocks(text).length : 0;
}

/** Block sources with the slot's text written in place of the blocks it covered. */
export function writeSlot(sources: readonly string[], slot: Pick<BlockEditSlot, 'index' | 'span'>, text: string) {
  const next = [...sources];
  next.splice(slot.index, slot.span, ...(text.trim() ? [text] : []));
  return { sources: next, span: blockSpan(text) };
}

/** Source offset of a caret placed after `visibleCount` visible (non-space) rendered characters. */
export function caretSourceOffset(source: string, visibleCount: number) {
  const { offsets } = projectMarkdown(source);
  if (visibleCount <= 0) return offsets[0] ?? source.length;
  if (visibleCount > offsets.length) return source.length;
  return offsets[visibleCount - 1] + 1;
}

const LIST_LINE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?/;

export function isFencedBlock(text: string) {
  return /^ {0,3}(```|~~~)/.test(text);
}

export function isListBlock(text: string) {
  return text.split('\n').some((line) => LIST_LINE.test(line)) && LIST_LINE.test(text.split('\n')[0] ?? '');
}

type ListEnter = { kind: 'item'; text: string; caret: number } | { kind: 'exit'; before: string; after: string };

/**
 * Enter inside a list: a new item with the same marker (numbers count up,
 * checkboxes start empty), or, on an empty item, the end of the list.
 */
export function listEnter(text: string, start: number, end: number): ListEnter | null {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEndAt = text.indexOf('\n', end);
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
  const line = text.slice(lineStart, lineEnd);
  const marker = LIST_LINE.exec(line);
  if (!marker) return null;
  if (!line.slice(marker[0].length).trim()) {
    const before = text.slice(0, lineStart).replace(/\n$/, '');
    return { kind: 'exit', before, after: text.slice(lineEnd).replace(/^\n/, '') };
  }
  const number = /^\d+/.exec(marker[2]);
  const bullet = number ? `${Number(number[0]) + 1}${marker[2].slice(number[0].length)}` : marker[2];
  const prefix = `\n${marker[1]}${bullet}${marker[3]}${marker[4] ? '[ ] ' : ''}`;
  return { kind: 'item', text: text.slice(0, start) + prefix + text.slice(end), caret: start + prefix.length };
}
