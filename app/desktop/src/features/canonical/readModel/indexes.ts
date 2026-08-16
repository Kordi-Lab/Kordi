import { isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';

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
  cancelledCollaborationAgentDelegationMessage,
  contentRecord,
  delegationOptimisticFallbackKey,
  delegationTerminalStatus,
  directCollaborationSourceEventForOutreachDuplicate,
  isProcessingPlaceholderText,
  mapCanonicalMessage,
  ownerScopedAgentName,
  processingAgentMessage,
  stringValue,
} from './messageMapping';
import { completedCallStartMessageIds } from './callActivity';
import { canonicalMessageCountsForLastActive } from './conversationMapping';

export type CanonicalIndexes = {
  storagePath: string;
  profileHumanIdentityId?: string | null;
  sessionById: Map<string, CanonicalSessionState['sessions'][number]>;
  identityById: Map<string, CanonicalIdentity>;
  presenceByIdentityId: Map<string, CanonicalSessionState['presence'][number]>;
  participantsBySessionId: Map<string, CanonicalSessionParticipant[]>;
  canonicalParticipantsBySessionId: Map<string, ConversationParticipant[]>;
  canonicalMessagesBySessionId: Map<string, Message[]>;
  rawMessagesBySessionId: Map<string, CanonicalSessionMessage[]>;
  latestReadableMessageBySessionId: Map<string, CanonicalSessionMessage>;
  latestActivityMessageBySessionId: Map<string, CanonicalSessionMessage>;
  rawMessageCountBySessionId: Map<string, number>;
  readableMessageCountBySessionId: Map<string, number>;
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
    rawMessagesBySessionId: new Map(),
    latestReadableMessageBySessionId: new Map(),
    latestActivityMessageBySessionId: new Map(),
    rawMessageCountBySessionId: new Map(),
    readableMessageCountBySessionId: new Map(),
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

function inheritedDesktopForkSnapshot(session: CanonicalSessionState['sessions'][number] | undefined, message: CanonicalSessionMessage) {
  if (!session || message.sourceTransport !== 'desktop-chat') return false;
  if (!Number.isFinite(session.createdAtMs) || message.createdAtMs >= session.createdAtMs) return false;
  const metadata = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
    ? session.metadata as Record<string, unknown>
    : null;
  const fork = metadata?.fork && typeof metadata.fork === 'object' && !Array.isArray(metadata.fork)
    ? metadata.fork as Record<string, unknown>
    : null;
  return stringValue(fork?.boundary) === 'inherited-history-reference-only'
    && Boolean(stringValue(fork?.forkedFromSessionId));
}

function messageSortPosition(message: CanonicalSessionMessage): CanonicalMessageSortPosition {
  return { sortAtMs: message.createdAtMs, sequenceNum: message.sequenceNum };
}

const CHILD_MESSAGE_SEQUENCE_OFFSET = 0.5;

function childMessageSortPosition(
  message: CanonicalSessionMessage,
  rawMessageById: ReadonlyMap<string, CanonicalSessionMessage>,
  messageSortById: Map<string, CanonicalMessageSortPosition>,
  visitingMessageIds: Set<string>,
): CanonicalMessageSortPosition {
  const cachedPosition = messageSortById.get(message.id);
  if (cachedPosition) return cachedPosition;

  const basePosition = messageSortPosition(message);
  if (!message.parentMessageId || message.parentMessageId === message.id || visitingMessageIds.has(message.id)) {
    messageSortById.set(message.id, basePosition);
    return basePosition;
  }

  const parentMessage = rawMessageById.get(message.parentMessageId);
  if (!parentMessage) {
    messageSortById.set(message.id, basePosition);
    return basePosition;
  }

  visitingMessageIds.add(message.id);
  const parentPosition = childMessageSortPosition(parentMessage, rawMessageById, messageSortById, visitingMessageIds);
  visitingMessageIds.delete(message.id);
  const isAlreadyAfterParent = basePosition.sortAtMs > parentPosition.sortAtMs
    || (
      basePosition.sortAtMs === parentPosition.sortAtMs
      && basePosition.sequenceNum > parentPosition.sequenceNum
    );
  // Parent links express causality, not transcript placement. Preserve real chronology;
  // only clamp clock drift that would render a response before its request.
  const position = isAlreadyAfterParent
    ? basePosition
    : {
        sortAtMs: parentPosition.sortAtMs,
        sequenceNum: parentPosition.sequenceNum + CHILD_MESSAGE_SEQUENCE_OFFSET,
      };
  messageSortById.set(message.id, position);
  return position;
}

function buildMessageSortPositions(messages: CanonicalSessionMessage[]) {
  const rawMessageById = new Map(messages.map((message) => [message.id, message]));
  const messageSortById = new Map<string, CanonicalMessageSortPosition>();
  for (const message of messages) {
    childMessageSortPosition(message, rawMessageById, messageSortById, new Set());
  }
  return messageSortById;
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

function pushMapArray<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}

function lowerBoundCreatedAt(messages: readonly CanonicalSessionMessage[], targetMs: number) {
  let start = 0;
  let end = messages.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (messages[middle].createdAtMs < targetMs) start = middle + 1;
    else end = middle;
  }
  return start;
}

function messagesInCreatedAtRange(
  messages: readonly CanonicalSessionMessage[] | undefined,
  startMs: number,
  endMs: number,
) {
  if (!messages?.length) return [];
  const start = lowerBoundCreatedAt(messages, startMs);
  const matches: CanonicalSessionMessage[] = [];
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.createdAtMs > endMs) break;
    matches.push(message);
  }
  return matches;
}

