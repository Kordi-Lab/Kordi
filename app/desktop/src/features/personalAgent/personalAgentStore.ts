import { useSyncExternalStore } from 'react';
import type { Conversation } from '@/kordi-app/types';
import type { PersonalAgentSession } from './personalAgentClient';
import { personalAgentEntryForConversation, personalAgentMarker } from './personalAgentEntries';

/** A personal session joined with the local agent that owns it, ready for the sidebar and header. */
export type PersonalAgentEntry = PersonalAgentSession & {
  name: string;
  /** The local agent id, used to open the agent's Blueprint; null while the agent list does not hold it. */
  localAgentId: string | null;
  avatarSeed: string;
  profileImageUrl: string | null;
  isDefault: boolean;
};

const EMPTY: readonly PersonalAgentEntry[] = [];
let snapshot: readonly PersonalAgentEntry[] = EMPTY;
/**
 * Whether the entries come from a loaded list (the server's, or this Mac's
 * cached snapshots until it loads). Before that, a session's own marker is
 * the only sign of a personal session.
 */
let listLoaded = false;
const listeners = new Set<() => void>();

function sameEntries(left: readonly PersonalAgentEntry[], right: readonly PersonalAgentEntry[]) {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined && (Object.keys(entry) as Array<keyof PersonalAgentEntry>)
      .every((key) => entry[key] === other?.[key]);
  });
}

export function getPersonalAgentEntries(): readonly PersonalAgentEntry[] {
  return snapshot;
}

export function isPersonalAgentListLoaded() {
  return listLoaded;
}

/**
 * Replaces the signed-in owner's personal agents (only agents with Proactive
 * on are listed); an equal list keeps the current snapshot. `loaded` is false
 * while no list has loaded yet.
 */
export function setPersonalAgentEntries(next: readonly PersonalAgentEntry[], loaded = next.length > 0) {
  const normalized = next.length ? next : EMPTY;
  if (sameEntries(snapshot, normalized) && listLoaded === loaded) return;
  snapshot = normalized;
  listLoaded = loaded;
  for (const listener of listeners) listener();
}

export function subscribePersonalAgentEntries(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePersonalAgentEntries(): readonly PersonalAgentEntry[] {
  return useSyncExternalStore(subscribePersonalAgentEntries, getPersonalAgentEntries, getPersonalAgentEntries);
}

export function usePersonalAgentListLoaded(): boolean {
  return useSyncExternalStore(subscribePersonalAgentEntries, isPersonalAgentListLoaded, isPersonalAgentListLoaded);
}

/** The personal agent a conversation is the session of, if any. */
export function usePersonalAgentForConversation(conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'metadata'> | null | undefined) {
  const entries = usePersonalAgentEntries();
  const loaded = usePersonalAgentListLoaded();
  return personalAgentEntryForConversation(entries, conversation, { markerFallback: !loaded });
}

/**
 * Whether a session is a personal session: its id in the current list, or,
 * until a list has loaded, its own marker.
 */
export function isPersonalAgentSession(sessionId: string | null | undefined, metadata?: unknown) {
  const id = sessionId?.trim();
  return Boolean((id && snapshot.some((entry) => entry.sessionId === id || entry.conversationId === id))
    || (!listLoaded && personalAgentMarker(metadata)));
}

const refreshListeners = new Set<() => void>();

/** Asks the sync to load the list again now, e.g. right after Proactive changed. */
export function requestPersonalAgentsRefresh() {
  for (const listener of refreshListeners) listener();
}

export function subscribePersonalAgentsRefresh(listener: () => void) {
  refreshListeners.add(listener);
  return () => { refreshListeners.delete(listener); };
}
