import type {
  CanonicalMessageDeliveryDelta,
  CanonicalProfileIdentityDelta,
  CanonicalReadCursorDelta,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import {
  canonicalIdentitiesEqual,
  canonicalMessagesEqual,
  canonicalProfilesEqual,
} from './canonicalEquality';
import { canApplyCloudAgentTurnTransition } from './cloudAgentTurnLifecycle';

function mapPreservingArray<T>(items: T[], mapItem: (item: T) => T): T[] {
  let changed = false;
  const mapped = items.map((item) => {
    const next = mapItem(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? mapped : items;
}

function rewriteExactJsonIdentityReference(
  value: unknown,
  previousIdentityId: string,
  stableIdentityId: string,
): unknown {
  if (typeof value === 'string') {
    return value === previousIdentityId ? stableIdentityId : value;
  }
  if (Array.isArray(value)) {
    let rewritten: unknown[] | null = null;
    value.forEach((item, index) => {
      const nextItem = rewriteExactJsonIdentityReference(item, previousIdentityId, stableIdentityId);
      if (nextItem === item) return;
      rewritten ??= value.slice();
      rewritten[index] = nextItem;
    });
    return rewritten ?? value;
  }
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  let rewritten: Record<string, unknown> | null = null;
  Object.entries(record).forEach(([key, item]) => {
    const nextItem = rewriteExactJsonIdentityReference(item, previousIdentityId, stableIdentityId);
    if (nextItem === item) return;
    rewritten ??= { ...record };
    rewritten[key] = nextItem;
  });
  return rewritten ?? value;
}

export function applyCanonicalProfileIdentityDelta(
  state: CanonicalSessionState | null,
  delta: CanonicalProfileIdentityDelta | null,
): CanonicalSessionState | null {
  if (!state || !delta) return state;

  const stableIdentityId = delta.identity.id;
  const previousIdentityId = delta.previousIdentityId?.trim() || null;
  const shouldMigrate = Boolean(previousIdentityId && previousIdentityId !== stableIdentityId);
  const rewriteIdentityId = (identityId: string | null | undefined) => (
    shouldMigrate && identityId === previousIdentityId ? stableIdentityId : identityId
  );
  const rewriteJson = (value: unknown) => (
    shouldMigrate && previousIdentityId
      ? rewriteExactJsonIdentityReference(value, previousIdentityId, stableIdentityId)
      : value
  );

  const rewriteIdentity = (identity: CanonicalSessionState['identities'][number]) => {
    const ownerIdentityId = rewriteIdentityId(identity.ownerIdentityId);
    const metadata = rewriteJson(identity.metadata);
    return ownerIdentityId === identity.ownerIdentityId && metadata === identity.metadata
      ? identity
      : { ...identity, ownerIdentityId, metadata };
  };
  const rewrittenAdoptedIdentity = rewriteIdentity(delta.identity);
  const existingStableIdentity = state.identities.find(
    (identity) => identity.id === stableIdentityId,
  );
  const adoptedIdentity = existingStableIdentity
    && canonicalIdentitiesEqual(existingStableIdentity, rewrittenAdoptedIdentity)
    ? existingStableIdentity
    : rewrittenAdoptedIdentity;
  let identitiesChanged = false;
  let stableIdentityInserted = false;
  const identities: CanonicalSessionState['identities'] = [];
  state.identities.forEach((identity) => {
    if (identity.id === stableIdentityId) {
      if (stableIdentityInserted) {
        identitiesChanged = true;
        return;
      }
      stableIdentityInserted = true;
      identities.push(adoptedIdentity);
      if (adoptedIdentity !== identity) identitiesChanged = true;
      return;
    }
    const rewritten = rewriteIdentity(identity);
    identities.push(rewritten);
    if (rewritten !== identity) identitiesChanged = true;
  });
  if (!stableIdentityInserted) {
    identities.push(adoptedIdentity);
    identitiesChanged = true;
  }
  const nextIdentities = identitiesChanged ? identities : state.identities;

  const sessions = mapPreservingArray(state.sessions, (session) => {
    const createdByIdentityId = rewriteIdentityId(session.createdByIdentityId) ?? session.createdByIdentityId;
    const primaryIdentityId = rewriteIdentityId(session.primaryIdentityId);
    const relationshipIdentityId = rewriteIdentityId(session.relationshipIdentityId);
    const metadata = rewriteJson(session.metadata);
    return createdByIdentityId === session.createdByIdentityId
      && primaryIdentityId === session.primaryIdentityId
      && relationshipIdentityId === session.relationshipIdentityId
      && metadata === session.metadata
      ? session
      : {
          ...session,
          createdByIdentityId,
          primaryIdentityId,
          relationshipIdentityId,
          metadata,
        };
  });

  const groupSelfSessionIds = new Set(delta.groupSelfSessionIds);
  const sessionsWithStableParticipant = new Set(
    state.participants
      .filter((participant) => participant.identityId === stableIdentityId)
      .map((participant) => participant.sessionId),
  );
  const sessionsWithPreviousParticipant = new Set(
    shouldMigrate
      ? state.participants
          .filter((participant) => participant.identityId === previousIdentityId)
          .map((participant) => participant.sessionId)
      : [],
  );
  let participantsChanged = false;
  const participants: CanonicalSessionState['participants'] = [];
  state.participants.forEach((participant) => {
    if (
      shouldMigrate
      && participant.identityId === previousIdentityId
      && sessionsWithStableParticipant.has(participant.sessionId)
    ) {
      participantsChanged = true;
      return;
    }

    const identityId = rewriteIdentityId(participant.identityId) ?? participant.identityId;
    const addedByIdentityId = rewriteIdentityId(participant.addedByIdentityId);
    const metadata = rewriteJson(participant.metadata);
    const isStableParticipant = identityId === stableIdentityId;
    const shouldActivateStableParticipant = isStableParticipant && (
      participant.state === 'active' || sessionsWithPreviousParticipant.has(participant.sessionId)
    );
    const role = shouldActivateStableParticipant
      ? 'self'
      : !isStableParticipant
        && groupSelfSessionIds.has(participant.sessionId)
        && participant.role === 'self'
        ? 'person'
        : participant.role;
    const participantState = shouldActivateStableParticipant ? 'active' : participant.state;
    const rewritten = identityId === participant.identityId
      && addedByIdentityId === participant.addedByIdentityId
      && metadata === participant.metadata
      && role === participant.role
      && participantState === participant.state
      ? participant
      : {
          ...participant,
          identityId,
          role,
          state: participantState,
          addedByIdentityId,
          metadata,
        };
    participants.push(rewritten);
    if (rewritten !== participant) participantsChanged = true;
  });
  if (shouldMigrate && sessionsWithPreviousParticipant.size > 0) {
    participants.sort((left, right) => {
      if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
      if (left.addedAtMs !== right.addedAtMs) return left.addedAtMs - right.addedAtMs;
      if (left.identityId === right.identityId) return 0;
      return left.identityId < right.identityId ? -1 : 1;
    });
  }
  const nextParticipants = participantsChanged ? participants : state.participants;

  const messages = mapPreservingArray(state.messages, (message) => {
    const senderIdentityId = rewriteIdentityId(message.senderIdentityId) ?? message.senderIdentityId;
    const content = rewriteJson(message.content);
    return senderIdentityId === message.senderIdentityId && content === message.content
      ? message
      : { ...message, senderIdentityId, content };
  });

  const delegatedExchanges = mapPreservingArray(state.delegatedExchanges, (exchange) => {
    const initiatorIdentityId = rewriteIdentityId(exchange.initiatorIdentityId) ?? exchange.initiatorIdentityId;
    const targetIdentityId = rewriteIdentityId(exchange.targetIdentityId) ?? exchange.targetIdentityId;
    return initiatorIdentityId === exchange.initiatorIdentityId && targetIdentityId === exchange.targetIdentityId
      ? exchange
      : { ...exchange, initiatorIdentityId, targetIdentityId };
  });

  let presence = state.presence;
  if (shouldMigrate) {
    const filteredPresence = state.presence.filter((row) => row.identityId !== previousIdentityId);
    if (filteredPresence.length !== state.presence.length) presence = filteredPresence;
  }

  const profile = canonicalProfilesEqual(state.profile, delta.profile)
    ? state.profile
    : delta.profile;
  if (
    profile === state.profile
    && nextIdentities === state.identities
    && sessions === state.sessions
    && nextParticipants === state.participants
    && messages === state.messages
    && delegatedExchanges === state.delegatedExchanges
    && presence === state.presence
  ) {
    return state;
  }
  return {
    ...state,
    profile,
    identities: nextIdentities,
    sessions,
    participants: nextParticipants,
    messages,
    delegatedExchanges,
    presence,
  };
}

export function mergeCanonicalReadCursorDelta(
  state: CanonicalSessionState | null,
  delta: CanonicalReadCursorDelta | null,
): CanonicalSessionState | null {
  if (!state || !delta) return state;
  let changed = false;
  const participants = state.participants.map((participant) => {
    if (participant.sessionId !== delta.sessionId || participant.identityId !== delta.identityId) {
      return participant;
    }
    const currentSequenceNum = participant.lastReadSequenceNum ?? null;
    const incomingSequenceNum = delta.lastReadSequenceNum ?? null;
    const sequenceOrder = currentSequenceNum === incomingSequenceNum
      ? 0
      : incomingSequenceNum === null
        ? -1
        : currentSequenceNum === null || incomingSequenceNum > currentSequenceNum
          ? 1
          : -1;
    if (sequenceOrder < 0) return participant;

    const currentLastSeenAtMs = participant.lastSeenAtMs ?? 0;
    if (sequenceOrder === 0 && currentLastSeenAtMs > delta.lastSeenAtMs) return participant;
    const lastSeenAtMs = Math.max(currentLastSeenAtMs, delta.lastSeenAtMs);
    const lastReadMessageId = delta.lastReadMessageId ?? null;
    if (
      lastSeenAtMs === participant.lastSeenAtMs
      && lastReadMessageId === (participant.lastReadMessageId ?? null)
      && incomingSequenceNum === currentSequenceNum
    ) {
      return participant;
    }
    changed = true;
    return {
      ...participant,
      lastSeenAtMs,
      lastReadMessageId,
      lastReadSequenceNum: incomingSequenceNum,
    };
  });
  return changed ? { ...state, participants } : state;
}

export function mergeCanonicalMessageRow(
  state: CanonicalSessionState | null,
  row: CanonicalSessionMessage | null,
): CanonicalSessionState | null {
  return mergeCanonicalMessageRows(state, row ? [row] : []);
}

export function mergeCanonicalMessageRows(
  state: CanonicalSessionState | null,
  rows: readonly CanonicalSessionMessage[],
): CanonicalSessionState | null {
  if (!state || rows.length === 0) return state;
  const indexByMessageId = new Map(
    state.messages.map((message, index) => [message.id, index]),
  );
  let messages: CanonicalSessionMessage[] | null = null;
  const activityBySessionId = new Map<string, {
    updatedAtMs: number;
    lastMessageAtMs: number;
  }>();
  for (const row of rows) {
    const existingIndex = indexByMessageId.get(row.id);
    const existing = existingIndex === undefined
      ? null
      : (messages ?? state.messages)[existingIndex];
    if (
      existing
      && (
        existing.messageKind === 'agent-turn'
        || row.messageKind === 'agent-turn'
      )
      && !canApplyCloudAgentTurnTransition(existing, row)
    ) continue;

    const previousActivity = activityBySessionId.get(row.sessionId);
    activityBySessionId.set(row.sessionId, {
      updatedAtMs: Math.max(
        previousActivity?.updatedAtMs ?? 0,
        row.updatedAtMs,
      ),
      lastMessageAtMs: Math.max(
        previousActivity?.lastMessageAtMs ?? 0,
        row.createdAtMs,
      ),
    });
    if (existing && canonicalMessagesEqual(existing, row)) continue;
    messages ??= state.messages.slice();
    if (existingIndex === undefined) {
      indexByMessageId.set(row.id, messages.length);
      messages.push(row);
    } else {
      messages[existingIndex] = row;
    }
  }
  const sessions = mapPreservingArray(state.sessions, (session) => {
    const activity = activityBySessionId.get(session.id);
    if (!activity) return session;
    const updatedAtMs = Math.max(session.updatedAtMs, activity.updatedAtMs);
    const lastMessageAtMs = Math.max(
      session.lastMessageAtMs ?? 0,
      activity.lastMessageAtMs,
    );
    return updatedAtMs === session.updatedAtMs
      && lastMessageAtMs === session.lastMessageAtMs
      ? session
      : { ...session, updatedAtMs, lastMessageAtMs };
  });
  if (!messages && sessions === state.sessions) return state;
  return {
    ...state,
    sessions,
    messages: messages ?? state.messages,
  };
}

export function mergeCanonicalMessageDeliveryDelta(
  state: CanonicalSessionState | null,
  delta: CanonicalMessageDeliveryDelta | null,
): CanonicalSessionState | null {
  if (!state || !delta) return state;
  const index = state.messages.findIndex((message) => (
    message.id === delta.messageId && message.sessionId === delta.sessionId
  ));
  let messages = state.messages;
  if (index >= 0) {
    const previous = state.messages[index];
    const previousContent = previous.content && typeof previous.content === 'object' && !Array.isArray(previous.content)
      ? previous.content as Record<string, unknown>
      : null;
    const incomingLifecycleRow: CanonicalSessionMessage = {
      ...previous,
      status: delta.status,
      content: {
        ...(previousContent ?? {}),
        deliveryState: delta.deliveryState,
      },
    };
    const canApplyLifecycle = previous.messageKind !== 'agent-turn'
      || canApplyCloudAgentTurnTransition(previous, incomingLifecycleRow);
    if (delta.updatedAtMs >= previous.updatedAtMs && canApplyLifecycle) {
      const arraysEqual = (value: unknown, expected: string[]) => (
        Array.isArray(value)
        && value.length === expected.length
        && value.every((item, itemIndex) => item === expected[itemIndex])
      );
      const contentMatches = previousContent !== null
        && previousContent.deliveryState === delta.deliveryState
        && arraysEqual(previousContent.deliveredRecipientIds, delta.deliveredRecipientIds)
        && arraysEqual(previousContent.pendingRecipientIds, delta.pendingRecipientIds)
        && arraysEqual(previousContent.exhaustedRecipientIds, delta.exhaustedRecipientIds);
      const messageMatches = previous.status === delta.status
        && previous.updatedAtMs === delta.updatedAtMs
        && previous.contentHash === delta.contentHash
        && contentMatches;
      if (!messageMatches) {
        const message: CanonicalSessionMessage = {
          ...previous,
          status: delta.status,
          updatedAtMs: delta.updatedAtMs,
          contentHash: delta.contentHash,
          content: contentMatches
            ? previous.content
            : {
                ...(previousContent ?? {}),
                deliveryState: delta.deliveryState,
                deliveredRecipientIds: delta.deliveredRecipientIds,
                pendingRecipientIds: delta.pendingRecipientIds,
                exhaustedRecipientIds: delta.exhaustedRecipientIds,
              },
        };
        messages = [...state.messages];
        messages[index] = message;
      }
    }
  }

  let sessions = state.sessions;
  const sessionIndex = state.sessions.findIndex((session) => session.id === delta.sessionId);
  if (sessionIndex >= 0) {
    const previous = state.sessions[sessionIndex];
    const updatedAtMs = Math.max(previous.updatedAtMs, delta.sessionUpdatedAtMs);
    const lastMessageAtMs = delta.sessionLastMessageAtMs !== null
      && (previous.lastMessageAtMs == null || delta.sessionLastMessageAtMs > previous.lastMessageAtMs)
      ? delta.sessionLastMessageAtMs
      : previous.lastMessageAtMs;
    if (updatedAtMs !== previous.updatedAtMs || lastMessageAtMs !== previous.lastMessageAtMs) {
      sessions = [...state.sessions];
      sessions[sessionIndex] = { ...previous, updatedAtMs, lastMessageAtMs };
    }
  }

  return messages === state.messages && sessions === state.sessions
    ? state
    : { ...state, messages, sessions };
}
