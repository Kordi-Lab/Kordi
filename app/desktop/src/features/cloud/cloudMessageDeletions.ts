import { loadChatSyncDeletedMessageIds } from '@/lib/desktopChatSync';
import type { CloudMessage } from './authClient';

const EMPTY_IDS: ReadonlySet<string> = new Set();

// Markers contain identifiers only and are scoped to the viewer. Native SQLite
// owns persistence; this cache also protects responses already in flight.
export class CloudMessageDeletions {
  private readonly byAccount = new Map<string, Set<string>>();
  private readonly loads = new Map<string, Promise<void>>();

  constructor(private readonly load = loadChatSyncDeletedMessageIds) {}

  ids(accountId: string | null): ReadonlySet<string> {
    return accountId ? this.byAccount.get(accountId) ?? EMPTY_IDS : EMPTY_IDS;
  }

  remember(accountId: string | null, ids: readonly string[]): void {
    if (!accountId || ids.length === 0) return;
    const removed = this.byAccount.get(accountId) ?? new Set<string>();
    for (const id of ids) if (id.trim()) removed.add(id.trim());
    this.byAccount.set(accountId, removed);
  }

  async ready(accountId: string | null): Promise<void> {
    if (!accountId) return;
    let pending = this.loads.get(accountId);
    if (!pending) {
      pending = this.load(accountId).then((ids) => {
        this.remember(accountId, ids);
      }).catch((error) => {
        this.loads.delete(accountId);
        throw error;
      });
      this.loads.set(accountId, pending);
    }
    await pending;
  }

  filter(accountId: string | null, messagesByPeer: Record<string, CloudMessage[]>): Record<string, CloudMessage[]> {
    const removed = this.ids(accountId);
    if (removed.size === 0) return messagesByPeer;
    let changed = false;
    const next = Object.fromEntries(Object.entries(messagesByPeer).map(([peer, messages]) => {
      const kept = messages.filter((message) => !removed.has(message.messageId));
      changed ||= kept.length !== messages.length;
      return [peer, kept.length === messages.length ? messages : kept];
    }));
    return changed ? next : messagesByPeer;
  }
}

export const cloudMessageDeletions = new CloudMessageDeletions();
