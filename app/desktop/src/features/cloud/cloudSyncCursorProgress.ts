export function cloudSyncCursorRequiresFallback(
  previousCursor: string,
  nextCursor: string,
  hasMore: boolean,
): boolean {
  try {
    if (BigInt(nextCursor) < BigInt(previousCursor)) return true;
  } catch {
    return true;
  }
  return hasMore && nextCursor === previousCursor;
}
