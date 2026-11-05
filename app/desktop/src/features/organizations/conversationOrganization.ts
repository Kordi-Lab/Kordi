// The team organization that owns a group, read from cached chat-sync
// snapshots. Personal groups and older servers carry no `organization`.
import { useEffect, useSyncExternalStore } from 'react';

import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';
import { CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, loadChatSyncConversations } from '@/lib/desktopChatSync';
import { getOrganizationState, subscribeOrganizationState } from './organizationStore';

type OrganizationSnapshot = Pick<ChatSyncConversation, 'kind' | 'organization'>;

/** The owning team organization's name for a group snapshot, or null. */
export function groupOrganizationName(conversation: OrganizationSnapshot | null | undefined): string | null {
  if (conversation?.kind !== 'group') return null;
  return conversation.organization?.name?.trim() || null;
}

/** Group session ids (client session and conversation id) mapped to their team organization name. */
export function groupOrganizationNames(conversations: ChatSyncConversation[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const conversation of conversations) {
    const name = groupOrganizationName(conversation);
    if (!name) continue;
    names.set(conversation.id, name);
    const sessionId = conversation.legacy_session_id?.trim();
    if (sessionId) names.set(sessionId, name);
  }
  return names;
}

type LabelState = { accountId: string | null; names: Map<string, string> };
let labels: LabelState = { accountId: null, names: new Map() };
let loadRevision = 0;
const listeners = new Set<() => void>();

function publish(next: LabelState): void {
  labels = next;
  listeners.forEach((listener) => listener());
}

async function reloadLabels(accountId: string | null): Promise<void> {
  const revision = ++loadRevision;
  if (!accountId) {
    publish({ accountId: null, names: new Map() });
    return;
  }
  try {
    const names = groupOrganizationNames(await loadChatSyncConversations(accountId));
    if (revision === loadRevision) publish({ accountId, names });
  } catch {
    // Labels are decorative; keep the last known ones.
  }
}

function subscribeLabels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getLabels(): LabelState {
  return labels;
}

let mounted = 0;
let detach: (() => void) | null = null;

function attachLabelSource(): () => void {
  mounted += 1;
  if (mounted === 1 && typeof window !== 'undefined') {
    let accountId = getOrganizationState().accountId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reload = () => { void reloadLabels(accountId); };
    // Local sync state changes with every message; coalesce bursts.
    const scheduleReload = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; reload(); }, 300);
    };
    const unsubscribeAccount = subscribeOrganizationState(() => {
      const next = getOrganizationState().accountId;
      if (next === accountId) return;
      accountId = next;
      reload();
    });
    window.addEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, scheduleReload);
    reload();
    detach = () => {
      unsubscribeAccount();
      window.removeEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, scheduleReload);
      if (timer) clearTimeout(timer);
    };
  }
  return () => {
    mounted -= 1;
    if (mounted === 0) {
      detach?.();
      detach = null;
    }
  };
}

/** The owning team organization's name for a group session, or null. */
export function useGroupOrganizationName(sessionId: string | null | undefined): string | null {
  useEffect(attachLabelSource, []);
  const state = useSyncExternalStore(subscribeLabels, getLabels, getLabels);
  const normalized = sessionId?.trim();
  return normalized ? state.names.get(normalized) ?? null : null;
}
