/**
 * Measured transcript row heights, kept across transcript mounts.
 *
 * Opening a chat mounts a new virtualizer. Without this memory every row
 * starts at an estimate, so the entry spends several frames measuring and
 * re-aligning the tail while history is hidden, and a returning visit shows
 * the same blank frames as a cold one. Row keys include the session key, so
 * a remembered height belongs to one row of one chat. Heights are hints: the
 * virtualizer still measures every mounted row, and a row whose content or
 * width changed simply re-measures.
 */
const MAX_REMEMBERED_ROWS = 4_000;

type RememberedRow = { size: number; measuredAt: number };

const rowHeights = new Map<string, RememberedRow>();

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

export function transcriptRowSizeClock() {
  return now();
}

export function rememberTranscriptRowSize(key: string | number | bigint, size: number) {
  if (!Number.isFinite(size) || size <= 0) return;
  const id = String(key);
  // An unchanged height keeps the time it was first seen.
  if (rowHeights.get(id)?.size === size) return;
  // Re-insert so the oldest rows are the first evicted.
  rowHeights.delete(id);
  rowHeights.set(id, { size, measuredAt: now() });
  if (rowHeights.size > MAX_REMEMBERED_ROWS) {
    const oldest = rowHeights.keys().next().value;
    if (oldest !== undefined) rowHeights.delete(oldest);
  }
}

export function rememberedTranscriptRowSize(key: string | number | bigint): number | undefined {
  return rowHeights.get(String(key))?.size;
}

/** The row's height when it was already that height before `since` (an earlier visit). */
export function settledTranscriptRowSize(key: string | number | bigint, since: number): number | undefined {
  const row = rowHeights.get(String(key));
  return row && row.measuredAt < since ? row.size : undefined;
}

export function clearTranscriptRowSizeMemoryForTests() {
  rowHeights.clear();
}
