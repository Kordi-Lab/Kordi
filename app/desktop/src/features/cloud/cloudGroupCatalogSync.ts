import type { ChatSyncConversation } from './chatSyncTypes';
import { cloudGroupCatalogRow } from './cloudGroupCatalog';

const CLOUD_GROUP_CATALOG_SYNC_EVENT = 'kordi-cloud-group-catalog-sync';
type CatalogDetail = { accountId: string; conversations: ChatSyncConversation[] };

/** Publish only after the account's sync batch has been committed locally. */
export function publishCloudGroupCatalog(
  accountId: string,
  conversations: ChatSyncConversation[],
): void {
  const groups = conversations.filter(conversation => conversation.kind === 'group');
  if (typeof window === 'undefined' || groups.length === 0) return;
  window.dispatchEvent(new CustomEvent<CatalogDetail>(CLOUD_GROUP_CATALOG_SYNC_EVENT, {
    detail: { accountId, conversations: groups },
  }));
}

export function subscribeCloudGroupCatalog({
  accountId,
  hasSession,
  rememberConversations,
  applyRow,
  reportError,
}: {
  accountId: string;
  hasSession: (sessionId: string) => boolean;
  rememberConversations: (conversations: ChatSyncConversation[]) => void;
  applyRow: (row: NonNullable<ReturnType<typeof cloudGroupCatalogRow>>) => Promise<void>;
  reportError: (error: unknown) => void;
}): () => void {
  let active = true;
  let pending = Promise.resolve();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<CatalogDetail>).detail;
    if (detail.accountId !== accountId) return;
    rememberConversations(detail.conversations);
    // Serialize batches so duplicate snapshots cannot race session creation.
    pending = pending.then(async () => {
      for (const conversation of detail.conversations) {
        if (!active) return;
        const row = cloudGroupCatalogRow(conversation, accountId);
        if (!row || hasSession(row.envelope.groupId)) continue;
        try {
          await applyRow(row);
        } catch (error) {
          if (active) reportError(error);
        }
      }
    });
  };
  window.addEventListener(CLOUD_GROUP_CATALOG_SYNC_EVENT, listener);
  return () => {
    active = false;
    window.removeEventListener(CLOUD_GROUP_CATALOG_SYNC_EVENT, listener);
  };
}
