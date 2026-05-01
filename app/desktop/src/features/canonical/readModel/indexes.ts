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
  isProcessingPlaceholderText,
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

function normalizedLeadingMentionText(value: string) {
  return value
    .trim()
    .replace(/^@[^\s:;,.!?—-]+\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function localAgentRuntimeUserEchoIds(messages: CanonicalSessionMessage[]) {
  const echoIds = new Set<string>();
  const bridgeUiMentions = messages.filter((message) => (
    message.sourceTransport === 'desktop-chat-ui'
    && message.senderRole === 'user'
    && message.contentText.trim().startsWith('@')
  ));
  for (const message of messages) {
    if (message.sourceTransport !== 'desktop-chat' || message.senderRole !== 'user') continue;
    const normalizedText = normalizedLeadingMentionText(message.contentText);
    if (!normalizedText) continue;
    const duplicate = bridgeUiMentions.some((candidate) => (
      candidate.senderIdentityId === message.senderIdentityId
      && Math.abs(message.createdAtMs - candidate.createdAtMs) <= 5_000
      && normalizedLeadingMentionText(candidate.contentText) === normalizedText
    ));
    if (duplicate) echoIds.add(message.id);
  }
  return echoIds;
}

function ownedAgentRuntimeRichness(message: CanonicalSessionMessage) {
  if (message.senderRole !== 'owned-agent' || message.messageKind !== 'agent-turn') return 0;
  const content = contentRecord(message.content);
  const tools = Array.isArray(content.tools) ? content.tools.length : 0;
  const thinking = stringValue(content.thinkingText)?.trim() ? 1 : 0;
  const active = stringValue(content.deliveryState)?.trim().toLowerCase() === 'processing' ? 1 : 0;
  return tools * 10 + thinking + active;
}

function comparableOwnedAgentResponseText(value: string) {
  return value.trim().replace(/\s+/gu, '');
}

function sameOwnedAgentResponseText(left: string, right: string) {
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (!leftTrimmed || !rightTrimmed) return false;
  return leftTrimmed === rightTrimmed
    || comparableOwnedAgentResponseText(leftTrimmed) === comparableOwnedAgentResponseText(rightTrimmed);
}

function sameOwnedAgentResponse(left: CanonicalSessionMessage, right: CanonicalSessionMessage) {
  return left.sessionId === right.sessionId
    && left.senderIdentityId === right.senderIdentityId
    && left.senderRole === 'owned-agent'
    && right.senderRole === 'owned-agent'
    && left.messageKind === 'agent-turn'
    && right.messageKind === 'agent-turn'
    && sameOwnedAgentResponseText(left.contentText, right.contentText)
    && Math.abs(left.createdAtMs - right.createdAtMs) <= 30_000;
}

function normalizedDuplicateText(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function bridgeParentUserMessageMatchesOptimisticUi(
  parentMessage: CanonicalSessionMessage,
  optimisticMessage: CanonicalSessionMessage,
) {
  return parentMessage.sessionId === optimisticMessage.sessionId
    && parentMessage.senderRole === 'user'
    && optimisticMessage.senderRole === 'user'
    && parentMessage.messageKind === optimisticMessage.messageKind
    && parentMessage.sourceTransport === 'desktop-bridge-parent'
    && optimisticMessage.sourceTransport === 'desktop-bridge-ui'
    && normalizedDuplicateText(parentMessage.contentText) === normalizedDuplicateText(optimisticMessage.contentText)
    && Math.abs(parentMessage.createdAtMs - optimisticMessage.createdAtMs) <= 10_000;
}

function bridgeUiOptimisticEchoIds(messages: CanonicalSessionMessage[]) {
  const echoIds = new Set<string>();
  const optimisticMessages = messages
    .filter((message) => message.sourceTransport === 'desktop-bridge-ui' && message.senderRole === 'user')
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.sequenceNum - right.sequenceNum);
  const parentMessages = messages
    .filter((message) => message.sourceTransport === 'desktop-bridge-parent' && message.senderRole === 'user')
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.sequenceNum - right.sequenceNum);

  for (const parentMessage of parentMessages) {
    const nearestOptimisticMessage = optimisticMessages
      .filter((optimisticMessage) => !echoIds.has(optimisticMessage.id) && bridgeParentUserMessageMatchesOptimisticUi(parentMessage, optimisticMessage))
      .sort((left, right) => {
        const leftDistance = Math.abs(parentMessage.createdAtMs - left.createdAtMs);
        const rightDistance = Math.abs(parentMessage.createdAtMs - right.createdAtMs);
        return leftDistance - rightDistance || right.sequenceNum - left.sequenceNum;
      })[0];
    if (nearestOptimisticMessage) echoIds.add(nearestOptimisticMessage.id);
  }

  return echoIds;
}

function isOwnedAgentTurn(message: CanonicalSessionMessage) {
  return message.senderRole === 'owned-agent' && message.messageKind === 'agent-turn';
}

function isStaleableProcessingPlaceholder(message: CanonicalSessionMessage) {
  return message.sourceTransport === 'desktop-bridge-session-relay'
    && (message.senderRole === 'owned-agent' || message.senderRole === 'external-agent')
    && message.messageKind === 'agent-turn'
    && isProcessingPlaceholderText(message.contentText);
}

function localOwnedAgentRuntimeDuplicateIds(messages: CanonicalSessionMessage[]) {
  const duplicateIds = new Set<string>();
  const localRuntimeMessages = messages.filter((message) => (
    message.sourceTransport === 'desktop-chat'
    && isOwnedAgentTurn(message)
  ));
  const bridgeRelayMessages = messages.filter((message) => (
    message.sourceTransport === 'desktop-bridge-session-relay'
    && isOwnedAgentTurn(message)
  ));

  for (const bridgeMessage of bridgeRelayMessages) {
    const matchingLocalMessages = localRuntimeMessages.filter((message) => sameOwnedAgentResponse(message, bridgeMessage));
    if (matchingLocalMessages.length === 0) continue;

    const bestLocal = matchingLocalMessages.reduce((best, candidate) => {
      const candidateRichness = ownedAgentRuntimeRichness(candidate);
      const bestRichness = ownedAgentRuntimeRichness(best);
      if (candidateRichness !== bestRichness) return candidateRichness > bestRichness ? candidate : best;
      return Math.abs(candidate.createdAtMs - bridgeMessage.createdAtMs) < Math.abs(best.createdAtMs - bridgeMessage.createdAtMs)
        ? candidate
        : best;
    });

    for (const localMessage of matchingLocalMessages) {
      if (localMessage.id !== bestLocal.id) duplicateIds.add(localMessage.id);
    }
    duplicateIds.add(bridgeMessage.id);
  }

  return duplicateIds;
}

function staleProcessingPlaceholderIds(messages: CanonicalSessionMessage[]) {
  const staleIds = new Set<string>();
  const completedAgentResponses = messages.filter((message) => (
    (message.senderRole === 'owned-agent' || message.senderRole === 'external-agent')
    && message.messageKind === 'agent-turn'
    && !isProcessingPlaceholderText(message.contentText)
    && message.contentText.trim()
    && !['draft', 'sending', 'processing'].includes(message.status.trim().toLowerCase())
  ));

  for (const placeholder of messages.filter(isStaleableProcessingPlaceholder)) {
    const hasLaterResponse = completedAgentResponses.some((message) => (
      message.sessionId === placeholder.sessionId
      && message.senderIdentityId === placeholder.senderIdentityId
      && message.senderRole === placeholder.senderRole
      && message.createdAtMs >= placeholder.createdAtMs
      && message.createdAtMs - placeholder.createdAtMs <= 10 * 60 * 1_000
    ));
    if (hasLaterResponse) staleIds.add(placeholder.id);
  }

  return staleIds;
}

export function buildCanonicalIndexes(canonicalState: CanonicalSessionState | null): CanonicalIndexes {
  if (!canonicalState) return emptyIndexes();

  const identityById = new Map(canonicalState.identities.map((identity) => [identity.id, identity]));
  const sessionById = new Map(canonicalState.sessions.map((session) => [session.id, session]));
  const presenceByIdentityId = new Map(canonicalState.presence.map((presence) => [presence.identityId, presence]));

  const participantsBySessionId = new Map<string, CanonicalSessionParticipant[]>();
  for (const participant of canonicalState.participants) {
    if (participant.state !== 'active') continue;
    participantsBySessionId.set(participant.sessionId, [...(participantsBySessionId.get(participant.sessionId) ?? []), participant]);
  }

  const canonicalParticipantsBySessionId = new Map<string, ConversationParticipant[]>();
  for (const [sessionId, participants] of participantsBySessionId) {
    const seenParticipantKeys = new Set<string>();
    const details = participants.flatMap((participant) => {
      const identity = identityById.get(participant.identityId);
      if (!identity) return [];
      const presence = presenceByIdentityId.get(identity.id);
      const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : undefined;
      const name = ownerScopedAgentName(identity, identityById, canonicalState.profile.humanIdentityId) ?? identity.displayName;
      const ownerName = owner ? (ownerScopedAgentName(owner, identityById, canonicalState.profile.humanIdentityId) ?? owner.displayName) : null;
      const role = identity.id === canonicalState.profile.humanIdentityId
        ? 'self'
        : participant.role === 'self'
          ? 'person'
          : participant.role;
      const participantKey = [
        identity.kind,
        role,
        name.trim().toLowerCase(),
        ownerName?.trim().toLowerCase() ?? '',
      ].join('\u0000');
      if (seenParticipantKeys.has(participantKey)) return [];
      seenParticipantKeys.add(participantKey);
      return [{
        id: identity.id,
        name,
        kind: identity.kind,
        role,
        source: identity.source,
        ownerIdentityId: identity.ownerIdentityId,
        ownerName,
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
  const failedDelegationRequestMessageIds = new Set(
    canonicalState.delegatedExchanges.flatMap((exchange) => {
      if (!['failed', 'timeout'].includes(exchange.status.trim().toLowerCase())) return [];
      const requestMessageId = exchange.requestMessageId?.trim() || exchange.triggerMessageId?.trim();
      return requestMessageId ? [requestMessageId] : [];
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
      [...(processingDelegationMessagesBySessionId.get(exchange.sessionId) ?? []), processingAgentMessage(exchange, target, identityById, canonicalState.profile.humanIdentityId)],
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
    const suppressedBridgeUiEchoIds = bridgeUiOptimisticEchoIds(sortedMessages);
    const suppressedLocalRuntimeEchoIds = localAgentRuntimeUserEchoIds(sortedMessages);
    const suppressedLocalRuntimeDuplicateIds = localOwnedAgentRuntimeDuplicateIds(sortedMessages);
    const suppressedStaleProcessingPlaceholderIds = staleProcessingPlaceholderIds(sortedMessages);
    rawMessageCountBySessionId.set(sessionId, sortedMessages.length);
    canonicalMessagesBySessionId.set(
      sessionId,
      sortedMessages.flatMap((message) => {
        if (
          suppressedBridgeUiEchoIds.has(message.id)
          || suppressedLocalRuntimeEchoIds.has(message.id)
          || suppressedLocalRuntimeDuplicateIds.has(message.id)
          || suppressedStaleProcessingPlaceholderIds.has(message.id)
        ) return [];
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
        if (!mapped) return [];
        if (mapped.role === 'user' && failedDelegationRequestMessageIds.has(message.id)) {
          return [{ ...mapped, statusChips: ['failed'] }];
        }
        return [mapped];
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
