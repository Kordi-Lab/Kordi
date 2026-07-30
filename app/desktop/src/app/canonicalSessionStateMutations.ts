import type {
  CanonicalIdentity,
  CanonicalSessionState,
  OpenCanonicalSessionFastResult,
} from '@/kordi-app/types';

export function mergeCanonicalIdentity(
  state: CanonicalSessionState,
  identity: CanonicalIdentity,
): CanonicalSessionState {
  return {
    ...state,
    identities: [
      ...state.identities.filter((current) => current.id !== identity.id),
      identity,
    ],
  };
}

export function mergeOpenCanonicalSessionResult(
  state: CanonicalSessionState,
  result: OpenCanonicalSessionFastResult,
): CanonicalSessionState {
  return {
    ...state,
    sessions: [
      result.session,
      ...state.sessions.filter((session) => session.id !== result.session.id),
    ],
    participants: [
      ...state.participants.filter(
        (participant) => participant.sessionId !== result.session.id,
      ),
      ...result.participants,
    ],
  };
}
