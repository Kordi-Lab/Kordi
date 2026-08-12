export function cloudSyncCursorRequiresFallback(
  previousCursor: string,
  nextCursor: string,
  hasMore: boolean,
): boolean {
  // Chat cursors are opaque, signed, and account-bound. Clients must never
  // parse or order them; only a non-advancing paginated response is invalid.
  if (!nextCursor.trim()) return true;
  return hasMore && nextCursor === previousCursor;
}
