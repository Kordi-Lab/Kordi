import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionParticipant,
  CanonicalSessionState,
  ConversationParticipant,
  Message,
  SessionTaskActivity,
} from '@/kordi-app/types';

import {
  cancelledBridgeAgentDelegationMessage,
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
  taskActivitiesBySessionId: Map<string, SessionTaskActivity[]>;
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
    taskActivitiesBySessionId: new Map(),
    contextSnapshotCountBySessionId: new Map(),
    presenceSummaryBySessionId: new Map(),
  };
}

type CanonicalMessageSortPosition = {
  sortAtMs: number;
  sequenceNum: number;
};

type SortableCanonicalMessage = CanonicalMessageSortPosition & {
  message: Message;
  tieBreakAtMs: number;
};

function sortedCanonicalMessages(messages: SortableCanonicalMessage[]) {
  return [...messages]
    .sort((left, right) => left.sortAtMs - right.sortAtMs
      || left.sequenceNum - right.sequenceNum
      || left.tieBreakAtMs - right.tieBreakAtMs)
    .map((entry) => entry.message);
}

function messageSortPosition(message: CanonicalSessionMessage): CanonicalMessageSortPosition {
  return { sortAtMs: message.createdAtMs, sequenceNum: message.sequenceNum };
}

function childMessageSortPosition(
  message: CanonicalSessionMessage,
  messageSortById: Map<string, CanonicalMessageSortPosition>,
): CanonicalMessageSortPosition {
  const parentPosition = message.parentMessageId && message.parentMessageId !== message.id
    ? messageSortById.get(message.parentMessageId)
    : null;
  if (!parentPosition) return messageSortPosition(message);
  return {
    sortAtMs: parentPosition.sortAtMs,
    sequenceNum: parentPosition.sequenceNum + 0.5,
  };
}

