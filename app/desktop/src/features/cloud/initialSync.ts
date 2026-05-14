export type CloudInitialSyncStatus = 'syncing' | 'ready' | 'error';

export const CLOUD_INITIAL_SYNC_TIMEOUT_MS = 15_000;

export function cloudInitialSyncStatus({
  isCloudEdition,
  accountReady,
  canonicalSettled,
  canonicalReady,
  contactsSettled,
  messagesSettled,
  startedAtMs,
  nowMs = Date.now(),
}: {
  isCloudEdition: boolean;
  accountReady: boolean;
  canonicalSettled: boolean;
  canonicalReady: boolean;
  contactsSettled: boolean;
  messagesSettled: boolean;
  startedAtMs: number;
  nowMs?: number;
}): CloudInitialSyncStatus {
  if (!isCloudEdition) return 'ready';
  if (accountReady && canonicalSettled && canonicalReady && contactsSettled && messagesSettled) return 'ready';
  return nowMs - startedAtMs >= CLOUD_INITIAL_SYNC_TIMEOUT_MS ? 'error' : 'syncing';
}
