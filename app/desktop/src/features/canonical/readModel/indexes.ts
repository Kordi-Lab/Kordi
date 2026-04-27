import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionParticipant,
  CanonicalSessionState,
  ConversationParticipant,
  Message,
} from '@/kordi-app/types';

import {
  contentRecord,
  delegationOptimisticFallbackKey,
  delegationTerminalStatus,
  directBridgeSourceEventForOutreachDuplicate,
  mapCanonicalMessage,
  ownerScopedAgentName,
  processingAgentMessage,
  stringValue,
} from './messageMapping';

export type CanonicalIndexes = {
  storagePath: string;
  profileHumanIdentityId?: string | null;
  sessionById: Map<string, CanonicalSessionState['sessions'][number]>;
  identityById: Map<string, CanonicalIdentity>;
  presenceByIdentityId: Map<string, CanonicalSessionState['presence'][number]>;
  participantsBySessionId: Map<string, CanonicalSessionParticipant[]>;
  canonicalParticipantsBySessionId: Map<string, ConversationParticipant[]>;
  canonicalMessagesBySessionId: Map<string, Message[]>;
  rawMessageCountBySessionId: Map<string, number>;
  delegatedExchangeCountBySessionId: Map<string, number>;
  contextSnapshotCountBySessionId: Map<string, number>;
  presenceSummaryBySessionId: Map<string, string>;
};

function emptyIndexes(): CanonicalIndexes {
  return {
    storagePath: '',
    profileHumanIdentityId: null,
    sessionById: new Map(),
    identityById: new Map(),
    presenceByIdentityId: new Map(),
    participantsBySessionId: new Map(),
    canonicalParticipantsBySessionId: new Map(),
    canonicalMessagesBySessionId: new Map(),
    rawMessageCountBySessionId: new Map(),
    delegatedExchangeCountBySessionId: new Map(),
    contextSnapshotCountBySessionId: new Map(),
    presenceSummaryBySessionId: new Map(),
  };
}