function exchangeSortPosition(
  exchange: CanonicalSessionState['delegatedExchanges'][number],
  messageSortById: Map<string, CanonicalMessageSortPosition>,
): CanonicalMessageSortPosition {
  const parentMessageId = exchange.requestMessageId?.trim() || exchange.triggerMessageId?.trim();
  const parentPosition = parentMessageId ? messageSortById.get(parentMessageId) : null;
  if (parentPosition) {
    return {
      sortAtMs: parentPosition.sortAtMs,
      sequenceNum: parentPosition.sequenceNum + 0.5,
    };
  }
  return { sortAtMs: exchange.createdAtMs, sequenceNum: Number.MAX_SAFE_INTEGER };
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

function isBridgeAgentProcessingPlaceholder(message: CanonicalSessionMessage) {
  return (message.senderRole === 'owned-agent' || message.senderRole === 'external-agent')
    && message.messageKind === 'agent-turn'
    && isProcessingPlaceholderText(message.contentText);
}

function isStaleableProcessingPlaceholder(message: CanonicalSessionMessage) {
  return (message.sourceTransport === 'desktop-bridge-session-relay'
    || message.sourceTransport === 'desktop-bridge-parent')
    && isBridgeAgentProcessingPlaceholder(message);
}

const BRIDGE_PROCESSING_PLACEHOLDER_MAX_AGE_MS = 10 * 60 * 1_000;

function isActiveProcessingStatus(message: CanonicalSessionMessage) {
  const content = contentRecord(message.content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  const status = message.status.trim().toLowerCase();
  return deliveryState === 'processing' || status === 'processing';
}

function isAgedBridgeProcessingPlaceholder(message: CanonicalSessionMessage) {
  if (!isStaleableProcessingPlaceholder(message)) return false;
  if (!isActiveProcessingStatus(message)) return true;

  return Date.now() - message.createdAtMs > BRIDGE_PROCESSING_PLACEHOLDER_MAX_AGE_MS;
}

function isPureBridgeAgentStatusRow(message: CanonicalSessionMessage) {
  if (message.sourceTransport !== 'desktop-bridge-session-relay') return false;
  if (!isOwnedAgentTurn(message)) return false;
  const content = contentRecord(message.content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  // `processing` is the in-flight placeholder that the bridge fanout writes to peers; on the
  // sender's own canonical session it duplicates the local desktop-chat turn until the
  // assistant text streams in. Cancelled/failed are the terminal status markers.
  return deliveryState === 'processing'
    || deliveryState === 'cancelled'
    || deliveryState === 'processing_failed';
}

function pairedLocalOwnedAgentTurnExists(
  local: CanonicalSessionMessage,
  bridge: CanonicalSessionMessage,
) {
  return local.sessionId === bridge.sessionId
    && local.senderIdentityId === bridge.senderIdentityId
    && local.senderRole === 'owned-agent'
    && local.messageKind === 'agent-turn'
    && Math.abs(local.createdAtMs - bridge.createdAtMs) <= 30_000;
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
    if (matchingLocalMessages.length === 0) {
      // Cancelled/failed bridge fanout rows are pure status markers — when the
      // sender's instance also has a desktop-chat owned-agent turn for the same
      // request, the bridge row is the redundant copy.
      if (
        isPureBridgeAgentStatusRow(bridgeMessage)
        && localRuntimeMessages.some((local) => pairedLocalOwnedAgentTurnExists(local, bridgeMessage))
      ) {
        duplicateIds.add(bridgeMessage.id);
      }
      continue;
    }

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

function bridgeRelayAgentFanoutDuplicateIds(messages: CanonicalSessionMessage[]) {
  const duplicateIds = new Set<string>();
  const messagesByRequest = new Map<string, CanonicalSessionMessage[]>();

  for (const message of messages) {
    if (message.sourceTransport !== 'desktop-bridge-session-relay') continue;
    if (message.messageKind !== 'agent-turn') continue;
    if (message.senderRole !== 'owned-agent' && message.senderRole !== 'external-agent') continue;
    const content = contentRecord(message.content);
    if (stringValue(content.kind) !== 'session-relay') continue;
    const requestId = stringValue(content.requestId)?.trim();
    if (!requestId) continue;
    const comparableText = comparableOwnedAgentResponseText(message.contentText);
    if (!comparableText) continue;
    const key = [
      message.sessionId,
      message.senderIdentityId,
      message.senderRole,
      requestId,
      comparableText,
    ].join('\u0000');
    messagesByRequest.set(key, [...(messagesByRequest.get(key) ?? []), message]);
  }

  for (const duplicateGroup of messagesByRequest.values()) {
    if (duplicateGroup.length <= 1) continue;
    const duplicates = duplicateGroup
      .sort((left, right) => (
        left.createdAtMs - right.createdAtMs
        || left.sequenceNum - right.sequenceNum
        || left.id.localeCompare(right.id)
      ))
      .slice(1);
    for (const duplicate of duplicates) {
      duplicateIds.add(duplicate.id);
    }
  }

  return duplicateIds;
}

const STALE_BRIDGE_PROCESSING_PLACEHOLDER_MS = 10 * 60 * 1_000;

function isHumanConversationActivity(message: CanonicalSessionMessage) {
  return (message.senderRole === 'user' || message.senderRole === 'person')
    && message.messageKind !== 'agent-turn';
}

function bridgeRequestIdForMessage(message: CanonicalSessionMessage) {
  const content = contentRecord(message.content);
  const contentRequestId = stringValue(content.requestId)?.trim();
  if (contentRequestId) return contentRequestId;

  const sourceEventId = message.sourceEventId?.trim() ?? '';
  return /\bbridge_req_[A-Za-z0-9_]+\b/u.exec(sourceEventId)?.[0] ?? null;
}

function bridgeRequestIdsDiffer(left: CanonicalSessionMessage, right: CanonicalSessionMessage) {
  const leftRequestId = bridgeRequestIdForMessage(left);
  const rightRequestId = bridgeRequestIdForMessage(right);
  return Boolean(leftRequestId && rightRequestId && leftRequestId !== rightRequestId);
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
  const laterHumanActivity = messages.filter(isHumanConversationActivity);

  for (const placeholder of messages.filter(isStaleableProcessingPlaceholder)) {
    const hasLaterResponse = completedAgentResponses.some((message) => (
      message.sessionId === placeholder.sessionId
      && message.senderIdentityId === placeholder.senderIdentityId
      && message.senderRole === placeholder.senderRole
      && message.createdAtMs >= placeholder.createdAtMs
      && message.createdAtMs - placeholder.createdAtMs <= STALE_BRIDGE_PROCESSING_PLACEHOLDER_MS
      && !bridgeRequestIdsDiffer(placeholder, message)
    ));
    const hasMuchLaterHumanActivity = laterHumanActivity.some((message) => (
      message.sessionId === placeholder.sessionId
      && message.createdAtMs > placeholder.createdAtMs
      && message.createdAtMs - placeholder.createdAtMs >= STALE_BRIDGE_PROCESSING_PLACEHOLDER_MS
    ));
    if (hasLaterResponse || hasMuchLaterHumanActivity) staleIds.add(placeholder.id);
  }

  return staleIds;
}

function taskParticipantFromIdentity(
  identity: CanonicalIdentity | undefined,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
): SessionTaskActivity['initiator'] {
  if (!identity) return null;
  const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : undefined;
  return {
    id: identity.id,
    name: ownerScopedAgentName(identity, identityById, profileHumanIdentityId) ?? identity.displayName,
    kind: identity.kind,
    role: identity.id === profileHumanIdentityId ? 'self' : identity.kind === 'agent' ? 'delegate' : 'person',
    source: identity.source,
    ownerIdentityId: identity.ownerIdentityId,
    ownerName: owner ? (ownerScopedAgentName(owner, identityById, profileHumanIdentityId) ?? owner.displayName) : null,
    bridgeHostId: identity.sourceHostId,
    bridgeNodeId: identity.bridgeNodeId,
    humanId: identity.humanId,
    agentId: identity.agentId,
    avatarKey: identity.avatarKey,
    profileImageUrl: identity.profileImageUrl,
  };
}

function buildTaskActivitiesBySessionId(
  canonicalState: CanonicalSessionState,
  identityById: Map<string, CanonicalIdentity>,
  canonicalParticipantsBySessionId: Map<string, ConversationParticipant[]>,
) {
  const activities = new Map<string, SessionTaskActivity[]>();
  for (const exchange of canonicalState.delegatedExchanges) {
    const participants = canonicalParticipantsBySessionId.get(exchange.sessionId) ?? [];
    const activity: SessionTaskActivity = {
      id: exchange.id,
      sessionId: exchange.sessionId,
      status: exchange.status,
      initiator: taskParticipantFromIdentity(identityById.get(exchange.initiatorIdentityId), identityById, canonicalState.profile.humanIdentityId),
      target: taskParticipantFromIdentity(identityById.get(exchange.targetIdentityId), identityById, canonicalState.profile.humanIdentityId),
      participants: participants.map((participant) => ({ ...participant })),
      createdAtMs: exchange.createdAtMs,
      updatedAtMs: exchange.updatedAtMs,
      bridgeConversationId: exchange.bridgeConversationId,
      bridgeRequestId: exchange.bridgeRequestId,
      contextPolicy: exchange.contextPolicy,
      error: exchange.error,
    };
    activities.set(exchange.sessionId, [...(activities.get(exchange.sessionId) ?? []), activity]);
  }
  for (const [sessionId, sessionActivities] of activities) {
    activities.set(sessionId, sessionActivities.sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.id.localeCompare(right.id)));
  }
  return activities;
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
  const messageSortById = new Map<string, CanonicalMessageSortPosition>();
  for (const message of canonicalState.messages) {
    rawMessagesBySessionId.set(message.sessionId, [...(rawMessagesBySessionId.get(message.sessionId) ?? []), message]);
    messageSortById.set(message.id, messageSortPosition(message));
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
  const processingDelegationMessagesBySessionId = new Map<string, SortableCanonicalMessage[]>();
  const cancelledDelegationMessagesBySessionId = new Map<string, SortableCanonicalMessage[]>();
  for (const exchange of canonicalState.delegatedExchanges) {
    const status = exchange.status.trim().toLowerCase();
    if (!['pending', 'sending', 'processing'].includes(status)) continue;
    if (!exchange.bridgeRequestId) {
      if (exchange.transport?.trim().toLowerCase() === 'bridge') continue;
      const fallbackKey = delegationOptimisticFallbackKey(exchange);
      if (fallbackKey && (bridgedDelegationFallbackKeys.has(fallbackKey) || completedDelegationFallbackKeys.has(fallbackKey))) continue;
    }
    if (exchange.responseMessageId && rawMessagesBySessionId.get(exchange.sessionId)?.some((message) => message.id === exchange.responseMessageId)) continue;
    const target = identityById.get(exchange.targetIdentityId);
    if (!target || target.kind !== 'agent') continue;
    processingDelegationMessagesBySessionId.set(
      exchange.sessionId,
      [
        ...(processingDelegationMessagesBySessionId.get(exchange.sessionId) ?? []),
        {
          message: processingAgentMessage(exchange, target, identityById, canonicalState.profile.humanIdentityId),
          ...exchangeSortPosition(exchange, messageSortById),
          tieBreakAtMs: exchange.createdAtMs,
        },
      ],
    );
  }

  for (const exchange of canonicalState.delegatedExchanges) {
    if (exchange.status.trim().toLowerCase() !== 'cancelled') continue;
    const target = identityById.get(exchange.targetIdentityId);
    if (!target || target.kind !== 'agent') continue;
    const stoppedMessage = cancelledBridgeAgentDelegationMessage(exchange, target, identityById, canonicalState.profile.humanIdentityId);
    if (!stoppedMessage) continue;
    cancelledDelegationMessagesBySessionId.set(
      exchange.sessionId,
      [
        ...(cancelledDelegationMessagesBySessionId.get(exchange.sessionId) ?? []),
        {
          message: stoppedMessage,
          ...exchangeSortPosition(exchange, messageSortById),
          tieBreakAtMs: exchange.createdAtMs,
        },
      ],
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
    const suppressedBridgeRelayAgentFanoutDuplicateIds = bridgeRelayAgentFanoutDuplicateIds(sortedMessages);
    const suppressedStaleProcessingPlaceholderIds = staleProcessingPlaceholderIds(sortedMessages);
    const suppressedAgedBridgeProcessingPlaceholderIds = new Set(
      sortedMessages.filter(isAgedBridgeProcessingPlaceholder).map((message) => message.id),
    );
    rawMessageCountBySessionId.set(sessionId, sortedMessages.length);
    const senderIdentityIdByMessageId = new Map<string, string>(
      sortedMessages.map((message) => [message.id, message.senderIdentityId]),
    );
    const mappedMessages = sortedMessages.flatMap<SortableCanonicalMessage>((message) => {
      if (
        suppressedBridgeUiEchoIds.has(message.id)
        || suppressedLocalRuntimeEchoIds.has(message.id)
        || suppressedLocalRuntimeDuplicateIds.has(message.id)
        || suppressedBridgeRelayAgentFanoutDuplicateIds.has(message.id)
        || suppressedStaleProcessingPlaceholderIds.has(message.id)
        || suppressedAgedBridgeProcessingPlaceholderIds.has(message.id)
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
      const mapped = mapCanonicalMessage(
        message,
        identityById,
        canonicalState.profile.humanIdentityId,
        { senderIdentityIdByMessageId },
      );
      if (!mapped) return [];
      const displayMessage = mapped.role === 'user' && failedDelegationRequestMessageIds.has(message.id)
        ? { ...mapped, statusChips: ['failed'] }
        : mapped;
      return [{
        message: displayMessage,
        ...childMessageSortPosition(message, messageSortById),
        tieBreakAtMs: message.createdAtMs,
      }];
    });
    canonicalMessagesBySessionId.set(
      sessionId,
      sortedCanonicalMessages([
        ...mappedMessages,
        ...(processingDelegationMessagesBySessionId.get(sessionId) ?? []),
        ...(cancelledDelegationMessagesBySessionId.get(sessionId) ?? []),
      ]),
    );
  }

  for (const [sessionId, processingMessages] of processingDelegationMessagesBySessionId) {
    if (!canonicalMessagesBySessionId.has(sessionId)) {
      canonicalMessagesBySessionId.set(sessionId, sortedCanonicalMessages(processingMessages));
      rawMessageCountBySessionId.set(sessionId, 0);
    }
  }
  for (const [sessionId, cancelledMessages] of cancelledDelegationMessagesBySessionId) {
    if (!canonicalMessagesBySessionId.has(sessionId)) {
      canonicalMessagesBySessionId.set(sessionId, sortedCanonicalMessages(cancelledMessages));
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

  const taskActivitiesBySessionId = buildTaskActivitiesBySessionId(
    canonicalState,
    identityById,
    canonicalParticipantsBySessionId,
  );

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
    taskActivitiesBySessionId,
    contextSnapshotCountBySessionId,
    presenceSummaryBySessionId,
  };
}
