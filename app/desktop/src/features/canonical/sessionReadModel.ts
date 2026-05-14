import type {
  CanonicalSessionState,
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

function mergeLocalOwnedAgentRuntimeStatus(
  canonicalMessages: Message[],
  existingMessages: Message[],
) {
  const merged = [...canonicalMessages];
  for (const localMessage of existingMessages.filter(hasLocalOwnedAgentRuntimeStatus)) {
    if (localMessage.turn && !localMessage.turn.completed) {
      const pendingCanonicalIndex = merged.findIndex((message) => (
        isPendingCanonicalAgentPlaceholder(message)
        && message.role === localMessage.role
      ));
      if (pendingCanonicalIndex >= 0) {
        merged[pendingCanonicalIndex] = localRuntimeProgressForCanonicalPlaceholder(
          merged[pendingCanonicalIndex],
          localMessage,
        );
        continue;
      }
    }

    const matchingCanonicalIndex = merged.findIndex((message) => sameOwnedAgentTurn(message, localMessage));
    if (matchingCanonicalIndex >= 0) {
      merged[matchingCanonicalIndex] = localMessage;
    } else {
      merged.push(localMessage);
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

export function createCanonicalSessionReadModel(canonicalState: CanonicalSessionState | null): CanonicalSessionReadModel | null {
  if (!canonicalState) return null;

  const indexes = buildCanonicalIndexes(canonicalState);
  const chatSessions = canonicalState.sessions
    .filter((session) => session.kind !== 'project' && session.status !== 'archived' && !isCloudAgentRuntimeSessionId(session.id))
    .sort((left, right) => sessionChatActivityAtMs(right) - sessionChatActivityAtMs(left));

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
      const messages = (isBridgePersonSession || isBridgeSessionThread || isChatCreatedDirectAgent) && canonicalMessages.length > 0
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
      const latestTime = formatDesktopLastActiveLabel(sessionChatActivityAtMs(session, indexes.rawMessagesBySessionId.get(sessionId) ?? []));
      const hasActiveProcessing = sessionHasActiveProcessing(messages);
      const directBridgeTarget = conversation.bridgeTarget ?? syntheticBridgeTarget(session, rawCanonicalParticipants);
      const bridgeTarget = directBridgeTarget ?? bridgeTargetForSession(session, rawCanonicalParticipants, indexes);
      const inheritedBridgeTarget = !directBridgeTarget && Boolean(bridgeTarget);

      const scopedUnread = conversation.bridgeUnreadByParentSessionId
        ? conversation.bridgeUnreadByParentSessionId[sessionId] ?? 0
        : conversation.unread ?? 0;
      const unread = Math.max(scopedUnread, sessionUnreadCount(session));
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
        canonicalMessageCount: indexes.rawMessageCountBySessionId.get(sessionId) ?? 0,
        canonicalDelegatedExchangeCount: taskActivities.length,
        canonicalContextSnapshotCount: indexes.contextSnapshotCountBySessionId.get(sessionId) ?? 0,
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
          return (rightSession ? sessionChatActivityAtMs(rightSession, indexes.rawMessagesBySessionId.get(rightSession.id) ?? []) : 0)
            - (leftSession ? sessionChatActivityAtMs(leftSession, indexes.rawMessagesBySessionId.get(leftSession.id) ?? []) : 0);
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
                  indexes.rawMessagesBySessionId.get(representative.id) ?? [],
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
              indexes.rawMessagesBySessionId.get(fallbackSession.id) ?? [],
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
