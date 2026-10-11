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
  while (index < lines.length && !isBlank(lines[index]) && belongs(lines[index])) index += 1;
  return index;
}

function listEnd(lines: string[], start: number) {
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      let next = index + 1;
      while (next < lines.length && isBlank(lines[next])) next += 1;
      if (next < lines.length && (INDENTED.test(lines[next]) || LIST_ITEM.test(lines[next]))) {
        index = next;
        continue;
      }
      return index;
    }
    if (LIST_ITEM.test(line) || INDENTED.test(line)) {
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
  while (index < lines.length && !isBlank(lines[index]) && blockKindAt(lines, index) === 'paragraph') index += 1;
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
    if (isBlank(lines[index])) {
      index += 1;
      continue;
    }
    const kind = blockKindAt(lines, index);
    const end = kind === 'code'
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
