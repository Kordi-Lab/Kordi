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
  reconciledMessageMirrors: Array<{
    preferredMessageId: string;
    duplicateMessageId: string;
  }>;
};

const MESSAGE_REFERENCE_KEYS = new Set([
  'replyToMessageId',
  'requestId',
  'requestMessageId',
  'sourceMessageId',
  'sessionTitleGeneratedFromMessageId',
  'forkedFromMessageId',
]);
const MESSAGE_REFERENCE_ARRAY_KEYS = new Set([
  'forkedFromMessageAliases',
]);

function replaceMessageReference(
  value: unknown,
  duplicateMessageId: string,
  preferredMessageId: string,
  key = '',
): unknown {
  if (typeof value === 'string') {
    return MESSAGE_REFERENCE_KEYS.has(key) && value === duplicateMessageId
      ? preferredMessageId
      : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const replaced = value.map((entry) => {
      const next = MESSAGE_REFERENCE_ARRAY_KEYS.has(key)
        && entry === duplicateMessageId
        ? preferredMessageId
        : replaceMessageReference(
            entry,
            duplicateMessageId,
            preferredMessageId,
          );
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? replaced : value;
  }
  if (!value || typeof value !== 'object') return value;
  let changed = false;
  const replaced = Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => {
    const next = replaceMessageReference(
      entry,
      duplicateMessageId,
      preferredMessageId,
      entryKey,
    );
    if (next !== entry) changed = true;
    return [entryKey, next];
  }));
  return changed ? replaced : value;
}

function reconcileMessageMirrorInLocalState(
  current: CanonicalSessionState,
  preferredMessageId: string,
  duplicateMessageId: string,
): CanonicalSessionState {
  const now = Date.now();
  return {
    ...current,
    sessions: current.sessions.map((session) => {
      const metadata = replaceMessageReference(
        session.metadata,
        duplicateMessageId,
        preferredMessageId,
      );
      return metadata === session.metadata
        ? session
        : { ...session, metadata };
    }),
    participants: current.participants.map((participant) => (
      participant.lastReadMessageId === duplicateMessageId
        ? { ...participant, lastReadMessageId: preferredMessageId }
        : participant
    )),
    messages: current.messages.flatMap((message) => {
      if (message.id === duplicateMessageId) return [];
      const parentMessageId = message.parentMessageId === duplicateMessageId
        ? preferredMessageId
        : message.parentMessageId;
      const content = replaceMessageReference(
        message.content,
        duplicateMessageId,
        preferredMessageId,
      );
      if (
        parentMessageId === message.parentMessageId
        && content === message.content
      ) return [message];
      return [{
        ...message,
        parentMessageId,
        content,
        ...(content === message.content ? {} : { contentHash: null }),
      }];
    }),
    delegatedExchanges: current.delegatedExchanges.map((exchange) => {
      const triggerMessageId = exchange.triggerMessageId === duplicateMessageId
        ? preferredMessageId
        : exchange.triggerMessageId;
      const requestMessageId = exchange.requestMessageId === duplicateMessageId
        ? preferredMessageId
        : exchange.requestMessageId;
      const responseMessageId = exchange.responseMessageId === duplicateMessageId
        ? preferredMessageId
        : exchange.responseMessageId;
      return triggerMessageId === exchange.triggerMessageId
        && requestMessageId === exchange.requestMessageId
        && responseMessageId === exchange.responseMessageId
        ? exchange
        : {
            ...exchange,
            triggerMessageId,
            requestMessageId,
            responseMessageId,
          };
    }),
    contextSnapshots: current.contextSnapshots.map((snapshot) => (
      snapshot.uptoMessageId === duplicateMessageId
        ? {
            ...snapshot,
            uptoMessageId: preferredMessageId,
            invalidatedAtMs: snapshot.invalidatedAtMs ?? now,
          }
        : snapshot
    )),
  };
}

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
  for (const reconciliation of batch.reconciledMessageMirrors) {
    if (!next) break;
    next = reconcileMessageMirrorInLocalState(
      next,
      reconciliation.preferredMessageId,
      reconciliation.duplicateMessageId,
    );
  }
  return next;
}
