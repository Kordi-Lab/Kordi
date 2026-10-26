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

/** Replaces the signed-in owner's personal agents; an equal list keeps the current snapshot. */
export function setPersonalAgentEntries(next: readonly PersonalAgentEntry[]) {
  const normalized = next.length ? next : EMPTY;
  if (sameEntries(snapshot, normalized)) return;
  snapshot = normalized;
  for (const listener of listeners) listener();
}

export function subscribePersonalAgentEntries(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePersonalAgentEntries(): readonly PersonalAgentEntry[] {
  return useSyncExternalStore(subscribePersonalAgentEntries, getPersonalAgentEntries, getPersonalAgentEntries);
}

/** The personal agent a conversation is the session of, if any. */
export function usePersonalAgentForConversation(conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'metadata'> | null | undefined) {
  return personalAgentEntryForConversation(usePersonalAgentEntries(), conversation);
}

/**
 * Whether a session is a personal session: its marker, or its id in the
 * server list, whether or not its agent is loaded yet.
 */
export function isPersonalAgentSession(sessionId: string | null | undefined, metadata?: unknown) {
  const id = sessionId?.trim();
  return Boolean(personalAgentMarker(metadata)
    || (id && snapshot.some((entry) => entry.sessionId === id || entry.conversationId === id)));
}
