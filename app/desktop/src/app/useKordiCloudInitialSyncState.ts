import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  CLOUD_INITIAL_SYNC_TIMEOUT_MS,
  canonicalStateHasCloudLocalBackup,
  cloudInitialSyncStatus,
} from '@/features/cloud/initialSync';
import type { CanonicalSessionState } from '@/kordi-app/types';

type RefreshAction = () => unknown;

type UseKordiCloudInitialSyncStateArgs = {
  accountId: string | null;
  cachedMessagesReady: boolean;
  canonicalError: unknown;
  canonicalSettled: boolean;
  canonicalState: CanonicalSessionState | null;
  contactsSettled: boolean;
  desktopChatSettled: boolean;
  messagesSettled: boolean;
  refreshCanonicalState: RefreshAction;
  refreshCloudContacts: RefreshAction;
  refreshCloudMessages: RefreshAction;
  resetCanonicalRefresh: () => void;
};

export function useKordiCloudInitialSyncState({
  accountId,
  cachedMessagesReady,
  canonicalError,
  canonicalSettled,
  canonicalState,
  contactsSettled,
  desktopChatSettled,
  messagesSettled,
  refreshCanonicalState,
  refreshCloudContacts,
  refreshCloudMessages,
  resetCanonicalRefresh,
}: UseKordiCloudInitialSyncStateArgs) {
  const [clock, setClock] = useState(() => {
    const now = Date.now();
    return { accountId, startedAtMs: now, nowMs: now };
  });
  const [completedAccountId, setCompletedAccountId] =
    useState<string | null>(null);
  const accountTransitioning = clock.accountId !== accountId;

  useEffect(() => {
    if (!accountTransitioning) return;
    const resetId = window.setTimeout(() => {
      const now = Date.now();
      setClock({ accountId, startedAtMs: now, nowMs: now });
    }, 0);
    return () => window.clearTimeout(resetId);
  }, [accountId, accountTransitioning]);

  useEffect(() => {
    if (accountTransitioning) return;
    const timeoutId = window.setTimeout(() => {
      setClock((current) => ({
        ...current,
        nowMs: Date.now(),
      }));
    }, CLOUD_INITIAL_SYNC_TIMEOUT_MS + 25);
    return () => window.clearTimeout(timeoutId);
  }, [accountTransitioning, clock.startedAtMs]);

  const retry = useCallback(() => {
    resetCanonicalRefresh();
    const now = Date.now();
    setClock({ accountId, startedAtMs: now, nowMs: now });
    void refreshCanonicalState();
    void refreshCloudContacts();
    void refreshCloudMessages();
  }, [
    accountId,
    refreshCanonicalState,
    refreshCloudContacts,
    refreshCloudMessages,
    resetCanonicalRefresh,
  ]);

  const rawStatus = useMemo(() => {
    return cloudInitialSyncStatus({
      isCloudEdition: true,
      accountReady: Boolean(accountId),
      canonicalSettled,
      canonicalReady: !canonicalError,
      contactsSettled,
      messagesSettled,
      desktopChatSettled,
      localBackupReady:
        cachedMessagesReady
        || canonicalStateHasCloudLocalBackup(canonicalState, accountId),
      startedAtMs: clock.startedAtMs,
      nowMs: clock.nowMs,
    });
  }, [
    accountId,
    cachedMessagesReady,
    canonicalError,
    canonicalSettled,
    canonicalState,
    contactsSettled,
    desktopChatSettled,
    messagesSettled,
    clock.nowMs,
    clock.startedAtMs,
  ]);

  const accountKey = accountId ?? '__pending__';
  useEffect(() => {
    if (
      accountTransitioning
      || rawStatus !== 'ready'
      || completedAccountId === accountKey
    ) {
      return;
    }
    const completeId = window.setTimeout(() => {
      setCompletedAccountId(accountKey);
    }, 0);
    return () => window.clearTimeout(completeId);
  }, [
    accountKey,
    accountTransitioning,
    completedAccountId,
    rawStatus,
  ]);

  const status = accountTransitioning
    ? 'syncing'
    : completedAccountId === accountKey
      ? 'ready'
      : rawStatus;
  return { status, onRetry: retry };
}
