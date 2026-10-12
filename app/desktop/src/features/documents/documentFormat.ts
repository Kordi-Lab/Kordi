import type { SourceRange } from './documentSourceMap';

export type InlineFormat = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight';
export type BlockStyle = 'text' | 'h1' | 'h2' | 'h3' | 'quote';

const MARKERS: Record<Exclude<InlineFormat, 'bold' | 'italic'>, [string, string]> = {
  underline: ['<u>', '</u>'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  highlight: ['==', '=='],
};

function runLength(source: string, index: number, step: 1 | -1, character: string) {
  let count = 0;
  for (let at = index; source[at] === character; at += step) count += 1;
  return count;
}

/** Emphasis cannot start or end on a space, so the range shrinks to its first and last visible character. */
function tighten(source: string, range: SourceRange): SourceRange {
  let { start, end } = range;
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return { start, end };
}

export function isInlineFormatActive(source: string, range: SourceRange, format: InlineFormat) {
  const { start, end } = tighten(source, range);
  if (format === 'bold' || format === 'italic') {
    const before = runLength(source, start - 1, -1, '*');
    const after = runLength(source, end, 1, '*');
    return format === 'bold' ? before >= 2 && after >= 2 : before % 2 === 1 && after % 2 === 1;
  }
  const [open, close] = MARKERS[format];
  return source.slice(start - open.length, start) === open && source.slice(end, end + close.length) === close;
}

/** Wraps the range in the format's markers, or removes them when they are already there. */
export function toggleInlineFormat(source: string, range: SourceRange, format: InlineFormat) {
  const { start, end } = tighten(source, range);
  if (start === end) return source;
  const [open, close] = format === 'bold' ? ['**', '**'] : format === 'italic' ? ['*', '*'] : MARKERS[format];
  if (isInlineFormatActive(source, { start, end }, format)) {
    return source.slice(0, start - open.length) + source.slice(start, end) + source.slice(end + close.length);
  }
  return source.slice(0, start) + open + source.slice(start, end) + close + source.slice(end);
}

export function linkAt(source: string, range: SourceRange) {
  const { start, end } = tighten(source, range);
  if (source[start - 1] !== '[' || !source.slice(end).startsWith('](')) return null;
  const close = source.indexOf(')', end);
  return close < 0 ? null : { start: start - 1, end: close + 1, url: source.slice(end + 2, close) };
}

/** `[text](url)` around the range, or the link removed when the range is already a link. */
export function toggleLink(source: string, range: SourceRange, url: string) {
  const existing = linkAt(source, range);
  const { start, end } = tighten(source, range);
  if (existing) return source.slice(0, existing.start) + source.slice(start, end) + source.slice(existing.end);
  const target = url.trim();
  if (!target || start === end) return source;
  return `${source.slice(0, start)}[${source.slice(start, end)}](${target})${source.slice(end)}`;
}

const LIST_PREFIX = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

/** Prefixes every line of the block with `- `, or removes the list markers when every line has one. */
export function toggleList(source: string) {
  const lines = source.split('\n');
  const isList = lines.every((line) => !line.trim() || LIST_PREFIX.test(line));
  return lines.map((line) => {
    if (!line.trim()) return line;
    return isList ? line.replace(LIST_PREFIX, '$1') : `- ${line}`;
  }).join('\n');
}

export function isList(source: string) {
  return source.split('\n').every((line) => !line.trim() || LIST_PREFIX.test(line));
}

export function blockStyleOf(source: string): BlockStyle {
  const heading = /^#{1,6}(?=\s)/.exec(source)?.[0].length ?? 0;
  if (heading === 1) return 'h1';
  if (heading === 2) return 'h2';
  if (heading >= 3) return 'h3';
  return source.split('\n').every((line) => !line.trim() || /^\s*>/.test(line)) ? 'quote' : 'text';
}

/** Changes the block's leading marker: paragraph, heading 1 to 3 (one line), or quote. */
export function setBlockStyle(source: string, style: BlockStyle) {
  const plain = source.split('\n')
    .map((line) => line.replace(/^\s*>\s?/, '').replace(/^#{1,6}\s+/, ''));
  if (style === 'quote') return plain.map((line) => (line.trim() ? `> ${line}` : '>')).join('\n');
  if (style === 'text') return plain.join('\n');
  const level = style === 'h1' ? '#' : style === 'h2' ? '##' : '###';
  return `${level} ${plain.map((line) => line.trim()).filter(Boolean).join(' ')}`;
}