function hasMessageInCreatedAtRange(
  messages: readonly CanonicalSessionMessage[] | undefined,
  startMs: number,
  endMs: number,
) {
  if (!messages?.length) return false;
  const start = lowerBoundCreatedAt(messages, startMs);
  return start < messages.length && messages[start].createdAtMs <= endMs;
}

function localAgentRuntimeUserEchoMatches(messages: CanonicalSessionMessage[]) {
  const runtimeEchoIds = new Set<string>();
  const confirmedUiIds = new Set<string>();
  const matchedUiIds = new Set<string>();
  const runtimeReplyAliasIdsByUiId = new Map<string, string[]>();
  const legacyCollaborationUiMessagesByKey = new Map<string, CanonicalSessionMessage[]>();
  const duplicateKey = (message: CanonicalSessionMessage) => [
    message.sessionId,
    message.senderIdentityId,
    message.senderRole,
    normalizedLeadingMentionText(message.contentText),
  ].join('\u0000');
  for (const message of messages) {
    if (
      message.sourceTransport !== 'desktop-chat-ui'
      || message.senderRole !== 'user'
    ) continue;
    const key = duplicateKey(message);
    if (key.endsWith('\u0000')) continue;
    pushMapArray(legacyCollaborationUiMessagesByKey, key, message);
  }
  for (const message of messages) {
    if (message.sourceTransport !== 'desktop-chat' || message.senderRole !== 'user') continue;
    const normalizedText = normalizedLeadingMentionText(message.contentText);
    if (!normalizedText) continue;
    const candidate = messagesInCreatedAtRange(
      legacyCollaborationUiMessagesByKey.get(duplicateKey(message)),
      message.createdAtMs - 5_000,
      message.createdAtMs + 5_000,
    )
      .filter((uiMessage) => !matchedUiIds.has(uiMessage.id))
      .sort((left, right) => (
        Math.abs(left.createdAtMs - message.createdAtMs) - Math.abs(right.createdAtMs - message.createdAtMs)
        || right.sequenceNum - left.sequenceNum
      ))[0];
    if (!candidate) continue;
    runtimeEchoIds.add(message.id);
    confirmedUiIds.add(candidate.id);
    matchedUiIds.add(candidate.id);
    pushMapArray(runtimeReplyAliasIdsByUiId, candidate.id, message.id);
  }
  return { runtimeEchoIds, confirmedUiIds, runtimeReplyAliasIdsByUiId };
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

function normalizedDuplicateText(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function legacyCollaborationUiOptimisticEchoKey(message: CanonicalSessionMessage) {
  return [
    message.sessionId,
    message.senderRole,
    message.messageKind,
    normalizedDuplicateText(message.contentText),
  ].join('\u0000');
}

function legacyCollaborationUiOptimisticEchoIds(messages: CanonicalSessionMessage[]) {
  const echoIds = new Set<string>();
  const optimisticByKey = new Map<string, CanonicalSessionMessage[]>();
  const parentsByKey = new Map<string, CanonicalSessionMessage[]>();
  for (const message of messages) {
    if (message.senderRole !== 'user') continue;
    const key = legacyCollaborationUiOptimisticEchoKey(message);
    if (message.sourceTransport === 'desktop-bridge-ui') {
      pushMapArray(optimisticByKey, key, message);
    } else if (message.sourceTransport === 'desktop-bridge-parent') {
      pushMapArray(parentsByKey, key, message);
    }
  }

  for (const [key, parentMessages] of parentsByKey) {
    const optimisticMessages = optimisticByKey.get(key);
    if (!optimisticMessages?.length) continue;
    optimisticMessages.sort((left, right) => (
      left.createdAtMs - right.createdAtMs
      || right.sequenceNum - left.sequenceNum
    ));
    parentMessages.sort((left, right) => (
      left.createdAtMs - right.createdAtMs
      || left.sequenceNum - right.sequenceNum
    ));

    const next = Array.from({ length: optimisticMessages.length + 1 }, (_, index) => index);
    const previous = Array.from({ length: optimisticMessages.length }, (_, index) => index);
    const findNext = (candidateIndex: number): number => {
      if (candidateIndex >= optimisticMessages.length) return optimisticMessages.length;
      if (next[candidateIndex] === candidateIndex) return candidateIndex;
      next[candidateIndex] = findNext(next[candidateIndex]);
      return next[candidateIndex];
    };
    const findPrevious = (candidateIndex: number): number => {
      if (candidateIndex < 0) return -1;
      if (previous[candidateIndex] === candidateIndex) return candidateIndex;
      previous[candidateIndex] = findPrevious(previous[candidateIndex]);
      return previous[candidateIndex];
    };
    const removeCandidate = (candidateIndex: number) => {
      next[candidateIndex] = findNext(candidateIndex + 1);
      previous[candidateIndex] = findPrevious(candidateIndex - 1);
    };

    for (const parentMessage of parentMessages) {
      const insertionIndex = lowerBoundCreatedAt(optimisticMessages, parentMessage.createdAtMs);
      const leftIndex = findPrevious(insertionIndex - 1);
      const rightIndex = findNext(insertionIndex);
      const candidates = [leftIndex, rightIndex]
        .filter((candidateIndex) => candidateIndex >= 0 && candidateIndex < optimisticMessages.length)
        .map((candidateIndex) => ({ candidateIndex, message: optimisticMessages[candidateIndex] }))
        .filter(({ message }) => Math.abs(parentMessage.createdAtMs - message.createdAtMs) <= 10_000)
        .sort((left, right) => {
          const leftDistance = Math.abs(parentMessage.createdAtMs - left.message.createdAtMs);
          const rightDistance = Math.abs(parentMessage.createdAtMs - right.message.createdAtMs);
          return leftDistance - rightDistance || right.message.sequenceNum - left.message.sequenceNum;
        });
      const nearest = candidates[0];
      if (!nearest) continue;
      echoIds.add(nearest.message.id);
      removeCandidate(nearest.candidateIndex);
    }
  }

  return echoIds;
}

function selfAgentLogicalSenderKey(
  message: CanonicalSessionMessage,
  identityById: ReadonlyMap<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  normalizeOwnedAgentIdentity = false,
) {
  if (message.senderRole !== 'owned-agent' || !normalizeOwnedAgentIdentity) {
    return `${message.senderRole}:${message.senderIdentityId}`;
  }
  const identity = identityById.get(message.senderIdentityId);
  const ownerIdentityId = identity?.ownerIdentityId?.trim() || profileHumanIdentityId?.trim() || '';
  const ownerIdentity = ownerIdentityId ? identityById.get(ownerIdentityId) : null;
  const identityMetadata = contentRecord(identity?.metadata);
  const ownerAccountId = ownerIdentity?.humanId?.trim()
    || ownerIdentity?.sourceIdentityId?.trim()
    || ownerIdentityId
    || stringValue(identityMetadata.accountId)?.trim();
  return `owned-agent:${ownerAccountId || 'self'}`;
}

function selfAgentMirrorMessageRelationKey(
  message: CanonicalSessionMessage,
  messageById: ReadonlyMap<string, CanonicalSessionMessage>,
  messageBySourceEventId: ReadonlyMap<string, CanonicalSessionMessage>,
  identityById: ReadonlyMap<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  normalizeOwnedAgentIdentity = false,
) {
  const content = contentRecord(message.content);
  const parentReference = message.parentMessageId?.trim()
    || stringValue(content.replyToMessageId)?.trim()
    || stringValue(content.cloudRequestMessageId)?.trim()
    || stringValue(content.requestId)?.trim()
    || '';
  if (!parentReference) return '';
  const parent = messageById.get(parentReference) ?? messageBySourceEventId.get(parentReference);
  if (!parent) return `reference:${parentReference}`;
  return [
    selfAgentLogicalSenderKey(
      parent,
      identityById,
      profileHumanIdentityId,
      normalizeOwnedAgentIdentity,
    ),
    parent.senderRole,
    parent.messageKind,
    parent.createdAtMs.toString(),
    normalizedDuplicateText(parent.contentText),
  ].join('\u001e');
}

function selfAgentMirrorDuplicateKey(
  message: CanonicalSessionMessage,
  messageById: ReadonlyMap<string, CanonicalSessionMessage>,
  messageBySourceEventId: ReadonlyMap<string, CanonicalSessionMessage>,
  identityById: ReadonlyMap<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  normalizeOwnedAgentIdentity = false,
) {
  const text = normalizedDuplicateText(message.contentText);
  if (!text) return null;
  return [
    message.sessionId,
    selfAgentLogicalSenderKey(
      message,
      identityById,
      profileHumanIdentityId,
      normalizeOwnedAgentIdentity,
    ),
    message.senderRole,
    message.messageKind,
    message.createdAtMs.toString(),
    text,
    selfAgentMirrorMessageRelationKey(
      message,
      messageById,
      messageBySourceEventId,
      identityById,
      profileHumanIdentityId,
      normalizeOwnedAgentIdentity,
    ),
  ].join('\u001f');
}

function selfAgentMirrorTransportPriority(message: CanonicalSessionMessage) {
  if (
    message.sourceTransport === 'canonical-fork-snapshot'
    && message.sourceEventId?.startsWith('fork-snapshot:')
  ) return 0;
  if (message.sourceTransport === 'canonical-fork-snapshot') return 1;
  if (message.sourceTransport === 'desktop-chat-ui') return 2;
  if (message.sourceTransport === 'desktop-chat') return 3;
  if (message.sourceTransport === 'cloud-self-agent') return 4;
  return Number.MAX_SAFE_INTEGER;
}

function selfAgentMirrorDuplicateIds(
  messages: CanonicalSessionMessage[],
  identityById: ReadonlyMap<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  normalizeOwnedAgentIdentity = false,
) {
  const duplicateIds = new Set<string>();
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const messageBySourceEventId = new Map(
    messages.flatMap((message) => message.sourceEventId ? [[message.sourceEventId, message] as const] : []),
  );
  const candidatesByKey = new Map<string, CanonicalSessionMessage[]>();
  for (const message of messages) {
    if (
      message.sourceTransport !== 'canonical-fork-snapshot'
      && message.sourceTransport !== 'desktop-chat'
      && message.sourceTransport !== 'desktop-chat-ui'
      && message.sourceTransport !== 'cloud-self-agent'
    ) continue;
    const key = selfAgentMirrorDuplicateKey(
      message,
      messageById,
      messageBySourceEventId,
      identityById,
      profileHumanIdentityId,
      normalizeOwnedAgentIdentity,
    );
    if (!key) continue;
    pushMapArray(candidatesByKey, key, message);
  }

  for (const candidates of candidatesByKey.values()) {
    if (candidates.length < 2) continue;
    const hasCloudMirror = candidates.some((message) => message.sourceTransport === 'cloud-self-agent');
    const hasPreferredLocalCopy = candidates.some((message) => (
      message.sourceTransport === 'canonical-fork-snapshot'
      || message.sourceTransport === 'desktop-chat'
      || message.sourceTransport === 'desktop-chat-ui'
    ));
    const hasCanonicalSnapshotOrigin = candidates.some((message) => (
      message.sourceTransport === 'canonical-fork-snapshot'
      && message.sourceEventId?.startsWith('fork-snapshot:')
    ));
    if ((!hasCloudMirror || !hasPreferredLocalCopy) && !hasCanonicalSnapshotOrigin) continue;

    const preferred = [...candidates].sort((left, right) => (
      selfAgentMirrorTransportPriority(left) - selfAgentMirrorTransportPriority(right)
      || left.sequenceNum - right.sequenceNum
      || left.id.localeCompare(right.id)
    ))[0];
    for (const candidate of candidates) {
      if (candidate.id !== preferred.id) duplicateIds.add(candidate.id);
    }
  }
  return duplicateIds;
}

function isOwnedAgentTurn(message: CanonicalSessionMessage) {
  return message.senderRole === 'owned-agent' && message.messageKind === 'agent-turn';
}

function isLegacyCollaborationAgentProcessingPlaceholder(message: CanonicalSessionMessage) {
  return (message.senderRole === 'owned-agent' || message.senderRole === 'external-agent')
    && message.messageKind === 'agent-turn'
    && isProcessingPlaceholderText(message.contentText);
}

function isStaleableProcessingPlaceholder(message: CanonicalSessionMessage) {
  return (message.sourceTransport === 'desktop-bridge-session-relay'
    || message.sourceTransport === 'desktop-bridge-parent'
    || message.sourceTransport === 'cloud-group-agent'
    || message.sourceTransport === 'cloud-group-agent-offline')
    && isLegacyCollaborationAgentProcessingPlaceholder(message);
}

const LEGACY_COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS = 10 * 60 * 1_000;

function isActiveProcessingStatus(message: CanonicalSessionMessage) {
  const content = contentRecord(message.content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  const status = message.status.trim().toLowerCase();
  return deliveryState === 'processing' || status === 'processing';
}

function isAgedLegacyCollaborationProcessingPlaceholder(message: CanonicalSessionMessage) {
  if (!isStaleableProcessingPlaceholder(message)) return false;
  if (!isActiveProcessingStatus(message)) return true;

  return Date.now() - message.createdAtMs > LEGACY_COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS;
}

function isPureLegacyCollaborationAgentStatusRow(message: CanonicalSessionMessage) {
  if (message.sourceTransport !== 'desktop-bridge-session-relay') return false;
  if (!isOwnedAgentTurn(message)) return false;
  const content = contentRecord(message.content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  // Legacy `processing` fanout duplicates the sender's local turn until assistant text streams;
  // cancelled and failed rows are terminal status markers.
  return deliveryState === 'processing'
    || deliveryState === 'cancelled'
    || deliveryState === 'processing_failed';
}

function localOwnedAgentPairKey(message: CanonicalSessionMessage) {
  return [
    message.sessionId,
    message.senderIdentityId,
    message.senderRole,
    message.messageKind,
  ].join('\u0000');
}

function localOwnedAgentResponseKey(message: CanonicalSessionMessage) {
  const comparableText = comparableOwnedAgentResponseText(message.contentText);
  return comparableText ? `${localOwnedAgentPairKey(message)}\u0000${comparableText}` : null;
}

function localOwnedAgentRuntimeDuplicateIds(messages: CanonicalSessionMessage[]) {
  const duplicateIds = new Set<string>();
  const localRuntimeMessagesByPairKey = new Map<string, CanonicalSessionMessage[]>();
  const localRuntimeMessagesByResponseKey = new Map<string, CanonicalSessionMessage[]>();
  const legacyCollaborationRelayMessages: CanonicalSessionMessage[] = [];

  for (const message of messages) {
    if (!isOwnedAgentTurn(message)) continue;
    if (message.sourceTransport === 'desktop-chat') {
      pushMapArray(localRuntimeMessagesByPairKey, localOwnedAgentPairKey(message), message);
      const responseKey = localOwnedAgentResponseKey(message);
      if (responseKey) pushMapArray(localRuntimeMessagesByResponseKey, responseKey, message);
    } else if (message.sourceTransport === 'desktop-bridge-session-relay') {
      legacyCollaborationRelayMessages.push(message);
    }
  }

  for (const legacyCollaborationMessage of legacyCollaborationRelayMessages) {
    const responseKey = localOwnedAgentResponseKey(legacyCollaborationMessage);
    const matchingLocalMessages = responseKey
      ? messagesInCreatedAtRange(
          localRuntimeMessagesByResponseKey.get(responseKey),
          legacyCollaborationMessage.createdAtMs - 30_000,
          legacyCollaborationMessage.createdAtMs + 30_000,
        )
      : [];
    if (matchingLocalMessages.length === 0) {
      // Cancelled/failed legacy fanout rows are pure status markers — when the
      // sender's instance also has a desktop-chat owned-agent turn for the same
      // request, the legacy transport row is the redundant copy.
      if (
        isPureLegacyCollaborationAgentStatusRow(legacyCollaborationMessage)
        && hasMessageInCreatedAtRange(
          localRuntimeMessagesByPairKey.get(localOwnedAgentPairKey(legacyCollaborationMessage)),
          legacyCollaborationMessage.createdAtMs - 30_000,
          legacyCollaborationMessage.createdAtMs + 30_000,
        )
      ) {
        duplicateIds.add(legacyCollaborationMessage.id);
      }
      continue;
    }

    const bestLocal = matchingLocalMessages.reduce((best, candidate) => {
      const candidateRichness = ownedAgentRuntimeRichness(candidate);
      const bestRichness = ownedAgentRuntimeRichness(best);
      if (candidateRichness !== bestRichness) return candidateRichness > bestRichness ? candidate : best;
      return Math.abs(candidate.createdAtMs - legacyCollaborationMessage.createdAtMs) < Math.abs(best.createdAtMs - legacyCollaborationMessage.createdAtMs)
        ? candidate
        : best;
    });

    for (const localMessage of matchingLocalMessages) {
      if (localMessage.id !== bestLocal.id) duplicateIds.add(localMessage.id);
    }
    duplicateIds.add(legacyCollaborationMessage.id);
  }

  return duplicateIds;
}

function noProviderRuntimeDuplicateIds(messages: CanonicalSessionMessage[]) {
  const requestIdsForMessage = (message: CanonicalSessionMessage) => {
    const content = contentRecord(message.content);
    return [message.parentMessageId, stringValue(content.replyToMessageId), stringValue(content.requestId)]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim());
  };
  const syntheticFailureIdsByRequestId = new Map<string, Set<string>>();
  for (const message of messages) {
    if (message.sourceTransport !== 'desktop-chat-ui') continue;
    if (message.messageKind !== 'agent-turn' || message.status !== 'failed') continue;
    const content = contentRecord(message.content);
    if (!isCloudAgentNoProviderConfiguredError(message.contentText || stringValue(content.error) || stringValue(content.detail))) continue;
    for (const requestId of requestIdsForMessage(message)) {
      const failureIds = syntheticFailureIdsByRequestId.get(requestId) ?? new Set<string>();
      failureIds.add(message.id);
      syntheticFailureIdsByRequestId.set(requestId, failureIds);
    }
  }
  const syntheticRequestIds = new Set(syntheticFailureIdsByRequestId.keys());
  if (syntheticRequestIds.size === 0) return new Set<string>();

  const duplicateIds = new Set<string>();
  for (const message of messages) {
    if (message.sourceTransport === 'desktop-chat' && message.messageKind === 'agent-turn') {
      const content = contentRecord(message.content);
      if (isCloudAgentNoProviderConfiguredError(message.contentText || stringValue(content.error) || stringValue(content.detail))) {
        if (requestIdsForMessage(message).some((requestId) => syntheticRequestIds.has(requestId))) {
          duplicateIds.add(message.id);
        }
      }
    }

    if (message.messageKind !== 'agent-turn') continue;
    if (message.senderRole !== 'owned-agent' && message.senderRole !== 'external-agent') continue;
    const content = contentRecord(message.content);
    const status = message.status.trim().toLowerCase();
    const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
    const isUnsuccessful = status === 'draft'
      || status === 'sending'
      || status === 'processing'
      || status === 'failed'
      || status === 'cancelled'
      || status === 'cancelling'
      || deliveryState === 'sending'
      || deliveryState === 'processing'
      || deliveryState === 'failed'
      || deliveryState === 'cancelled'
      || deliveryState === 'processing_failed';
    const errorText = message.contentText || stringValue(content.error) || stringValue(content.detail);
    if (isUnsuccessful || !message.contentText.trim() || isCloudAgentNoProviderConfiguredError(errorText)) continue;
    for (const requestId of requestIdsForMessage(message)) {
      for (const failureId of syntheticFailureIdsByRequestId.get(requestId) ?? []) {
        duplicateIds.add(failureId);
      }
    }
  }
  return duplicateIds;
}

function legacyCollaborationRelayAgentFanoutDuplicateIds(messages: CanonicalSessionMessage[]) {
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
    pushMapArray(messagesByRequest, key, message);
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

const STALE_LEGACY_COLLABORATION_PLACEHOLDER_MS = 10 * 60 * 1_000;

function isHumanConversationActivity(message: CanonicalSessionMessage) {
  return (message.senderRole === 'user' || message.senderRole === 'person')
    && message.messageKind !== 'agent-turn';
}

function legacyCollaborationRequestIdForMessage(message: CanonicalSessionMessage) {
  const content = contentRecord(message.content);
  const contentRequestId = stringValue(content.requestId)?.trim();
  if (contentRequestId) return contentRequestId;

  const sourceEventId = message.sourceEventId?.trim() ?? '';
  return /\bbridge_req_[A-Za-z0-9_]+\b/u.exec(sourceEventId)?.[0] ?? null;
}

function pendingLegacyCollaborationDelegationRequestKey(sessionId: string, requestId: string) {
  return `${sessionId}\u0000${requestId}`;
}

function pendingLegacyCollaborationDelegationRequestKeys(exchanges: CanonicalSessionState['delegatedExchanges']) {
  return new Set(exchanges.flatMap((exchange) => {
    const status = exchange.status.trim().toLowerCase();
    const requestId = exchange.sourceRequestId?.trim();
    if (!['pending', 'sending', 'processing'].includes(status) || !requestId) return [];
    return [pendingLegacyCollaborationDelegationRequestKey(exchange.sessionId, requestId)];
  }));
}

function pendingLegacyCollaborationDelegationIds(exchanges: CanonicalSessionState['delegatedExchanges']) {
  return new Set(exchanges.flatMap((exchange) => {
    const status = exchange.status.trim().toLowerCase();
    if (!['pending', 'sending', 'processing'].includes(status)) return [];
    return [exchange.id];
  }));
}

function rawLegacyCollaborationProcessingPlaceholderCoveredByPendingDelegation(
  message: CanonicalSessionMessage,
  pendingDelegationRequestKeys: Set<string>,
  pendingDelegationIds: Set<string>,
) {
  if (!isLegacyCollaborationAgentProcessingPlaceholder(message) || !isActiveProcessingStatus(message)) return false;
  const requestId = legacyCollaborationRequestIdForMessage(message);
  if (requestId && pendingDelegationRequestKeys.has(pendingLegacyCollaborationDelegationRequestKey(message.sessionId, requestId))) return true;
  const content = contentRecord(message.content);
  const delegatedExchangeId = message.delegatedExchangeId?.trim() || stringValue(content.delegatedExchangeId)?.trim();
  return Boolean(delegatedExchangeId && pendingDelegationIds.has(delegatedExchangeId));
}

function duplicateCloudGroupAgentResponseIds(messages: CanonicalSessionMessage[]) {
  const duplicateIds = new Set<string>();
  const responsesByRequest = new Map<string, CanonicalSessionMessage[]>();

  for (const message of messages) {
    if (message.messageKind !== 'agent-turn') continue;
    if (message.senderRole !== 'owned-agent' && message.senderRole !== 'external-agent') continue;
    if (message.sourceTransport !== 'cloud-group' && message.sourceTransport !== 'cloud-group-agent') continue;
    if (isProcessingPlaceholderText(message.contentText)) continue;
    const status = message.status.trim().toLowerCase();
    if (['draft', 'sending', 'processing'].includes(status)) continue;
    const content = contentRecord(message.content);
    const requestId = stringValue(content.requestId)?.trim()
      || stringValue(content.replyToMessageId)?.trim()
      || message.parentMessageId?.trim()
      || null;
    if (!requestId) continue;
    const key = [message.sessionId, message.senderIdentityId, requestId].join('\u0000');
    pushMapArray(responsesByRequest, key, message);
  }

  for (const responses of responsesByRequest.values()) {
    if (responses.length <= 1) continue;
    const sorted = [...responses].sort((left, right) => (
      right.createdAtMs - left.createdAtMs
      || right.sequenceNum - left.sequenceNum
      || right.id.localeCompare(left.id)
    ));
    for (const duplicate of sorted.slice(1)) duplicateIds.add(duplicate.id);
  }

  return duplicateIds;
}

function staleProcessingPlaceholderIds(messages: CanonicalSessionMessage[]) {
  const staleIds = new Set<string>();
  const completedByParticipant = new Map<string, CanonicalSessionMessage[]>();
  const completedWithoutRequestByParticipant = new Map<string, CanonicalSessionMessage[]>();
  const completedByParticipantAndRequest = new Map<string, CanonicalSessionMessage[]>();
  const latestHumanActivityBySessionId = new Map<string, number>();
  const participantKey = (message: CanonicalSessionMessage) => [
    message.sessionId,
    message.senderIdentityId,
    message.senderRole,
  ].join('\u0000');

  for (const message of messages) {
    if (isHumanConversationActivity(message)) {
      latestHumanActivityBySessionId.set(
        message.sessionId,
        Math.max(latestHumanActivityBySessionId.get(message.sessionId) ?? 0, message.createdAtMs),
      );
    }
    const completedAgentResponse = (
      (message.senderRole === 'owned-agent' || message.senderRole === 'external-agent')
      && message.messageKind === 'agent-turn'
      && !isProcessingPlaceholderText(message.contentText)
      && Boolean(message.contentText.trim())
      && !['draft', 'sending', 'processing'].includes(message.status.trim().toLowerCase())
    );
    if (!completedAgentResponse) continue;
    const baseKey = participantKey(message);
    pushMapArray(completedByParticipant, baseKey, message);
    const requestId = legacyCollaborationRequestIdForMessage(message);
    if (requestId) {
      pushMapArray(completedByParticipantAndRequest, `${baseKey}\u0000${requestId}`, message);
    } else {
      pushMapArray(completedWithoutRequestByParticipant, baseKey, message);
    }
  }

  for (const placeholder of messages) {
    if (!isStaleableProcessingPlaceholder(placeholder)) continue;
    const baseKey = participantKey(placeholder);
    const requestId = legacyCollaborationRequestIdForMessage(placeholder);
    const rangeStart = placeholder.createdAtMs;
    const rangeEnd = placeholder.createdAtMs + STALE_LEGACY_COLLABORATION_PLACEHOLDER_MS;
    const hasLaterResponse = requestId
      ? hasMessageInCreatedAtRange(completedByParticipantAndRequest.get(`${baseKey}\u0000${requestId}`), rangeStart, rangeEnd)
        || hasMessageInCreatedAtRange(completedWithoutRequestByParticipant.get(baseKey), rangeStart, rangeEnd)
      : hasMessageInCreatedAtRange(completedByParticipant.get(baseKey), rangeStart, rangeEnd);
    const hasMuchLaterHumanActivity = (
      (latestHumanActivityBySessionId.get(placeholder.sessionId) ?? 0)
      >= placeholder.createdAtMs + STALE_LEGACY_COLLABORATION_PLACEHOLDER_MS
    );
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
    sourceHostId: identity.sourceHostId,
    sourceIdentityId: identity.sourceIdentityId,
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
    const targetIdentity = identityById.get(exchange.targetIdentityId);
    if (targetIdentity?.kind !== 'agent') continue;
    const participants = canonicalParticipantsBySessionId.get(exchange.sessionId) ?? [];
    const activity: SessionTaskActivity = {
      id: exchange.id,
      sessionId: exchange.sessionId,
      status: exchange.status,
      initiator: taskParticipantFromIdentity(identityById.get(exchange.initiatorIdentityId), identityById, canonicalState.profile.humanIdentityId),
      target: taskParticipantFromIdentity(targetIdentity, identityById, canonicalState.profile.humanIdentityId),
      participants: participants.map((participant) => ({ ...participant })),
      createdAtMs: exchange.createdAtMs,
      updatedAtMs: exchange.updatedAtMs,
      sourceConversationId: exchange.sourceConversationId,
      sourceRequestId: exchange.sourceRequestId,
      contextPolicy: exchange.contextPolicy,
      error: exchange.error,
    };
    pushMapArray(activities, exchange.sessionId, activity);
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
    pushMapArray(participantsBySessionId, participant.sessionId, participant);
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
        kordiId: stringValue(contentRecord(identity.metadata).kordiId)?.trim() || null,
        name,
        publicName: identity.displayName,
        kind: identity.kind,
        role,
        source: identity.source,
        ownerIdentityId: identity.ownerIdentityId,
        ownerName,
        sourceHostId: identity.sourceHostId,
        sourceIdentityId: identity.sourceIdentityId,
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
  const latestReadableMessageBySessionId = new Map<string, CanonicalSessionMessage>();
  const latestActivityMessageBySessionId = new Map<string, CanonicalSessionMessage>();
  const readableMessageCountBySessionId = new Map<string, number>();
  const rawMessageById = new Map<string, CanonicalSessionMessage>();
  for (const message of canonicalState.messages) {
    const sessionMessages = rawMessagesBySessionId.get(message.sessionId);
    if (sessionMessages) {
      sessionMessages.push(message);
    } else {
      rawMessagesBySessionId.set(message.sessionId, [message]);
    }
    if (canonicalMessageCountsForLastActive(message)) {
      readableMessageCountBySessionId.set(
        message.sessionId,
        (readableMessageCountBySessionId.get(message.sessionId) ?? 0) + 1,
      );
      const latestReadable = latestReadableMessageBySessionId.get(message.sessionId);
      if (
        !latestReadable
        || message.sequenceNum > latestReadable.sequenceNum
        || (
          message.sequenceNum === latestReadable.sequenceNum
          && message.createdAtMs >= latestReadable.createdAtMs
        )
      ) {
        latestReadableMessageBySessionId.set(message.sessionId, message);
      }
      const latestActivity = latestActivityMessageBySessionId.get(message.sessionId);
      if (!latestActivity || message.createdAtMs >= latestActivity.createdAtMs) {
        latestActivityMessageBySessionId.set(message.sessionId, message);
      }
    }
    rawMessageById.set(message.id, message);
  }
  const messageSortById = buildMessageSortPositions(canonicalState.messages);

  const legacyCollaborationDelegationFallbackKeys = new Set(
    canonicalState.delegatedExchanges.flatMap((exchange) => {
      if (!exchange.sourceRequestId) return [];
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
  const pendingDelegationRequestKeys = pendingLegacyCollaborationDelegationRequestKeys(canonicalState.delegatedExchanges);
  const pendingDelegationIds = pendingLegacyCollaborationDelegationIds(canonicalState.delegatedExchanges);
  const processingDelegationMessagesBySessionId = new Map<string, SortableCanonicalMessage[]>();
  const cancelledDelegationMessagesBySessionId = new Map<string, SortableCanonicalMessage[]>();
  for (const exchange of canonicalState.delegatedExchanges) {
    const status = exchange.status.trim().toLowerCase();
    if (!['pending', 'sending', 'processing'].includes(status)) continue;
    if (!exchange.sourceRequestId) {
      if (exchange.transport?.trim().toLowerCase() === 'bridge') continue;
      const fallbackKey = delegationOptimisticFallbackKey(exchange);
      if (fallbackKey && (legacyCollaborationDelegationFallbackKeys.has(fallbackKey) || completedDelegationFallbackKeys.has(fallbackKey))) continue;
    }
    if (exchange.responseMessageId) {
      const responseMessage = rawMessageById.get(exchange.responseMessageId);
      if (responseMessage && !rawLegacyCollaborationProcessingPlaceholderCoveredByPendingDelegation(responseMessage, pendingDelegationRequestKeys, pendingDelegationIds)) continue;
    }
    const target = identityById.get(exchange.targetIdentityId);
    if (!target || target.kind !== 'agent') continue;
    pushMapArray(processingDelegationMessagesBySessionId, exchange.sessionId, {
      message: processingAgentMessage(exchange, target, identityById, canonicalState.profile.humanIdentityId),
      ...exchangeSortPosition(exchange, messageSortById),
      tieBreakAtMs: exchange.createdAtMs,
    });
  }

  for (const exchange of canonicalState.delegatedExchanges) {
    if (exchange.status.trim().toLowerCase() !== 'cancelled') continue;
    const target = identityById.get(exchange.targetIdentityId);
    if (!target || target.kind !== 'agent') continue;
    const stoppedMessage = cancelledCollaborationAgentDelegationMessage(exchange, target, identityById, canonicalState.profile.humanIdentityId);
    if (!stoppedMessage) continue;
    pushMapArray(cancelledDelegationMessagesBySessionId, exchange.sessionId, {
      message: stoppedMessage,
      ...exchangeSortPosition(exchange, messageSortById),
      tieBreakAtMs: exchange.createdAtMs,
    });
  }
  const canonicalMessagesBySessionId = new Map<string, Message[]>();
  const rawMessageCountBySessionId = new Map<string, number>();
  for (const [sessionId, messages] of rawMessagesBySessionId) {
    const sortedMessages = [...messages].sort((left, right) => left.createdAtMs - right.createdAtMs || left.sequenceNum - right.sequenceNum);
    const directLegacyCollaborationSourceEvents = new Set(
      sortedMessages
        .filter((message) => message.sourceTransport === 'desktop-bridge' && message.sourceEventId)
        .map((message) => message.sourceEventId!),
    );
    const delegatedOutreachDirectSources = new Set(
      sortedMessages.flatMap((message) => {
        const directSource = directCollaborationSourceEventForOutreachDuplicate(message);
        if (!directSource || !directLegacyCollaborationSourceEvents.has(directSource)) return [];
        const content = contentRecord(message.content);
        const isDelegatedOutreach = Boolean(message.delegatedExchangeId)
          || Boolean(stringValue(content.delegatedExchangeId))
          || stringValue(content.kind) === 'mention-request';
        return isDelegatedOutreach ? [directSource] : [];
      }),
    );
    const seenJoinEventKeys = new Set<string>();
    const suppressedLegacyCollaborationUiEchoIds = legacyCollaborationUiOptimisticEchoIds(sortedMessages);
    const localAgentRuntimeUserEchoes = localAgentRuntimeUserEchoMatches(sortedMessages);
    const suppressedLocalRuntimeEchoIds = localAgentRuntimeUserEchoes.runtimeEchoIds;
    const confirmedLocalAgentUiMessageIds = localAgentRuntimeUserEchoes.confirmedUiIds;
    const suppressedLocalRuntimeDuplicateIds = localOwnedAgentRuntimeDuplicateIds(sortedMessages);
    const suppressedLegacyCollaborationRelayAgentFanoutDuplicateIds = legacyCollaborationRelayAgentFanoutDuplicateIds(sortedMessages);
    const suppressedNoProviderRuntimeDuplicateIds = noProviderRuntimeDuplicateIds(sortedMessages);
    const suppressedCloudGroupAgentResponseDuplicateIds = duplicateCloudGroupAgentResponseIds(sortedMessages);
    const suppressedSelfAgentMirrorDuplicateIds = selfAgentMirrorDuplicateIds(
      sortedMessages,
      identityById,
      canonicalState.profile.humanIdentityId,
      sessionById.get(sessionId)?.kind === 'self-agent',
    );
    const suppressedStaleProcessingPlaceholderIds = staleProcessingPlaceholderIds(sortedMessages);
    const suppressedAgedLegacyCollaborationProcessingPlaceholderIds = new Set(
      sortedMessages.filter(isAgedLegacyCollaborationProcessingPlaceholder).map((message) => message.id),
    );
    const suppressedPendingDelegationRawProcessingPlaceholderIds = new Set(
      sortedMessages
        .filter((message) => rawLegacyCollaborationProcessingPlaceholderCoveredByPendingDelegation(message, pendingDelegationRequestKeys, pendingDelegationIds))
        .map((message) => message.id),
    );
    const suppressedCompletedCallStartIds = completedCallStartMessageIds(sortedMessages);
    rawMessageCountBySessionId.set(sessionId, sortedMessages.length);
    const senderIdentityIdByMessageId = new Map<string, string>(
      sortedMessages.map((message) => [message.id, message.senderIdentityId]),
    );
    const visibleReplyTargetByMessageId = new Map<string, string>();
    for (const message of sortedMessages) {
      const parentMessageId = message.parentMessageId?.trim();
      if (!parentMessageId) continue;
      const content = contentRecord(message.content);
      if (stringValue(content.kind) === 'delegation-join-event') {
        visibleReplyTargetByMessageId.set(message.id, parentMessageId);
      }
    }
    const mappedMessages = sortedMessages.flatMap<SortableCanonicalMessage>((message) => {
      if (
        suppressedLegacyCollaborationUiEchoIds.has(message.id)
        || suppressedLocalRuntimeEchoIds.has(message.id)
        || suppressedLocalRuntimeDuplicateIds.has(message.id)
        || suppressedLegacyCollaborationRelayAgentFanoutDuplicateIds.has(message.id)
        || suppressedNoProviderRuntimeDuplicateIds.has(message.id)
        || suppressedCloudGroupAgentResponseDuplicateIds.has(message.id)
        || suppressedSelfAgentMirrorDuplicateIds.has(message.id)
        || suppressedStaleProcessingPlaceholderIds.has(message.id)
        || suppressedAgedLegacyCollaborationProcessingPlaceholderIds.has(message.id)
        || suppressedPendingDelegationRawProcessingPlaceholderIds.has(message.id)
        || suppressedCompletedCallStartIds.has(message.id)
      ) return [];
      const displaySourceMessage: CanonicalSessionMessage = confirmedLocalAgentUiMessageIds.has(message.id)
        ? {
            ...message,
            status: 'sent',
            content: {
              ...contentRecord(message.content),
              deliveryState: 'sent',
            },
          }
        : message;
      const content = contentRecord(displaySourceMessage.content);
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
      const duplicatedDirectLegacyCollaborationSource = directCollaborationSourceEventForOutreachDuplicate(message);
      if (duplicatedDirectLegacyCollaborationSource
        && directLegacyCollaborationSourceEvents.has(duplicatedDirectLegacyCollaborationSource)
        && !delegatedOutreachDirectSources.has(duplicatedDirectLegacyCollaborationSource)) {
        return [];
      }
      const mapped = mapCanonicalMessage(
        displaySourceMessage,
        identityById,
        canonicalState.profile.humanIdentityId,
        { senderIdentityIdByMessageId, visibleReplyTargetByMessageId },
      );
      if (!mapped) return [];
      const runtimeReplyAliasIds = localAgentRuntimeUserEchoes.runtimeReplyAliasIdsByUiId.get(message.id) ?? [];
      const mappedWithRuntimeAliases = runtimeReplyAliasIds.length > 0
        ? { ...mapped, replyAliasIds: [...new Set([...(mapped.replyAliasIds ?? []), ...runtimeReplyAliasIds])] }
        : mapped;
      const displayMessage = mappedWithRuntimeAliases.role === 'user' && failedDelegationRequestMessageIds.has(message.id)
        ? { ...mappedWithRuntimeAliases, statusChips: ['failed'] }
        : inheritedDesktopForkSnapshot(sessionById.get(sessionId), displaySourceMessage)
          ? { ...mappedWithRuntimeAliases, isForkSnapshot: true }
          : mappedWithRuntimeAliases;
      return [{
        message: displayMessage,
        ...(messageSortById.get(message.id) ?? messageSortPosition(message)),
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
    rawMessagesBySessionId,
    latestReadableMessageBySessionId,
    latestActivityMessageBySessionId,
    rawMessageCountBySessionId,
    readableMessageCountBySessionId,
    delegatedExchangeCountBySessionId,
    taskActivitiesBySessionId,
    contextSnapshotCountBySessionId,
    presenceSummaryBySessionId,
  };
}
