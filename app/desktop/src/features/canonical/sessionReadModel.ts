import type {
  CanonicalSessionState,
  CanonicalSessionSummary,
  Conversation,
  ConversationBridgeTarget,
  ConversationParticipant,
  Message,
  SessionTaskActivity,
} from '@/kordi-app/types';
import { isCanonicalBridgeSessionId } from '@/features/canonical/sessionResolver';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import { isCloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentMessages';
import { formatDesktopLastActiveLabel } from '@/lib/time';
import { buildCanonicalIndexes } from './readModel/indexes';
import type { CanonicalIndexes } from './readModel/indexes';
import {
  sessionChatActivityAtMs,
  sessionConversationDisplayTitle,
  sessionHasActiveProcessing,
  sessionHasManualTitle,
  sessionMetadata,
  sessionUnreadCount,
  sessionViewMetadata,
  shouldUseCanonicalMessages,
  syntheticBridgeTarget,
  syntheticConversation,
  syntheticParticipantSpaceId,
} from './readModel/conversationMapping';
import type { ConversationSubtitleBuilder } from './readModel/conversationMapping';

type CanonicalConversationLike = {
  id: string;
  canonicalSessionId?: string;
  canonicalStoragePath?: string;
  canonicalParticipantCount?: number;
  canonicalMessageCount?: number;
  canonicalDelegatedExchangeCount?: number;
  taskActivities?: SessionTaskActivity[];
  canonicalContextSnapshotCount?: number;
  canonicalPresenceSummary?: string;
  desktopRuntimeBacked?: boolean;
  desktopRuntimeTranscriptLoaded?: boolean;
  canonicalParticipants?: ConversationParticipant[];
  bridgeTarget?: ConversationBridgeTarget | null;
  bridgeUnreadByParentSessionId?: Record<string, number>;
  bridges: string[];
  trust: string;
  outreach?: { parentSessionId?: string | null } | null;
  participantSpaceId?: string | null;
  directness?: string | null;
  statusIndicator?: Conversation['statusIndicator'];
  updatedAtLabel?: string;
  unread?: number;
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
  name: string;
  subtitle: string;
  participants: string[];
  messages: Message[];
};

function messageResponseText(message: Message) {
  return (message.turn?.assistantText ?? message.text).trim();
}

function comparableAgentResponseText(value: string) {
  return value.trim().replace(/\s+/gu, '');
}

function sameAgentResponseText(left: string, right: string) {
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (!leftTrimmed || !rightTrimmed) return false;
  return leftTrimmed === rightTrimmed
    || comparableAgentResponseText(leftTrimmed) === comparableAgentResponseText(rightTrimmed);
}

function runtimeTranscriptAnchorKey(message: Message) {
  const text = messageResponseText(message).replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!text) return null;
  return [message.role, message.time.trim(), text].join('\u0000');
}

