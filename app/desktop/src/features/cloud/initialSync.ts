import type { CanonicalSessionState } from '@/kordi-app/types';

export type CloudInitialSyncStatus = 'syncing' | 'ready' | 'error';

export const CLOUD_INITIAL_SYNC_TIMEOUT_MS = 15_000;

export function cloudInitialSyncStatus({
  isCloudEdition,
  accountReady,
  canonicalSettled,
  canonicalReady,
  contactsSettled,
  messagesSettled,
  desktopChatSettled = true,
  localBackupReady = false,
  startedAtMs,
  nowMs = Date.now(),
}: {
  isCloudEdition: boolean;
  accountReady: boolean;
  canonicalSettled: boolean;
  canonicalReady: boolean;
  contactsSettled: boolean;
  messagesSettled: boolean;
  desktopChatSettled?: boolean;
  localBackupReady?: boolean;
  startedAtMs: number;
  nowMs?: number;
}): CloudInitialSyncStatus {
  if (!isCloudEdition) return 'ready';
  if (!accountReady || !canonicalSettled || !canonicalReady || !desktopChatSettled) {
    return nowMs - startedAtMs >= CLOUD_INITIAL_SYNC_TIMEOUT_MS ? 'error' : 'syncing';
  }
  if (localBackupReady) return 'ready';
  if (contactsSettled && messagesSettled) return 'ready';
  return nowMs - startedAtMs >= CLOUD_INITIAL_SYNC_TIMEOUT_MS ? 'error' : 'syncing';
}

function cloudText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function canonicalStateHasCloudLocalBackup(
  state: CanonicalSessionState | null | undefined,
  accountId: string | null | undefined,
): boolean {
  if (!state) return false;
  const normalizedAccountId = accountId?.trim() ?? '';
  return state.messages.some((message) => {
    const sourceTransport = cloudText(message.sourceTransport);
    const sourceEventId = cloudText(message.sourceEventId);
    if (sourceTransport.startsWith('cloud') || sourceEventId.startsWith('cloud')) return true;
    const content = message.content && typeof message.content === 'object' && !Array.isArray(message.content)
      ? message.content as Record<string, unknown>
      : null;
    const senderAccountId = cloudText(content?.senderAccountId);
    return Boolean(normalizedAccountId && senderAccountId === normalizedAccountId);
  });
}
