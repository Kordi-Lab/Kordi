import type {
  CanonicalSessionState,
  CanonicalSessionSummary,
  Conversation,
  ConversationCollaborationTarget,
  ConversationParticipant,
  Message,
  SessionTaskActivity,
} from '@/kordi-app/types';
import {
  isCanonicalCloudSessionId,
  isLegacyCanonicalCollaborationSessionId,
} from '@/features/canonical/sessionResolver';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import { isCloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentMessages';
import { isCollaborationLiveTurnId } from '@/features/collaboration/legacyBridgeCompatibility';
import { normalizeSupportContactConversationCollection, normalizeSupportContactMessages } from '@/features/support/supportConversationPresentation';
import {
  isKordiSupportConversation,
  KORDI_SUPPORT_AVATAR_URL,
  KORDI_SUPPORT_NAME,
} from '@/features/support/supportIdentity';
import { formatDesktopLastActiveLabel } from '@/lib/time';
import { buildCanonicalIndexes } from './readModel/indexes';
import type { CanonicalIndexes } from './readModel/indexes';
import {
  isChatCreatedDirectAgentSession,
  sessionChatActivityAtMs,
  sessionConversationDisplayTitle,
  sessionHasActiveProcessing,
  sessionMetadata,
  sessionPrefersPersistedTitle,
  sessionUnreadCount,
  sessionViewMetadata,
  shouldUseCanonicalMessages,
  syntheticCollaborationTarget,
  syntheticConversation,
  syntheticParticipantSpaceId,
} from './readModel/conversationMapping';
import type { ConversationSubtitleBuilder } from './readModel/conversationMapping';
import type { CanonicalConversationLike } from './readModel/conversationTypes';
import {
  anchorUnmatchedFailedRuntimeMessages,
  comparableAgentResponseText,
  firstIndexGreaterThan,
  firstUnusedCanonicalIndex,
  messageResponseText,
  runtimeTranscriptAnchorKey,
  sameAgentResponseText,
} from './readModel/runtimeMessageMatching';
import { dedupeRepeatedFailedAgentTurns } from './repeatedFailedAgentTurns';
import { mergeCanonicalReadReceipts, mergedMessageReactionMetadata } from './readModel/messageReactionMetadata';

const EMPTY_LEGACY_GROUP_SESSION_TITLES: ReadonlyMap<string, string> = new Map(); const EMPTY_PENDING_GROUP_PROJECTION_SESSION_IDS: ReadonlySet<string> = new Set(); const EMPTY_RELIABLE_GROUP_SESSION_ACTIVITY: ReadonlyMap<string, number> = new Map();

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
  anchorUnmatchedFailedRuntimeMessages(
    runtimeMessages,
    canonicalMessages,
    runtimeAnchorIndexes,
    usedCanonicalIndexes,
  );
  const enrichedRuntimeMessages = runtimeMessages.map((message, runtimeIndex) => {
    const canonicalIndex = runtimeAnchorIndexes[runtimeIndex];
    if (canonicalIndex === null) return message;
    const canonicalMessage = canonicalMessages[canonicalIndex];
    const canonicalAliasIds = [canonicalMessage.id, canonicalMessage.entryId, ...(canonicalMessage.replyAliasIds ?? [])]
      .filter((value): value is string => Boolean(value?.trim()));
    const replyAliasIds = [...new Set([
      ...(message.replyAliasIds ?? []),
      ...canonicalAliasIds,
    ])];
    const reactionMetadata = mergedMessageReactionMetadata(message, canonicalMessage);
    if (!canonicalMessage.isForkSnapshot && replyAliasIds.length === (message.replyAliasIds?.length ?? 0) && !reactionMetadata.changed) {
      return message;
    }
    return {
      ...message,
      ...(canonicalMessage.isForkSnapshot ? { isForkSnapshot: true } : {}),
      ...(replyAliasIds.length > 0 ? { replyAliasIds } : {}),
      ...reactionMetadata.values,
    };
  });

  const overlayMessages = canonicalMessages
    .map((message, canonicalIndex) => ({ message, canonicalIndex }))
    .filter(({ message, canonicalIndex }) => (
      !usedCanonicalIndexes.has(canonicalIndex)
      && ![message.id, message.entryId].some((value) => Boolean(value && runtimeMessageIds.has(value)))
    ));
  if (overlayMessages.length === 0) return enrichedRuntimeMessages;
  if (runtimeMessages.length === 0) return overlayMessages.map(({ message }) => message);

  const canonicalBeforeRuntimeIndex = Array.from(
    { length: enrichedRuntimeMessages.length + 1 },
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
    const targetIndex = unmatchedRuntimeIndexes[unmatchedPosition] ?? enrichedRuntimeMessages.length;
    canonicalBeforeRuntimeIndex[targetIndex].push(message);
  }

  return enrichedRuntimeMessages.flatMap((message, runtimeIndex) => [
    ...canonicalBeforeRuntimeIndex[runtimeIndex],
    message,
  ]).concat(canonicalBeforeRuntimeIndex[enrichedRuntimeMessages.length]);
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

function isLegacyCollaborationProcessingOnlyRuntimePlaceholder(message: Message) {
  if (!isCollaborationLiveTurnId(message.id) || !message.turn) return false;
  return !message.turn.completed
    && !message.text.trim()
    && !message.turn.assistantText.trim()
    && !message.turn.thinkingText.trim()
    && message.turn.tools.length === 0;
}

function hasLocalOwnedAgentRuntimeStatus(message: Message) {
  return message.role === 'owned-agent'
    && Boolean(message.turn)
    && !isLegacyCollaborationProcessingOnlyRuntimePlaceholder(message)
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
      pendingCollaborationAgentRequest: canonicalMessage.turn?.pendingCollaborationAgentRequest ?? localMessage.turn.pendingCollaborationAgentRequest,
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

function shouldKeepRuntimeChatConversationExtra(
  conversation: Conversation,
  indexes: CanonicalIndexes,
) {
  if (conversation.outreach?.parentSessionId?.trim()) {
    return false;
  }

  if (isLocalDraftChatConversationId(conversation.id)) {
    return true;
  }

  if (conversation.transientDraft || isKordiSupportConversation(conversation)) return true;

  const sessionId = conversation.canonicalSessionId ?? conversation.id;
  if (indexes.sessionById.has(sessionId)) {
    return false;
  }

  // Hosted collaboration state can arrive before its canonical session is
  // materialized locally. Keep that runtime row until normal hydration takes
  // ownership of the same session id.
  return conversation.id.startsWith('bridge:')
    || isLegacyCanonicalCollaborationSessionId(sessionId)
    || isCanonicalCloudSessionId(sessionId)
    || conversation.collaborationSources.some((source) => source.trim().toLowerCase() === 'local')
    || !conversation.canonicalSessionId;
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

function legacyCollaborationTargetForSession(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
  indexes: CanonicalIndexes,
) {
  let currentSession: CanonicalSessionState['sessions'][number] | undefined = session;
  let currentParticipants = participants;
  const visitedSessionIds = new Set<string>();

  while (currentSession && !visitedSessionIds.has(currentSession.id)) {
    visitedSessionIds.add(currentSession.id);
    const target = syntheticCollaborationTarget(currentSession, currentParticipants);
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
    const scopedUnread = conversation.collaborationUnreadByParentSessionId ?? {};
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
    collaborationUnreadByParentSessionId: {
      ...(conversation.collaborationUnreadByParentSessionId ?? {}),
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
    cloudUnreadReady?: boolean; pendingGroupProjectionSessionIds?: ReadonlySet<string>;
    legacyGroupSessionTitlesById?: ReadonlyMap<string, string>; reliableGroupSessionTitleIds?: ReadonlySet<string>; reliableGroupSessionActivityAtMs?: ReadonlyMap<string, number>;
  } = {},
): CanonicalSessionReadModel | null {
  if (!canonicalState) return null;

  const indexes = buildCanonicalIndexes(canonicalState);
  const cloudUnreadReady = options.cloudUnreadReady ?? true; const pendingGroupProjectionSessionIds = options.pendingGroupProjectionSessionIds ?? EMPTY_PENDING_GROUP_PROJECTION_SESSION_IDS;
  const legacyGroupSessionTitlesById = options.legacyGroupSessionTitlesById ?? EMPTY_LEGACY_GROUP_SESSION_TITLES; const reliableGroupSessionTitleIds = options.reliableGroupSessionTitleIds ?? EMPTY_PENDING_GROUP_PROJECTION_SESSION_IDS; const reliableGroupSessionActivityAtMs = options.reliableGroupSessionActivityAtMs ?? EMPTY_RELIABLE_GROUP_SESSION_ACTIVITY;
  const summaryBySessionId = new Map((options.summaries ?? []).map((summary) => [summary.sessionId, summary]));
  const sessionActivityAtMs = (session: CanonicalSessionState['sessions'][number]) => (
    indexes.latestActivityMessageBySessionId.get(session.id)?.createdAtMs
    || sessionChatActivityAtMs(session)
  );
  const latestActivityMessages = (sessionId: string) => indexes.latestActivityMessageBySessionId.has(sessionId)
    ? [indexes.latestActivityMessageBySessionId.get(sessionId)!]
    : [];
  const chatSessions = canonicalState.sessions
    .filter((session) => session.kind !== 'project' && session.status !== 'archived'
      && !isCloudAgentRuntimeSessionId(session.id) && !session.id.startsWith('draft:'))
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
      const isSupportContact = isKordiSupportConversation(conversation);
      const isCanonicalCloudDirectPersonSession = session.kind === 'direct-person'
        && isCanonicalCloudSessionId(sessionId);
      const isLegacyCollaborationPersonSession = session.kind === 'direct-person' && isLegacyCanonicalCollaborationSessionId(sessionId);
      const isLegacyCollaborationSessionThread = sessionMetadata(session).source === 'bridge-session-thread';
      const isChatCreatedDirectAgent = isChatCreatedDirectAgentSession(session);
      const canonicalMessages = this.messages(sessionId);
      const hydratedMessages = (conversation.desktopRuntimeBacked && conversation.desktopRuntimeTranscriptLoaded
        || isSupportContact || isCanonicalCloudDirectPersonSession) && canonicalMessages.length > 0
        ? mergeCanonicalHistoryIntoRuntime(canonicalMessages, conversation.messages)
        : (isLegacyCollaborationPersonSession || isLegacyCollaborationSessionThread || isChatCreatedDirectAgent) && canonicalMessages.length > 0
        ? isChatCreatedDirectAgent
          ? canonicalMessages
          : mergeLocalOwnedAgentRuntimeStatus(canonicalMessages, conversation.messages)
        : this.preferMessages(sessionId, conversation.messages);
      const hydratedWithReceipts = mergeCanonicalReadReceipts(hydratedMessages, canonicalMessages);
      const messages = dedupeRepeatedFailedAgentTurns(isSupportContact ? normalizeSupportContactMessages(hydratedWithReceipts) : hydratedWithReceipts);
      const rawCanonicalParticipants = this.participantDetails(sessionId);
      const canonicalParticipants = visibleParticipantsForSession(session, rawCanonicalParticipants);
      const participants = isSupportContact
        ? ['Me', KORDI_SUPPORT_NAME]
        : canonicalParticipants.length > 0
        ? canonicalParticipants.map((participant) => participant.name)
        : conversation.participants;
      const displayTitle = isSupportContact
        ? KORDI_SUPPORT_NAME
        : (() => {
            const preferPersistedTitle = sessionPrefersPersistedTitle(session);
            const legacyGroupTitle = session.kind === 'group'
              && !preferPersistedTitle
              && (cloudUnreadReady || reliableGroupSessionTitleIds.has(sessionId))
              ? legacyGroupSessionTitlesById.get(sessionId)
              : undefined;
            return sessionConversationDisplayTitle(
              session,
              canonicalParticipants,
              messages,
              legacyGroupTitle || session.title || conversation.name,
              {
                preferFallback: preferPersistedTitle
                  || Boolean(legacyGroupTitle)
                  || (session.kind === 'group' && !cloudUnreadReady),
              },
            );
          })();
      const activityAtMs = session.kind === 'group' ? reliableGroupSessionActivityAtMs.get(sessionId) ?? sessionActivityAtMs(session) : sessionActivityAtMs(session); const latestTime = formatDesktopLastActiveLabel(activityAtMs);
      const hasActiveProcessing = sessionHasActiveProcessing(messages);
      const directLegacyCollaborationTarget = conversation.collaborationTarget ?? syntheticCollaborationTarget(session, rawCanonicalParticipants);
      const collaborationTarget = directLegacyCollaborationTarget ?? legacyCollaborationTargetForSession(session, rawCanonicalParticipants, indexes);
      const inheritedLegacyCollaborationTarget = !directLegacyCollaborationTarget && Boolean(collaborationTarget);
      const scopedUnread = cloudUnreadReady
        ? conversation.collaborationUnreadByParentSessionId
          ? conversation.collaborationUnreadByParentSessionId[sessionId] ?? 0
          : conversation.unread ?? 0
        : 0;
      const canonicalUnread = cloudUnreadReady ? unreadCountForSession(session) : 0;
      const unread = canonicalUnread === 0 && hasSelfReadLatestMessage(sessionId) ? 0 : Math.max(scopedUnread, canonicalUnread);
      const taskActivities = this.taskActivities(sessionId);
      // Surface canonical fork lineage in the transcript and sidebar.
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
        _updatedAtMs: session.kind === 'group' ? activityAtMs : Math.max(conversation._updatedAtMs ?? 0, activityAtMs),
        canonicalSessionId: sessionId,
        canonicalCreatedByIdentityId: session.createdByIdentityId,
        canonicalCreatedAtMs: session.createdAtMs,
        canonicalStoragePath: indexes.storagePath,
        name: displayTitle,
        subtitle: buildSubtitle(messages, conversation.subtitle),
        unread,
        collaborationSources: inheritedLegacyCollaborationTarget ? ['Cloud'] : conversation.collaborationSources,
        trust: inheritedLegacyCollaborationTarget ? 'Cloud' : conversation.trust,
        participants,
        profileImageUrl: isSupportContact
          ? KORDI_SUPPORT_AVATAR_URL
          : conversation.profileImageUrl,
        participantProfileImageUrls: isSupportContact
          ? { [KORDI_SUPPORT_NAME]: KORDI_SUPPORT_AVATAR_URL }
          : conversation.participantProfileImageUrls,
        canonicalParticipants: !isSupportContact && canonicalParticipants.length > 0 ? canonicalParticipants : undefined,
        participantSpaceId: conversation.participantSpaceId ?? syntheticParticipantSpaceId(session),
        metadata: canonicalMetadata,
        directness: session.kind === 'group' ? 'Group chat' : isChatCreatedDirectAgent ? 'Agent chat' : conversation.directness,
        messages,
        updatedAtLabel: latestTime,
        statusIndicator: hasActiveProcessing ? { label: 'Running', tone: 'running', live: true } : conversation.statusIndicator,
        collaborationTarget: collaborationTarget,
        taskActivities,
        canonicalParticipantCount: isSupportContact
          ? participants.length
          : canonicalParticipants.length || (indexes.participantsBySessionId.get(sessionId) ?? []).length,
        canonicalMessageCount: summaryBySessionId.get(sessionId)?.messageCount
          ?? indexes.readableMessageCountBySessionId.get(sessionId)
          ?? 0,
        canonicalProjectionPending: pendingGroupProjectionSessionIds.has(sessionId),
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
          ...Object.keys(conversation.collaborationUnreadByParentSessionId ?? {}),
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
          const representativeWithMessages = sessions.find((session) => (
            indexes.readableMessageCountBySessionId.get(session.id) ?? 0
          ) > 0);
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
          && shouldKeepRuntimeChatConversationExtra(conversation, indexes);
      });
      return normalizeSupportContactConversationCollection([...hydrated, ...extras]);
    },
  };
}