function firstIndexGreaterThan(sortedValues: readonly number[], target: number) {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (sortedValues[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstUnusedCanonicalIndex(
  candidates: readonly number[],
  startIndex: number,
  usedCanonicalIndexes: ReadonlySet<number>,
) {
  for (let index = startIndex; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!usedCanonicalIndexes.has(candidate)) return { candidate, nextCursor: index + 1 };
  }
  return null;
}

export function mergeCanonicalHistoryIntoRuntime(
  canonicalMessages: Message[],
  runtimeMessages: Message[],
) {
  const runtimeMessageIds = new Set(runtimeMessages.flatMap((message) => (
    [message.id, message.entryId].filter((value): value is string => Boolean(value?.trim()))
  )));

  const canonicalIndexesById = new Map<string, number>();
  const canonicalIndexesByAnchor = new Map<string, number[]>();
  canonicalMessages.forEach((message, canonicalIndex) => {
    if (message.messageAction?.kind === 'forward') return;
    for (const id of [message.id, message.entryId]) {
      if (id?.trim()) canonicalIndexesById.set(id, canonicalIndex);
    }
    const anchorKey = runtimeTranscriptAnchorKey(message);
    if (!anchorKey) return;
    const indexes = canonicalIndexesByAnchor.get(anchorKey);
    if (indexes) indexes.push(canonicalIndex);
    else canonicalIndexesByAnchor.set(anchorKey, [canonicalIndex]);
  });

  const usedCanonicalIndexes = new Set<number>();
  const fallbackCursorByAnchor = new Map<string, number>();
  let lastCanonicalIndex = -1;
  const runtimeAnchorIndexes = runtimeMessages.map((message) => {
    let stableMatch: number | undefined;
    for (const id of [message.id, message.entryId]) {
      const canonicalIndex = id?.trim() ? canonicalIndexesById.get(id) : undefined;
      if (canonicalIndex !== undefined && !usedCanonicalIndexes.has(canonicalIndex)) {
        stableMatch = canonicalIndex;
        break;
      }
    }
    const anchorKey = runtimeTranscriptAnchorKey(message);
    const candidates = anchorKey ? canonicalIndexesByAnchor.get(anchorKey) ?? [] : [];
    const preferredMatch = stableMatch === undefined
      ? firstUnusedCanonicalIndex(
          candidates,
          firstIndexGreaterThan(candidates, lastCanonicalIndex),
          usedCanonicalIndexes,
        )
      : null;
    const fallbackMatch = stableMatch !== undefined || preferredMatch || !anchorKey
      ? null
      : firstUnusedCanonicalIndex(
          candidates,
          fallbackCursorByAnchor.get(anchorKey) ?? 0,
          usedCanonicalIndexes,
        );
    if (anchorKey && fallbackMatch) fallbackCursorByAnchor.set(anchorKey, fallbackMatch.nextCursor);
    const canonicalIndex = stableMatch
      ?? preferredMatch?.candidate
      ?? fallbackMatch?.candidate
      ?? null;
    if (canonicalIndex === null) return null;
    usedCanonicalIndexes.add(canonicalIndex);
    if (canonicalIndex > lastCanonicalIndex) lastCanonicalIndex = canonicalIndex;
    return canonicalIndex;
  });

  const overlayMessages = canonicalMessages
    .map((message, canonicalIndex) => ({ message, canonicalIndex }))
    .filter(({ message, canonicalIndex }) => (
      !usedCanonicalIndexes.has(canonicalIndex)
      && ![message.id, message.entryId].some((value) => Boolean(value && runtimeMessageIds.has(value)))
    ));
  if (overlayMessages.length === 0) return runtimeMessages;
  if (runtimeMessages.length === 0) return overlayMessages.map(({ message }) => message);

  const canonicalBeforeRuntimeIndex = Array.from(
    { length: runtimeMessages.length + 1 },
    () => [] as Message[],
  );
  const matchedAnchors = runtimeAnchorIndexes.flatMap((canonicalIndex, runtimeIndex) => (
    canonicalIndex === null ? [] : [{ canonicalIndex, runtimeIndex }]
  )).sort((left, right) => left.canonicalIndex - right.canonicalIndex);
  const matchedCanonicalIndexes = matchedAnchors.map((anchor) => anchor.canonicalIndex);
  const prefixLatestRuntimeIndex = matchedAnchors.map((anchor) => anchor.runtimeIndex);
  for (let index = 1; index < prefixLatestRuntimeIndex.length; index += 1) {
    prefixLatestRuntimeIndex[index] = Math.max(prefixLatestRuntimeIndex[index - 1], prefixLatestRuntimeIndex[index]);
  }
  const suffixEarliestRuntimeIndex = matchedAnchors.map((anchor) => anchor.runtimeIndex);
  for (let index = suffixEarliestRuntimeIndex.length - 2; index >= 0; index -= 1) {
    suffixEarliestRuntimeIndex[index] = Math.min(suffixEarliestRuntimeIndex[index], suffixEarliestRuntimeIndex[index + 1]);
  }
  const unmatchedRuntimeIndexes = runtimeAnchorIndexes.flatMap((canonicalIndex, runtimeIndex) => (
    canonicalIndex === null ? [runtimeIndex] : []
  ));
  for (const { message, canonicalIndex } of overlayMessages) {
    const nextAnchorPosition = firstIndexGreaterThan(matchedCanonicalIndexes, canonicalIndex);
    const nextRuntimeIndex = suffixEarliestRuntimeIndex[nextAnchorPosition];
    if (nextRuntimeIndex !== undefined) {
      canonicalBeforeRuntimeIndex[nextRuntimeIndex].push(message);
      continue;
    }

    const lastEarlierRuntimeIndex = nextAnchorPosition > 0
      ? prefixLatestRuntimeIndex[nextAnchorPosition - 1]
      : -1;
    const unmatchedPosition = firstIndexGreaterThan(unmatchedRuntimeIndexes, lastEarlierRuntimeIndex);
    const targetIndex = unmatchedRuntimeIndexes[unmatchedPosition] ?? runtimeMessages.length;
    canonicalBeforeRuntimeIndex[targetIndex].push(message);
  }

  return runtimeMessages.flatMap((message, runtimeIndex) => [
    ...canonicalBeforeRuntimeIndex[runtimeIndex],
    message,
  ]).concat(canonicalBeforeRuntimeIndex[runtimeMessages.length]);
}

function comparableToolSignature(message: Message) {
  const tools = message.turn?.tools ?? [];
  if (tools.length === 0) return null;
  return tools
    .map((tool) => [tool.id ?? '', tool.name ?? '', tool.status ?? ''].join(''))
    .sort()
    .join('');
}

function sameOwnedAgentTurn(canonical: Message, local: Message) {
  if (canonical.role !== 'owned-agent' || local.role !== 'owned-agent') return false;
  const canonicalText = messageResponseText(canonical);
  const localText = messageResponseText(local);
  if (canonicalText && localText && sameAgentResponseText(canonicalText, localText)) return true;
  const canonicalTools = comparableToolSignature(canonical);
  const localTools = comparableToolSignature(local);
  if (canonicalTools && localTools && canonicalTools === localTools) return true;
  const canonicalThinking = canonical.turn?.thinkingText?.trim() ?? '';
  const localThinking = local.turn?.thinkingText?.trim() ?? '';
  if (canonicalThinking && localThinking && sameAgentResponseText(canonicalThinking, localThinking)) return true;
  return false;
}

function isBridgeProcessingOnlyRuntimePlaceholder(message: Message) {
  if (!message.id?.startsWith('bridge-live-turn:') || !message.turn) return false;
  return !message.turn.completed
    && !message.text.trim()
    && !message.turn.assistantText.trim()
    && !message.turn.thinkingText.trim()
    && message.turn.tools.length === 0;
}

function hasLocalOwnedAgentRuntimeStatus(message: Message) {
  return message.role === 'owned-agent'
    && Boolean(message.turn)
    && !isBridgeProcessingOnlyRuntimePlaceholder(message)
    && (
      (message.turn?.tools?.length ?? 0) > 0
      || (message.turn?.thinkingText?.trim().length ?? 0) > 0
      || message.turn?.completed === false
    );
}

function isPendingCanonicalAgentPlaceholder(message: Message) {
  return Boolean(
    message.turn
      && !message.turn.completed
      && (message.role === 'owned-agent' || message.role === 'external-agent')
      && message.id?.startsWith('canonical-delegation-processing:'),
  );
}

function localRuntimeProgressForCanonicalPlaceholder(canonicalMessage: Message, localMessage: Message): Message {
  if (!localMessage.turn) return canonicalMessage;
  const canonicalReplyToMessageId = canonicalMessage.replyToMessageId ?? canonicalMessage.turn?.replyToMessageId;
  return {
    ...localMessage,
    id: canonicalMessage.id,
    role: canonicalMessage.role,
    replyToMessageId: canonicalReplyToMessageId ?? localMessage.replyToMessageId,
    sourceMessage: canonicalMessage.sourceMessage ?? localMessage.sourceMessage,
    replyAliasIds: canonicalMessage.replyAliasIds ?? localMessage.replyAliasIds,
    turn: {
      ...localMessage.turn,
      id: canonicalMessage.turn?.id ?? localMessage.turn.id,
      sessionId: canonicalMessage.turn?.sessionId ?? localMessage.turn.sessionId,
      replyToMessageId: canonicalReplyToMessageId ?? localMessage.turn.replyToMessageId,
      sourceMessage: canonicalMessage.turn?.sourceMessage ?? localMessage.turn.sourceMessage,
      pendingBridgeAgentRequest: canonicalMessage.turn?.pendingBridgeAgentRequest ?? localMessage.turn.pendingBridgeAgentRequest,
    },
  };
}

function ownedAgentTurnMatchKeys(message: Message) {
  if (message.role !== 'owned-agent') return [];
  const keys: string[] = [];
  const responseText = messageResponseText(message);
  if (responseText) keys.push(`text:${comparableAgentResponseText(responseText)}`);
  const tools = comparableToolSignature(message);
  if (tools) keys.push(`tools:${tools}`);
  const thinking = message.turn?.thinkingText?.trim() ?? '';
  if (thinking) keys.push(`thinking:${comparableAgentResponseText(thinking)}`);
  return keys;
}

function mergeLocalOwnedAgentRuntimeStatus(
  canonicalMessages: Message[],
  existingMessages: Message[],
) {
  const merged = [...canonicalMessages];
  const canonicalIndexesByMatchKey = new Map<string, number[]>();
  const indexMessage = (message: Message, index: number) => {
    for (const key of ownedAgentTurnMatchKeys(message)) {
      const indexes = canonicalIndexesByMatchKey.get(key);
      if (indexes) indexes.push(index);
      else canonicalIndexesByMatchKey.set(key, [index]);
    }
  };
  merged.forEach(indexMessage);

  const pendingCanonicalIndexesByRole = new Map<Message['role'], number[]>();
  merged.forEach((message, index) => {
    if (!isPendingCanonicalAgentPlaceholder(message)) return;
    const indexes = pendingCanonicalIndexesByRole.get(message.role);
    if (indexes) indexes.push(index);
    else pendingCanonicalIndexesByRole.set(message.role, [index]);
  });

  for (const localMessage of existingMessages.filter(hasLocalOwnedAgentRuntimeStatus)) {
    if (localMessage.turn && !localMessage.turn.completed) {
      const pendingCanonicalIndex = (pendingCanonicalIndexesByRole.get(localMessage.role) ?? [])
        .find((index) => isPendingCanonicalAgentPlaceholder(merged[index]));
      if (pendingCanonicalIndex !== undefined) {
        merged[pendingCanonicalIndex] = localRuntimeProgressForCanonicalPlaceholder(
          merged[pendingCanonicalIndex],
          localMessage,
        );
        indexMessage(merged[pendingCanonicalIndex], pendingCanonicalIndex);
        continue;
      }
    }

    const candidateIndexes = new Set<number>();
    for (const key of ownedAgentTurnMatchKeys(localMessage)) {
      for (const index of canonicalIndexesByMatchKey.get(key) ?? []) candidateIndexes.add(index);
    }
    const matchingCanonicalIndex = [...candidateIndexes]
      .sort((left, right) => left - right)
      .find((index) => sameOwnedAgentTurn(merged[index], localMessage));
    if (matchingCanonicalIndex !== undefined) {
      merged[matchingCanonicalIndex] = localMessage;
      indexMessage(localMessage, matchingCanonicalIndex);
    } else {
      const nextIndex = merged.length;
      merged.push(localMessage);
      indexMessage(localMessage, nextIndex);
    }
  }
  return merged;
}

function shouldKeepLegacyChatConversationExtra(
  conversation: Conversation,
  indexes: CanonicalIndexes,
) {
  if (conversation.outreach?.parentSessionId?.trim()) {
    return false;
  }

  if (isLocalDraftChatConversationId(conversation.id)) {
    return true;
  }

  const sessionId = conversation.canonicalSessionId ?? conversation.id;
  if (indexes.sessionById.has(sessionId)) {
    return false;
  }

  return conversation.id.startsWith('bridge:')
    || isCanonicalBridgeSessionId(sessionId)
    || conversation.bridges.some((bridge) => bridge.trim().toLowerCase() === 'local')
    || !conversation.canonicalSessionId;
}

function isChatCreatedDirectAgentSession(session: CanonicalSessionState['sessions'][number]) {
  return session.kind === 'direct-agent' && sessionMetadata(session).createdFrom === 'chat-create-flow';
}

function visibleParticipantsForSession(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
) {
  if (!isChatCreatedDirectAgentSession(session)) return participants;
  const primaryIdentityId = session.primaryIdentityId?.trim();
  return participants.filter((participant) => (
    participant.role === 'self'
    || (primaryIdentityId && participant.id === primaryIdentityId)
  ));
}

function metadataStringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bridgeTargetForSession(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
  indexes: CanonicalIndexes,
) {
  let currentSession: CanonicalSessionState['sessions'][number] | undefined = session;
  let currentParticipants = participants;
  const visitedSessionIds = new Set<string>();

  while (currentSession && !visitedSessionIds.has(currentSession.id)) {
    visitedSessionIds.add(currentSession.id);
    const target = syntheticBridgeTarget(currentSession, currentParticipants);
    if (target) return target;

    const sourceSessionId = metadataStringValue(sessionMetadata(currentSession).continuedFromSessionId);
    if (!sourceSessionId) return null;
    currentSession = indexes.sessionById.get(sourceSessionId);
    currentParticipants = indexes.canonicalParticipantsBySessionId.get(sourceSessionId) ?? [];
  }

  return null;
}

function addUnreadForSession(unreadBySessionId: Map<string, number>, sessionId: string | null | undefined, count: number | null | undefined) {
  const normalizedSessionId = sessionId?.trim();
  const unread = Math.max(0, count ?? 0);
  if (!normalizedSessionId || unread <= 0) return;
  unreadBySessionId.set(normalizedSessionId, (unreadBySessionId.get(normalizedSessionId) ?? 0) + unread);
}

function mergedUnreadBySessionId(conversations: Conversation[]) {
  const unreadBySessionId = new Map<string, number>();
  for (const conversation of conversations) {
    const scopedUnread = conversation.bridgeUnreadByParentSessionId ?? {};
    const scopedEntries = Object.entries(scopedUnread);
    if (scopedEntries.length > 0) {
      for (const [sessionId, unread] of scopedEntries) {
        addUnreadForSession(unreadBySessionId, sessionId, unread);
      }
      continue;
    }
    addUnreadForSession(unreadBySessionId, conversation.canonicalSessionId ?? conversation.id, conversation.unread);
  }
  return unreadBySessionId;
}

function withMergedUnreadForSession<T extends Conversation>(conversation: T, sessionId: string, unread: number): T {
  return {
    ...conversation,
    unread,
    bridgeUnreadByParentSessionId: {
      ...(conversation.bridgeUnreadByParentSessionId ?? {}),
      [sessionId]: unread,
    },
  };
}

export type CanonicalSessionReadModel = {
  sessionTitle: (sessionId: string, fallback: string) => string;
  participantNames: (sessionId: string, fallback: string[]) => string[];
  participantDetails: (sessionId: string) => ConversationParticipant[];
  taskActivities: (sessionId: string) => SessionTaskActivity[];
  messages: (sessionId: string) => Message[];
  preferMessages: (sessionId: string, existingMessages: Message[]) => Message[];
  applyConversation: <T extends CanonicalConversationLike>(
    conversation: T,
    buildSubtitle: ConversationSubtitleBuilder,
  ) => T;
  buildChatConversations: (conversations: Conversation[], buildSubtitle: ConversationSubtitleBuilder) => Conversation[];
};

export function createCanonicalSessionReadModel(
  canonicalState: CanonicalSessionState | null,
  options: {
    summaries?: CanonicalSessionSummary[];
    cloudUnreadReady?: boolean;
  } = {},
): CanonicalSessionReadModel | null {
  if (!canonicalState) return null;

  const indexes = buildCanonicalIndexes(canonicalState);
  const cloudUnreadReady = options.cloudUnreadReady ?? true;
  const summaryBySessionId = new Map((options.summaries ?? []).map((summary) => [summary.sessionId, summary]));
  const sessionActivityAtMs = (session: CanonicalSessionState['sessions'][number]) => (
    indexes.latestActivityMessageBySessionId.get(session.id)?.createdAtMs
    || sessionChatActivityAtMs(session)
  );
  const latestActivityMessages = (sessionId: string) => {
    const latest = indexes.latestActivityMessageBySessionId.get(sessionId);
    return latest ? [latest] : [];
  };
  const chatSessions = canonicalState.sessions
    .filter((session) => session.kind !== 'project' && session.status !== 'archived' && !isCloudAgentRuntimeSessionId(session.id))
    .sort((left, right) => sessionActivityAtMs(right) - sessionActivityAtMs(left));

  const hasSelfReadLatestMessage = (sessionId: string) => {
    const latestMessage = indexes.latestReadableMessageBySessionId.get(sessionId);
    if (!latestMessage) return false;
    const participants = indexes.participantsBySessionId.get(sessionId) ?? [];
    const selfParticipant = participants.find((participant) => (
      participant.role === 'self'
      && (!indexes.profileHumanIdentityId || participant.identityId === indexes.profileHumanIdentityId)
    )) ?? participants.find((participant) => participant.role === 'self');
    return selfParticipant?.lastReadMessageId === latestMessage.id;
  };

  const unreadCountForSession = (session: CanonicalSessionState['sessions'][number]) => (
    hasSelfReadLatestMessage(session.id) ? 0 : sessionUnreadCount(session)
  );

  return {
    sessionTitle(sessionId, fallback) {
      return indexes.sessionById.get(sessionId)?.title || fallback;
    },
    participantNames(sessionId, fallback) {
      const names = (indexes.canonicalParticipantsBySessionId.get(sessionId) ?? []).map((participant) => participant.name);
      return names.length > 0 ? names : fallback;
    },
    participantDetails(sessionId) {
      return indexes.canonicalParticipantsBySessionId.get(sessionId) ?? [];
    },
    taskActivities(sessionId) {
      return indexes.taskActivitiesBySessionId.get(sessionId) ?? [];
    },
    messages(sessionId) {
      return indexes.canonicalMessagesBySessionId.get(sessionId) ?? [];
    },
    preferMessages(sessionId, existingMessages) {
      const canonicalMessages = indexes.canonicalMessagesBySessionId.get(sessionId) ?? [];
      return shouldUseCanonicalMessages(existingMessages, canonicalMessages) ? canonicalMessages : existingMessages;
    },
    applyConversation(conversation, buildSubtitle) {
      const sessionId = conversation.canonicalSessionId ?? conversation.id;
      const session = indexes.sessionById.get(sessionId);
      if (!session) return conversation;

      const isBridgePersonSession = session.kind === 'direct-person' && isCanonicalBridgeSessionId(sessionId);
      const isBridgeSessionThread = sessionMetadata(session).source === 'bridge-session-thread';
      const isChatCreatedDirectAgent = isChatCreatedDirectAgentSession(session);
      const canonicalMessages = this.messages(sessionId);
      const messages = conversation.desktopRuntimeBacked && conversation.desktopRuntimeTranscriptLoaded
        ? mergeCanonicalHistoryIntoRuntime(canonicalMessages, conversation.messages)
        : (isBridgePersonSession || isBridgeSessionThread || isChatCreatedDirectAgent) && canonicalMessages.length > 0
        ? isChatCreatedDirectAgent
          ? canonicalMessages
          : mergeLocalOwnedAgentRuntimeStatus(canonicalMessages, conversation.messages)
        : this.preferMessages(sessionId, conversation.messages);
      const rawCanonicalParticipants = this.participantDetails(sessionId);
      const canonicalParticipants = visibleParticipantsForSession(session, rawCanonicalParticipants);
      const participants = canonicalParticipants.length > 0
        ? canonicalParticipants.map((participant) => participant.name)
        : conversation.participants;
      const displayTitle = sessionConversationDisplayTitle(session, canonicalParticipants, messages, session.title || conversation.name, { preferFallback: sessionHasManualTitle(session) });
      const latestTime = formatDesktopLastActiveLabel(sessionActivityAtMs(session));
      const hasActiveProcessing = sessionHasActiveProcessing(messages);
      const directBridgeTarget = conversation.bridgeTarget ?? syntheticBridgeTarget(session, rawCanonicalParticipants);
      const bridgeTarget = directBridgeTarget ?? bridgeTargetForSession(session, rawCanonicalParticipants, indexes);
      const inheritedBridgeTarget = !directBridgeTarget && Boolean(bridgeTarget);

      const scopedUnread = cloudUnreadReady
        ? conversation.bridgeUnreadByParentSessionId
          ? conversation.bridgeUnreadByParentSessionId[sessionId] ?? 0
          : conversation.unread ?? 0
        : 0;
      const canonicalUnread = cloudUnreadReady ? unreadCountForSession(session) : 0;
      const unread = canonicalUnread === 0 && hasSelfReadLatestMessage(sessionId) ? 0 : Math.max(scopedUnread, canonicalUnread);
      const taskActivities = this.taskActivities(sessionId);

      // Surface fork lineage stored in canonical metadata so cloned
      // canonical fork sessions render the same Forked-from pill +
      // sidebar nesting as native local forks.
      const canonicalMetadata = sessionViewMetadata(session);
      const canonicalForkMetadata =
        canonicalMetadata && typeof canonicalMetadata === 'object'
          ? (canonicalMetadata as Record<string, unknown>).fork
          : undefined;
      const canonicalForkRecord =
        canonicalForkMetadata && typeof canonicalForkMetadata === 'object'
          ? canonicalForkMetadata as Record<string, unknown>
          : undefined;
      const canonicalForkedFromSessionId = typeof canonicalForkRecord?.forkedFromSessionId === 'string'
        ? (canonicalForkRecord.forkedFromSessionId as string).trim() || null
        : null;
      const canonicalForkedFromMessageId = typeof canonicalForkRecord?.forkedFromMessageId === 'string'
        ? (canonicalForkRecord.forkedFromMessageId as string).trim() || null
        : null;

      return {
        ...conversation,
        canonicalSessionId: sessionId,
        canonicalCreatedByIdentityId: session.createdByIdentityId,
        canonicalStoragePath: indexes.storagePath,
        name: displayTitle,
        subtitle: buildSubtitle(messages, conversation.subtitle),
        unread,
        bridges: inheritedBridgeTarget ? ['Bridge'] : conversation.bridges,
        trust: inheritedBridgeTarget ? 'Bridge' : conversation.trust,
        participants,
        canonicalParticipants: canonicalParticipants.length > 0 ? canonicalParticipants : undefined,
        participantSpaceId: conversation.participantSpaceId ?? syntheticParticipantSpaceId(session),
        metadata: canonicalMetadata,
        directness: session.kind === 'group' ? 'Group chat' : isChatCreatedDirectAgent ? 'Direct chat' : conversation.directness,
        messages,
        updatedAtLabel: latestTime,
        statusIndicator: hasActiveProcessing ? { label: 'Running', tone: 'running', live: true } : conversation.statusIndicator,
        bridgeTarget,
        taskActivities,
        canonicalParticipantCount: canonicalParticipants.length || (indexes.participantsBySessionId.get(sessionId) ?? []).length,
        canonicalMessageCount: summaryBySessionId.get(sessionId)?.messageCount
          ?? indexes.rawMessageCountBySessionId.get(sessionId)
          ?? 0,
        canonicalDelegatedExchangeCount: taskActivities.length,
        canonicalContextSnapshotCount: summaryBySessionId.get(sessionId)?.contextSnapshotCount
          ?? indexes.contextSnapshotCountBySessionId.get(sessionId)
          ?? 0,
        canonicalPresenceSummary: indexes.presenceSummaryBySessionId.get(sessionId),
        forkedFromSessionId: canonicalForkedFromSessionId ?? conversation.forkedFromSessionId ?? null,
        forkedFromMessageId: canonicalForkedFromMessageId ?? conversation.forkedFromMessageId ?? null,
      };
    },
    buildChatConversations(conversations, buildSubtitle) {
      const unreadBySessionId = mergedUnreadBySessionId(conversations);
      const sourceBySessionId = new Map(conversations.map((conversation) => [conversation.canonicalSessionId ?? conversation.id, conversation]));
      const sourceByOutreachParentSessionId = new Map<string, Conversation>();
      for (const conversation of conversations) {
        const parentSessionIds = new Set([
          conversation.outreach?.parentSessionId?.trim(),
          ...Object.keys(conversation.bridgeUnreadByParentSessionId ?? {}),
        ].filter((value): value is string => Boolean(value)));
        for (const parentSessionId of parentSessionIds) {
          if (!sourceByOutreachParentSessionId.has(parentSessionId)) {
            sourceByOutreachParentSessionId.set(parentSessionId, conversation);
          }
        }
      }
      const groups = new Map<string, typeof chatSessions>();
      for (const session of chatSessions) {
        const isDefaultAgentRelationship = session.kind === 'direct-agent'
          && session.relationshipIdentityId
          && session.primaryIdentityId === session.relationshipIdentityId;
        const groupKey = isDefaultAgentRelationship
          ? `relationship:${session.relationshipIdentityId ?? session.id}`
          : session.id;
        groups.set(groupKey, [...(groups.get(groupKey) ?? []), session]);
      }

      const hydrated = [...groups.values()]
        .sort((left, right) => {
          const leftSession = left[0];
          const rightSession = right[0];
          return (rightSession ? sessionActivityAtMs(rightSession) : 0)
            - (leftSession ? sessionActivityAtMs(leftSession) : 0);
        })
        .flatMap((sessions) => {
          const representativeWithMessages = sessions.find((session) => (indexes.rawMessageCountBySessionId.get(session.id) ?? 0) > 0);
          const representativeWithSource = sessions.find((session) => sourceBySessionId.has(session.id));
          const representative = representativeWithMessages ?? representativeWithSource;
          if (representative) {
            const directSource = sourceBySessionId.get(representative.id);
            const outreachSource = sourceByOutreachParentSessionId.get(representative.id);
            const source = directSource ?? outreachSource;
            const mergedUnread = unreadBySessionId.get(representative.id) ?? 0;
            return source
              ? [this.applyConversation(withMergedUnreadForSession({
                  ...source,
                  id: directSource ? source.id : representative.id,
                  canonicalSessionId: representative.id,
                }, representative.id, mergedUnread), buildSubtitle)]
              : [this.applyConversation(
                syntheticConversation(
                  representative,
                  this.participantDetails(representative.id),
                  this.messages(representative.id),
                  buildSubtitle,
                  latestActivityMessages(representative.id),
                ),
                buildSubtitle,
              )];
          }

          const fallbackSession = sessions[0];
          const fallbackParticipants = this.participantDetails(fallbackSession.id);
          const fallbackMessages = this.messages(fallbackSession.id);
          const fallbackMetadata = sessionMetadata(fallbackSession);
          const createdFromChatFlow = fallbackMetadata.createdFrom === 'chat-create-flow';
          if (fallbackMessages.length === 0 && (
            (fallbackSession.kind === 'self-agent' && !createdFromChatFlow)
            || fallbackMetadata.source === 'desktop-bridge-conversation'
          )) {
            return [];
          }
          return [this.applyConversation(
            syntheticConversation(
              fallbackSession,
              fallbackParticipants,
              fallbackMessages,
              buildSubtitle,
              latestActivityMessages(fallbackSession.id),
            ),
            buildSubtitle,
          )];
        });
      const hydratedIds = new Set(hydrated.map((conversation) => conversation.id));
      const groupedSessionIds = new Set([...groups.values()].flatMap((sessions) => sessions.map((session) => session.id)));
      const extras = conversations.filter((conversation) => {
        const sessionId = conversation.canonicalSessionId ?? conversation.id;
        return !hydratedIds.has(conversation.id)
          && !groupedSessionIds.has(sessionId)
          && shouldKeepLegacyChatConversationExtra(conversation, indexes);
      });
      return [...hydrated, ...extras];
    },
  };
}
