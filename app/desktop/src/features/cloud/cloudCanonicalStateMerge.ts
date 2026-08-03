import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
  OpenCanonicalSessionFastResult,
} from '@/kordi-app/types';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import {
  canonicalArraysEqual,
  canonicalIdentitiesEqual,
  canonicalJsonValuesEqual,
} from '@/features/canonical/canonicalEquality';

export type CloudSelfAgentCanonicalSyncBatch = {
  identity: CanonicalIdentity;
  sessions: OpenCanonicalSessionFastResult[];
  messages: CanonicalSessionMessage[];
};

export function upsertCanonicalIdentityIntoLocalState(
  current: CanonicalSessionState | null,
  identity: CanonicalIdentity,
): CanonicalSessionState | null {
  if (!current) return current;
  const existing = current.identities.find(
    (candidate) => candidate.id === identity.id,
  );
  if (existing && canonicalIdentitiesEqual(existing, identity)) return current;
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
  const existingSession = current.sessions.find(
    (session) => session.id === result.session.id,
  );
  const existingParticipants = current.participants.filter(
    (participant) => participant.sessionId === result.session.id,
  );
  if (
    existingSession
    && canonicalJsonValuesEqual(existingSession, result.session)
    && canonicalArraysEqual(
      existingParticipants,
      result.participants,
      canonicalJsonValuesEqual,
    )
  ) {
    return current;
  }
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

export function mergeCloudSelfAgentCanonicalSyncBatch(
  current: CanonicalSessionState | null,
  batch: CloudSelfAgentCanonicalSyncBatch,
): CanonicalSessionState | null {
  let next = upsertCanonicalIdentityIntoLocalState(
    current,
    batch.identity,
  );
  for (const session of batch.sessions) {
    next = mergeOpenCanonicalSessionFastResultIntoLocalState(
      next,
      session,
    );
  }
  for (const message of batch.messages) {
    next = mergeCanonicalMessageRow(next, message);
  }
  return next;
}
