import { useEffect, useState } from 'react';

import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';
import { loadChatSyncConversations } from '@/lib/desktopChatSync';

import type { MemoryClient } from './memoryClient';

const GROUP_SESSION_PREFIX = 'session:group:';

type MaybeId = string | null | undefined;

export type CloudConversationRow = Pick<ChatSyncConversation, 'id' | 'kind' | 'legacy_session_id'>;

/** Loads the chat sync conversations of an account; each row maps a client session id to its cloud id. */
export type CloudConversationLoader = (accountId: string) => Promise<readonly CloudConversationRow[]>;

/** The cloud conversation ids of the group conversations whose client session id is one of `sessionIds`. */
export function cloudGroupConversationIds(
  rows: readonly CloudConversationRow[],
  sessionIds: readonly MaybeId[],
): string[] {
  const wanted = new Set(sessionIds.map((id) => id?.trim() ?? '').filter(Boolean));
  return [...new Set(rows
    .filter((row) => row.kind === 'group' && wanted.has(row.legacy_session_id?.trim() ?? ''))
    .map((row) => row.id.trim())
    .filter(Boolean))];
}

function isGroupSession(sessionIds: readonly MaybeId[]): boolean {
  return sessionIds.some((id) => id?.trim().startsWith(GROUP_SESSION_PREFIX));
}

const rowsByLoader = new WeakMap<CloudConversationLoader, Map<string, Promise<readonly CloudConversationRow[]>>>();

function loadRows(load: CloudConversationLoader, accountId: string, refresh: boolean) {
  let rowsByAccount = rowsByLoader.get(load);
  if (!rowsByAccount) {
    rowsByAccount = new Map();
    rowsByLoader.set(load, rowsByAccount);
  }
  const cached = rowsByAccount.get(accountId);
  if (cached && !refresh) return cached;
  const next = load(accountId).catch(() => [] as const);
  rowsByAccount.set(accountId, next);
  return next;
}

async function lookup(client: MemoryClient, load: CloudConversationLoader, sessionIds: readonly MaybeId[]) {
  const accountId = (await client.viewerAccountId?.().catch(() => null))?.trim();
  if (!accountId) return [];
  const cached = cloudGroupConversationIds(await loadRows(load, accountId, false), sessionIds);
  // A group created after the last load is missing from the cached rows.
  return cached.length > 0 ? cached : cloudGroupConversationIds(await loadRows(load, accountId, true), sessionIds);
}

/**
 * The cloud group conversation ids of a group chat, or `null` while they load.
 * Other chats resolve to an empty list at once.
 */
export function useCloudGroupConversationIds(
  client: MemoryClient,
  sessionIds: readonly MaybeId[],
  load: CloudConversationLoader = loadChatSyncConversations,
): string[] | null {
  const key = sessionIds.map((id) => id?.trim() ?? '').join('\n');
  const isGroup = isGroupSession(sessionIds);
  const [resolved, setResolved] = useState<{ key: string; ids: string[] } | null>(null);

  useEffect(() => {
    if (!isGroup) return undefined;
    let active = true;
    void lookup(client, load, key.split('\n')).then((ids) => {
      if (active) setResolved({ key, ids });
    });
    return () => { active = false; };
  }, [client, isGroup, key, load]);

  if (!isGroup) return [];
  return resolved?.key === key ? resolved.ids : null;
}
