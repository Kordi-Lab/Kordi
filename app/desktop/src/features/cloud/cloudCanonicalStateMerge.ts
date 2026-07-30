import type {
  CanonicalIdentity,
  CanonicalSessionState,
  OpenCanonicalSessionFastResult,
} from '@/kordi-app/types';

export function upsertCanonicalIdentityIntoLocalState(
  current: CanonicalSessionState | null,
  identity: CanonicalIdentity,
): CanonicalSessionState | null {
  if (!current) return current;
  return {
    ...current,
    identities: [
      ...current.identities.filter(
        (candidate) => candidate.id !== identity.id,
      ),
      identity,
    ],
  };
}

export function mergeOpenCanonicalSessionFastResultIntoLocalState(
  current: CanonicalSessionState | null,
  result: OpenCanonicalSessionFastResult,
): CanonicalSessionState | null {
  if (!current) return current;
  return {
    ...current,
    sessions: [
      result.session,
      ...current.sessions.filter(
        (session) => session.id !== result.session.id,
      ),
    ],
    participants: [
      ...current.participants.filter(
        (participant) =>
          participant.sessionId !== result.session.id,
      ),
      ...result.participants,
    ],
  };
}
