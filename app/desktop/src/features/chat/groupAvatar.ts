import { parseUploadedAvatarMarker } from '@/features/cloud/canonicalAvatar';

export type GroupAvatarSnapshot = { imageUrl: string | null; updatedAtMs: number };

export function normalizeGroupAvatarSnapshot(value: unknown): GroupAvatarSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.updatedAtMs) || (record.updatedAtMs as number) <= 0) return null;
  if (record.imageUrl !== null && (typeof record.imageUrl !== 'string' || !parseUploadedAvatarMarker(record.imageUrl))) return null;
  return { imageUrl: typeof record.imageUrl === 'string' ? record.imageUrl.trim() : null, updatedAtMs: record.updatedAtMs as number };
}

/** A removal is a revision too, so an old channel cannot restore the image. */
export function sharedGroupAvatar(values: readonly unknown[]): GroupAvatarSnapshot | null {
  let latest: GroupAvatarSnapshot | null = null;
  for (const value of values) {
    const snapshot = normalizeGroupAvatarSnapshot(value);
    if (snapshot && (!latest || snapshot.updatedAtMs > latest.updatedAtMs)) latest = snapshot;
  }
  return latest;
}