export function buildCanonicalIndexes(canonicalState: CanonicalSessionState | null): CanonicalIndexes {
  if (!canonicalState) return emptyIndexes();

  const identityById = new Map(canonicalState.identities.map((identity) => [identity.id, identity]));
  const sessionById = new Map(canonicalState.sessions.map((session) => [session.id, session]));
  const presenceByIdentityId = new Map(canonicalState.presence.map((presence) => [presence.identityId, presence]));

  const participantsBySessionId = new Map<string, CanonicalSessionParticipant[]>();
  for (const participant of canonicalState.participants) {
    participantsBySessionId.set(participant.sessionId, [...(participantsBySessionId.get(participant.sessionId) ?? []), participant]);
  }

  const canonicalParticipantsBySessionId = new Map<string, ConversationParticipant[]>();
  for (const [sessionId, participants] of participantsBySessionId) {
    const details = participants.flatMap((participant) => {
      const identity = identityById.get(participant.identityId);
      if (!identity) return [];
      const presence = presenceByIdentityId.get(identity.id);
      const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : undefined;
      return [{
        id: identity.id,
        name: ownerScopedAgentName(identity, identityById) ?? identity.displayName,
        kind: identity.kind,
        role: participant.role,
        source: identity.source,
        ownerIdentityId: identity.ownerIdentityId,
        ownerName: owner?.displayName ?? null,
        bridgeHostId: identity.sourceHostId,
        bridgeNodeId: identity.bridgeNodeId,
        humanId: identity.humanId,
        agentId: identity.agentId,
        avatarKey: identity.avatarKey,
        profileImageUrl: identity.profileImageUrl,
        presenceStatus: presence?.status ?? null,
        presenceDetail: presence?.detail ?? null,
      }];
    });
    canonicalParticipantsBySessionId.set(sessionId, details);
  }

  const rawMessagesBySessionId = new Map<string, CanonicalSessionMessage[]>();
  for (const message of canonicalState.messages) {
    rawMessagesBySessionId.set(message.sessionId, [...(rawMessagesBySessionId.get(message.sessionId) ?? []), message]);
  }

  const bridgedDelegationFallbackKeys = new Set(
    canonicalState.delegatedExchanges.flatMap((exchange) => {
      if (!exchange.bridgeRequestId) return [];
      const key = delegationOptimisticFallbackKey(exchange);
      return key ? [key] : [];
    }),
  );
  const completedDelegationFallbackKeys = new Set(
    canonicalState.delegatedExchanges.flatMap((exchange) => {
      if (!delegationTerminalStatus(exchange.status)) return [];
      const key = delegationOptimisticFallbackKey(exchange);
      return key ? [key] : [];
    }),
  );
  const processingDelegationMessagesBySessionId = new Map<string, Message[]>();
  for (const exchange of canonicalState.delegatedExchanges) {
    const status = exchange.status.trim().toLowerCase();
    if (!['pending', 'sending', 'processing'].includes(status)) continue;
    if (!exchange.bridgeRequestId) {
      const fallbackKey = delegationOptimisticFallbackKey(exchange);
      if (fallbackKey && (bridgedDelegationFallbackKeys.has(fallbackKey) || completedDelegationFallbackKeys.has(fallbackKey))) continue;
    }
    if (exchange.responseMessageId && rawMessagesBySessionId.get(exchange.sessionId)?.some((message) => message.id === exchange.responseMessageId)) continue;
    const target = identityById.get(exchange.targetIdentityId);
    if (!target || target.kind !== 'agent') continue;
    processingDelegationMessagesBySessionId.set(
      exchange.sessionId,
      [...(processingDelegationMessagesBySessionId.get(exchange.sessionId) ?? []), processingAgentMessage(exchange, target, identityById)],
    );
  }

  const canonicalMessagesBySessionId = new Map<string, Message[]>();
  const rawMessageCountBySessionId = new Map<string, number>();
  for (const [sessionId, messages] of rawMessagesBySessionId) {
    const sortedMessages = [...messages].sort((left, right) => left.createdAtMs - right.createdAtMs || left.sequenceNum - right.sequenceNum);
    const directBridgeSourceEvents = new Set(
      sortedMessages
        .filter((message) => message.sourceTransport === 'desktop-bridge' && message.sourceEventId)
        .map((message) => message.sourceEventId!),
    );
    const delegatedOutreachDirectSources = new Set(
      sortedMessages.flatMap((message) => {
        const directSource = directBridgeSourceEventForOutreachDuplicate(message);
        if (!directSource || !directBridgeSourceEvents.has(directSource)) return [];
        const content = contentRecord(message.content);
        const isDelegatedOutreach = Boolean(message.delegatedExchangeId)
          || Boolean(stringValue(content.delegatedExchangeId))
          || stringValue(content.kind) === 'mention-request';
        return isDelegatedOutreach ? [directSource] : [];
      }),
    );
    const seenJoinEventKeys = new Set<string>();
    rawMessageCountBySessionId.set(sessionId, sortedMessages.length);
    canonicalMessagesBySessionId.set(
      sessionId,
      sortedMessages.flatMap((message) => {
        const content = contentRecord(message.content);
        if (stringValue(content.kind) === 'delegation-join-event') {
          const key = [
            stringValue(content.targetKind) ?? 'target',
            stringValue(content.targetNodeId)
              ?? stringValue(content.targetDisplayName)
              ?? message.senderIdentityId,
            message.parentMessageId ?? message.sourceEventId ?? stringValue(content.requestText) ?? String(message.createdAtMs),
          ].join(':');
          if (seenJoinEventKeys.has(key)) return [];
          seenJoinEventKeys.add(key);
        }
        if (message.sourceTransport === 'desktop-bridge'
          && message.sourceEventId
          && delegatedOutreachDirectSources.has(message.sourceEventId)) {
          return [];
        }
        const duplicatedDirectBridgeSource = directBridgeSourceEventForOutreachDuplicate(message);
        if (duplicatedDirectBridgeSource
          && directBridgeSourceEvents.has(duplicatedDirectBridgeSource)
          && !delegatedOutreachDirectSources.has(duplicatedDirectBridgeSource)) {
          return [];
        }
        const mapped = mapCanonicalMessage(message, identityById, canonicalState.profile.humanIdentityId);
        return mapped ? [mapped] : [];
      }).concat(processingDelegationMessagesBySessionId.get(sessionId) ?? []),
    );
  }

  for (const [sessionId, processingMessages] of processingDelegationMessagesBySessionId) {
    if (!canonicalMessagesBySessionId.has(sessionId)) {
      canonicalMessagesBySessionId.set(sessionId, processingMessages);
      rawMessageCountBySessionId.set(sessionId, 0);
    }
  }

  const delegatedExchangeCountBySessionId = new Map<string, number>();
  for (const exchange of canonicalState.delegatedExchanges) {
    delegatedExchangeCountBySessionId.set(exchange.sessionId, (delegatedExchangeCountBySessionId.get(exchange.sessionId) ?? 0) + 1);
  }

  const contextSnapshotCountBySessionId = new Map<string, number>();
  for (const snapshot of canonicalState.contextSnapshots) {
    contextSnapshotCountBySessionId.set(snapshot.sessionId, (contextSnapshotCountBySessionId.get(snapshot.sessionId) ?? 0) + 1);
  }

  const presenceSummaryBySessionId = new Map<string, string>();
  for (const [sessionId, participants] of canonicalParticipantsBySessionId) {
    const counts = participants.reduce<Record<string, number>>((acc, participant) => {
      const status = participant.presenceStatus?.trim();
      if (!status || status === 'offline') return acc;
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});

    if (Object.keys(counts).length > 0) {
      presenceSummaryBySessionId.set(
        sessionId,
        Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(' • '),
      );
    }
  }

  return {
    storagePath: canonicalState.storagePath,
    profileHumanIdentityId: canonicalState.profile.humanIdentityId,
    sessionById,
    identityById,
    presenceByIdentityId,
    participantsBySessionId,
    canonicalParticipantsBySessionId,
    canonicalMessagesBySessionId,
    rawMessageCountBySessionId,
    delegatedExchangeCountBySessionId,
    contextSnapshotCountBySessionId,
    presenceSummaryBySessionId,
  };
}
