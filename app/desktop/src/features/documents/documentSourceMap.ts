/**
 * Maps rendered text back to Markdown source. The projection drops the markers
 * the renderer hides (block markers, emphasis, code ticks, `<u>`, `<mark>`,
 * `~~`, `==`, link syntax, table pipes) and all whitespace, and keeps the
 * source offset of every character it keeps.
 */
export type SourceProjection = { text: string; offsets: number[] };

export type SourceRange = { start: number; end: number };

const FENCE = /^ {0,3}(```|~~~)/;
const TABLE_SEPARATOR = /^[\s|:-]*-[\s|:-]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLOCK_PREFIX = /^(?:\s*>\s?|\s*#{1,6}\s+|\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)/;
const HIDDEN_TAGS = ['<mark>', '</mark>', '<u>', '</u>'];
const LINK = /^\[([^\]]*)\]\([^)\s]*\)/;
const IMAGE = /^!\[[^\]]*\]\([^)]*\)/;

export function stripWhitespace(value: string) {
  return value.replace(/\s+/g, '');
}

function isWordCharacter(value: string | undefined) {
  return Boolean(value && /[\p{L}\p{N}]/u.test(value));
}

function projectInline(line: string, lineStart: number, from: number, out: SourceProjection) {
  let index = from;
  while (index < line.length) {
    const rest = line.slice(index);
    const character = line[index];
    if (character === '\\' && /[\\`*_[\]~=<|]/.test(line[index + 1] ?? '')) {
      out.text += line[index + 1];
      out.offsets.push(lineStart + index + 1);
      index += 2;
      continue;
    }
    const tag = HIDDEN_TAGS.find((entry) => rest.toLowerCase().startsWith(entry));
    if (tag) { index += tag.length; continue; }
    const image = IMAGE.exec(rest);
    if (image) { index += image[0].length; continue; }
    const link = LINK.exec(rest);
    if (link) {
      projectInline(link[1], lineStart + index + 1, 0, out);
      index += link[0].length;
      continue;
    }
    if (rest.startsWith('~~') || rest.startsWith('==')) { index += 2; continue; }
    if (character === '*' || character === '`' || character === '|') { index += 1; continue; }
    if (character === '_' && !(isWordCharacter(line[index - 1]) && isWordCharacter(line[index + 1]))) { index += 1; continue; }
    if (!/\s/.test(character)) {
      out.text += character;
      out.offsets.push(lineStart + index);
    }
    index += 1;
  }
}

export function projectMarkdown(source: string): SourceProjection {
  const out: SourceProjection = { text: '', offsets: [] };
  let lineStart = 0;
  let inFence = false;
  for (const line of source.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
    } else if (inFence) {
      for (let index = 0; index < line.length; index += 1) {
        if (/\s/.test(line[index])) continue;
        out.text += line[index];
        out.offsets.push(lineStart + index);
      }
    } else if (!(line.includes('|') && TABLE_SEPARATOR.test(line)) && !RULE.test(line)) {
      let from = 0;
      for (let match = BLOCK_PREFIX.exec(line); match && match[0]; match = BLOCK_PREFIX.exec(line.slice(from))) {
        from += match[0].length;
      }
      projectInline(line, lineStart, from, out);
    }
    lineStart += line.length + 1;
  }
  return out;
}

/** Index of the n-th (zero-based) occurrence of `needle` in `haystack`, overlapping matches counted. */
export function nthOccurrence(haystack: string, needle: string, occurrence: number) {
  if (!needle) return -1;
  let found = -1;
  for (let count = 0; count <= occurrence; count += 1) {
    found = haystack.indexOf(needle, found + 1);
    if (found < 0) return -1;
  }
  return found;
}

/** How many matches of `needle` start before `position`. */
export function occurrencesBefore(haystack: string, needle: string, position: number) {
  let count = 0;
  for (let found = haystack.indexOf(needle); found >= 0 && found < position; found = haystack.indexOf(needle, found + 1)) count += 1;
  return count;
}

/** Source range of the n-th occurrence of the selected rendered text, or null when it cannot be found. */
export function locateSelection(source: string, text: string, occurrence: number): SourceRange | null {
  const needle = stripWhitespace(text);
  if (!needle) return null;
  const projection = projectMarkdown(source);
  const start = nthOccurrence(projection.text, needle, occurrence);
  if (start < 0) return null;
  return { start: projection.offsets[start], end: projection.offsets[start + needle.length - 1] + 1 };
}
