export type EmojiTextSelection = {
  start: number;
  end: number;
};

export type EmojiInsertion = {
  value: string;
  selection: EmojiTextSelection;
};

type Segment = { index: number; segment: string };
type SegmenterLike = { segment(value: string): Iterable<Segment> };
type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' },
) => SegmenterLike;

let cachedSegmenter: SegmenterLike | null | undefined;

function graphemeSegmenter(): SegmenterLike | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  const constructor = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  cachedSegmenter = constructor ? new constructor(undefined, { granularity: 'grapheme' }) : null;
  return cachedSegmenter;
}

export function graphemeSegments(value: string): string[] {
  const segmenter = graphemeSegmenter();
  if (!segmenter) return Array.from(value);
  return Array.from(segmenter.segment(value), ({ segment }) => segment);
}

export function graphemeCount(value: string): number {
  return graphemeSegments(value).length;
}

export function truncateGraphemes(value: string, maximum: number): string {
  if (maximum <= 0) return '';
  return graphemeSegments(value).slice(0, maximum).join('');
}

function graphemeBoundaries(value: string): number[] {
  const segmenter = graphemeSegmenter();
  if (!segmenter) {
    const boundaries = [0];
    let offset = 0;
    for (const character of Array.from(value)) {
      offset += character.length;
      boundaries.push(offset);
    }
    return boundaries;
  }
  const boundaries = Array.from(segmenter.segment(value), ({ index }) => index);
  boundaries.push(value.length);
  return [...new Set(boundaries)].sort((left, right) => left - right);
}

function previousBoundary(boundaries: readonly number[], offset: number): number {
  let result = 0;
  for (const boundary of boundaries) {
    if (boundary > offset) break;
    result = boundary;
  }
  return result;
}

function nextBoundary(boundaries: readonly number[], offset: number): number {
  return boundaries.find((boundary) => boundary >= offset) ?? boundaries[boundaries.length - 1] ?? 0;
}

export function normalizeEmojiSelection(value: string, selection: EmojiTextSelection): EmojiTextSelection {
  const maximum = value.length;
  const rawStart = Math.max(0, Math.min(maximum, Math.min(selection.start, selection.end)));
  const rawEnd = Math.max(0, Math.min(maximum, Math.max(selection.start, selection.end)));
  const boundaries = graphemeBoundaries(value);
  const start = previousBoundary(boundaries, rawStart);
  const end = rawStart === rawEnd ? start : nextBoundary(boundaries, rawEnd);
  return { start, end };
}

export function insertEmojiAtSelection(
  value: string,
  emoji: string,
  selection: EmojiTextSelection,
): EmojiInsertion {
  const normalized = normalizeEmojiSelection(value, selection);
  const nextValue = `${value.slice(0, normalized.start)}${emoji}${value.slice(normalized.end)}`;
  const caret = normalized.start + emoji.length;
  return { value: nextValue, selection: { start: caret, end: caret } };
}
