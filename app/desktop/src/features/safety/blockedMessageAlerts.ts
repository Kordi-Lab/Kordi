// Message alerts skip blocked accounts. The notification hooks run above the
// safety provider, so they read the block store for the signed-in account
// directly; the provider keeps that store loaded.

import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { Message } from '@/kordi-app/types';

import { isMessageFromBlockedAccount } from './blockedMessageAuthor';
import { cloudBlocksSnapshot, subscribeCloudBlocks } from './useCloudBlocks';

const NO_BLOCKS: ReadonlySet<string> = new Set();

/** The accounts the signed-in person blocked, or an empty set when signed out. */
export function useBlockedAccountIdSet(accountId: string | null | undefined): ReadonlySet<string> {
  const id = accountId?.trim() || null;
  const subscribe = useCallback((listener: () => void) => (id ? subscribeCloudBlocks(id, listener) : () => undefined), [id]);
  const getSnapshot = useCallback(() => cloudBlocksSnapshot(id), [id]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(
    () => (snapshot.blocks.length ? new Set(snapshot.blocks.map((block) => block.accountId)) : NO_BLOCKS),
    [snapshot.blocks],
  );
}

/** Whether a new message should stay silent: no banner, sound, or Dock bounce. */
export function messageAlertSuppressed(message: Message, blockedAccountIds: ReadonlySet<string>): boolean {
  return isMessageFromBlockedAccount(message, blockedAccountIds);
}
