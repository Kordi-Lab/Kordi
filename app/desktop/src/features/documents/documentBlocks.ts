/**
 * Top-level Markdown blocks in source order with ids `b0`, `b1`, ….
 *
 * The server owns block ids for uploaded documents. The Mac computes the same
 * ids for a local file only until it is uploaded.
 */
export type DocumentBlockKind = 'code' | 'table' | 'heading' | 'rule' | 'quote' | 'list' | 'paragraph';

export type DocumentBlock = {
  id: string;
  kind: DocumentBlockKind;
  source: string;
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const TABLE_SEPARATOR = /^[\s|:-]*-[\s|:-]*$/;
const INDENTED = /^(?: {2,}|\t)\S/;
/** A block id comment on its own line; it belongs to the block right above it. */
const ID_COMMENT_LINE = /^[ \t]*<!--\s*k:[A-Za-z0-9_-]{4,32}\s*-->[ \t]*$/;

export function isIdCommentLine(line: string | undefined) {
  return line !== undefined && ID_COMMENT_LINE.test(line);
}

/** Bullet character, or the ordered-list delimiter: items of the same kind form one CommonMark list. */
function listKind(line: string) {
  const match = /^ {0,3}(?:([-*+])|\d{1,9}([.)]))(?:[ \t]+|$)/.exec(line);
  return match ? match[1] ?? match[2] : null;
}

function isBlank(line: string | undefined) {
  return line === undefined || line.trim() === '';
}

function startsTable(lines: string[], index: number) {
  const line = lines[index];
  const next = lines[index + 1];
  return line.includes('|') && next !== undefined && next.includes('|') && TABLE_SEPARATOR.test(next);
}

function blockKindAt(lines: string[], index: number): DocumentBlockKind {
  const line = lines[index];
  if (FENCE.test(line)) return 'code';
  if (startsTable(lines, index)) return 'table';
  if (HEADING.test(line)) return 'heading';
  if (RULE.test(line)) return 'rule';
  if (QUOTE.test(line)) return 'quote';
  if (LIST_ITEM.test(line)) return 'list';
  return 'paragraph';
}

function fenceEnd(lines: string[], start: number) {
  const opening = FENCE.exec(lines[start])?.[1] ?? '```';
  const marker = opening[0];
  for (let index = start + 1; index < lines.length; index += 1) {
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[index])?.[1];
    if (closing && closing[0] === marker && closing.length >= opening.length) return index + 1;
  }
  return lines.length;
}

function runEnd(lines: string[], start: number, belongs: (line: string) => boolean) {
  let index = start + 1;
  while (index < lines.length && !isBlank(lines[index]) && !isIdCommentLine(lines[index]) && belongs(lines[index])) index += 1;
  return index;
}

function listEnd(lines: string[], start: number) {
  const kind = listKind(lines[start]);
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (isIdCommentLine(line)) return index;
    if (isBlank(line)) {
      // CommonMark: after blank lines the list goes on with an indented line or another item of the same kind (a loose list).
      let next = index + 1;
      while (next < lines.length && isBlank(lines[next])) next += 1;
      if (next < lines.length && (INDENTED.test(lines[next]) || (LIST_ITEM.test(lines[next]) && listKind(lines[next]) === kind))) {
        index = next;
        continue;
      }
      return index;
    }
    if (INDENTED.test(line)) {
      index += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      if (listKind(line) !== kind) return index;
      index += 1;
      continue;
    }
    // A lazy continuation line of the last item, unless another block starts here.
    if (blockKindAt(lines, index) !== 'paragraph') return index;
    index += 1;
  }
  return index;
}

function paragraphEnd(lines: string[], start: number) {
  let index = start + 1;
  while (index < lines.length && !isBlank(lines[index]) && !isIdCommentLine(lines[index]) && blockKindAt(lines, index) === 'paragraph') index += 1;
  return index;
}

function trimTrailingBlankLines(lines: string[]) {
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1])) end -= 1;
  return lines.slice(0, end);
}

export function splitMarkdownBlocks(source: string): DocumentBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocumentBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    // Blank lines, and an id comment with no block above it, are not blocks.
    if (isBlank(lines[index]) || isIdCommentLine(lines[index])) {
      index += 1;
      continue;
    }
    const kind = blockKindAt(lines, index);
    const blockEnd = kind === 'code'
      ? fenceEnd(lines, index)
      : kind === 'table'
        ? runEnd(lines, index + 1, (line) => line.includes('|'))
        : kind === 'heading' || kind === 'rule'
          ? index + 1
          : kind === 'quote'
            ? runEnd(lines, index, (line) => QUOTE.test(line))
            : kind === 'list'
              ? listEnd(lines, index)
              : paragraphEnd(lines, index);
    // The id comment on the line right after a block is part of that block.
    const end = isIdCommentLine(lines[blockEnd]) ? blockEnd + 1 : blockEnd;
    blocks.push({
      id: `b${blocks.length}`,
      kind,
      source: trimTrailingBlankLines(lines.slice(index, end)).join('\n'),
    });
    index = end;
  }
  return blocks;
}

/** The first level-1 heading, used as the title of a local document. */
export function markdownDocumentTitle(source: string): string | null {
  for (const block of splitMarkdownBlocks(source)) {
    const match = /^ {0,3}#(?!#)\s+(.+?)\s*#*\s*$/.exec(block.source);
    if (block.kind === 'heading' && match) return match[1].trim();
  }
  return null;
}
