import type { ParticipantSpaceSessionViewModel } from '@/kordi-app/types';

export type SessionWithLineage = Pick<
  ParticipantSpaceSessionViewModel,
  'id' | 'forkedFromSessionId' | 'forkedFromMessageId'
>;

export function isGroupSessionId(value: string | null | undefined): boolean {
  return value?.trim().startsWith('session:group:') ?? false;
}

export function isGroupForkSession(session: { forkedFromSessionId?: string | null }): boolean {
  return isGroupSessionId(session.forkedFromSessionId);
}

export type ForkLineage<S extends SessionWithLineage> = {
  /** Set of session ids that are themselves forks (so they should be
   * rendered nested under their parent rather than at the top level). */
  forkSessionIds: Set<string>;
  /** Map from a parent session id → its fork children, ordered by
   * the original input order of the session list. */
  forksByParentSessionId: Map<string, S[]>;
  /** Map from a parent session id → map of source message entry id →
   * fork children anchored at that entry. Lets the transcript render
   * a per-message "N forks" chip. */
  forksByParentMessageIdBySession: Map<string, Map<string, S[]>>;
};

/** Build a one-shot fork lineage view from a flat list of sessions.
 *
 * Cycles are guarded against by simply trusting the
 * `forkedFromSessionId` chain — sessions with a missing parent are
 * treated as top-level even if they claim a fork lineage. */
export function buildForkLineage<S extends SessionWithLineage>(sessions: readonly S[]): ForkLineage<S> {
  const knownIds = new Set(sessions.map((session) => session.id));
  const forkSessionIds = new Set<string>();
  const forksByParentSessionId = new Map<string, S[]>();
  const forksByParentMessageIdBySession = new Map<string, Map<string, S[]>>();

  for (const session of sessions) {
    const parentId = session.forkedFromSessionId?.trim();
    if (!parentId || !knownIds.has(parentId)) continue;
    forkSessionIds.add(session.id);

    const siblings = forksByParentSessionId.get(parentId);
    if (siblings) {
      siblings.push(session);
    } else {
      forksByParentSessionId.set(parentId, [session]);
    }

    const messageId = session.forkedFromMessageId?.trim();
    if (!messageId) continue;
    let perMessage = forksByParentMessageIdBySession.get(parentId);
    if (!perMessage) {
      perMessage = new Map<string, S[]>();
      forksByParentMessageIdBySession.set(parentId, perMessage);
    }
    const anchored = perMessage.get(messageId);
    if (anchored) {
      anchored.push(session);
    } else {
      perMessage.set(messageId, [session]);
    }
  }

  return { forkSessionIds, forksByParentSessionId, forksByParentMessageIdBySession };
}
