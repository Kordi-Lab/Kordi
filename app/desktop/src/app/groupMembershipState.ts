import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import type {
  CanonicalGroupMembershipDelta,
  CanonicalSessionParticipant,
  CanonicalSessionState,
} from '@/kordi-app/types';

import { canonicalGroupParticipantsForSession } from './useKordiAppModelHelpers';

export function canonicalGroupParticipantsForSessions(
  state: CanonicalSessionState,
  sessionIds: string[],
) {
  type Participant = ReturnType<
    typeof canonicalGroupParticipantsForSession
  >[number];
  const participantByIdentityId = new Map<string, Participant>();
  for (const sessionId of sessionIds) {
    for (
      const participant
      of canonicalGroupParticipantsForSession(state, sessionId)
    ) {
      const existing = participantByIdentityId.get(participant.id);
      participantByIdentityId.set(participant.id, existing ? {
        ...existing,
        role: existing.role === 'self' || participant.role !== 'admin'
          ? existing.role
          : 'admin',
        humanId: existing.humanId || participant.humanId,
        sourceIdentityId:
          existing.sourceIdentityId || participant.sourceIdentityId,
        sourceHostId: existing.sourceHostId || participant.sourceHostId,
        avatarKey: existing.avatarKey || participant.avatarKey,
        profileImageUrl:
          existing.profileImageUrl ?? participant.profileImageUrl,
      } : participant);
    }
  }
  return [...participantByIdentityId.values()];
}

export function mergeCanonicalGroupMembershipDelta(
  state: CanonicalSessionState,
  delta: CanonicalGroupMembershipDelta,
): CanonicalSessionState {
  const changedSessionIds = new Set(
    delta.sessions.map((session) => session.id),
  );
  const changedSessionById = new Map(
    delta.sessions.map((session) => [session.id, session]),
  );
  const existingSessionIds = new Set(
    state.sessions.map((session) => session.id),
  );
  let nextState: CanonicalSessionState = {
    ...state,
    sessions: [
      ...state.sessions.map(
        (session) => changedSessionById.get(session.id) ?? session,
      ),
      ...delta.sessions.filter(
        (session) => !existingSessionIds.has(session.id),
      ),
    ],
    participants: [
      ...state.participants.filter(
        (participant) => !changedSessionIds.has(participant.sessionId),
      ),
      ...delta.participants,
    ],
  };
  delta.messages.forEach((message) => {
    nextState = mergeCanonicalMessageRow(nextState, message) ?? nextState;
  });
  return nextState;
}

export function stageCanonicalGroupMembership(
  state: CanonicalSessionState,
  sessions: Array<{ sessionId: string; metadata: unknown }>,
  identityIds: string[],
  addedByIdentityId: string,
): CanonicalSessionState {
  const sessionMetadata = new Map(
    sessions.map((session) => [session.sessionId, session.metadata]),
  );
  const now = Date.now();
  const stagedParticipants: CanonicalSessionParticipant[] =
    sessions.flatMap(({ sessionId }) => (
      identityIds.map((identityId) => ({
        sessionId,
        identityId,
        role: 'person',
        state: 'active',
        addedByIdentityId,
        addedAtMs: now,
        lastSeenAtMs: null,
        lastReadMessageId: null,
        lastReadSequenceNum: null,
        metadata: null,
      }))
    ));
  const stagedParticipantKeys = new Set(
    stagedParticipants.map(
      (participant) =>
        `${participant.sessionId}\u0000${participant.identityId}`,
    ),
  );
  return {
    ...state,
    sessions: state.sessions.map((session) => (
      sessionMetadata.has(session.id)
        ? { ...session, metadata: sessionMetadata.get(session.id) }
        : session
    )),
    participants: [
      ...state.participants.filter(
        (participant) => !stagedParticipantKeys.has(
          `${participant.sessionId}\u0000${participant.identityId}`,
        ),
      ),
      ...stagedParticipants,
    ],
  };
}
