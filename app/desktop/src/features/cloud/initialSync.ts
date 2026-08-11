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
  // Authentication and the local database are the only startup prerequisites.
  // Contacts, durable chat catch-up, and the local agent runtime continue in
  // the mounted shell; making any of them a global gate turns a recoverable
  // background timeout into an endless blank splash on a clean device.
  void contactsSettled;
  void messagesSettled;
  void desktopChatSettled;
  if (accountReady && localBackupReady) return 'ready';
  if (accountReady && canonicalSettled && canonicalReady) return 'ready';
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
