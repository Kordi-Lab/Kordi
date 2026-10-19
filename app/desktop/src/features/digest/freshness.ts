/** How long ago the saved digest was prepared, for the digest header. */
export function digestUpdatedLabel(updatedAt: string, now = Date.now()): string {
  const time = Date.parse(updatedAt);
  if (!Number.isFinite(time)) return 'Up to date';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} hr ago`;
  return `Updated ${new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
