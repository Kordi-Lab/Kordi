import type {
  CanonicalSessionState,
  Conversation,
  ConversationBridgeTarget,
  ConversationParticipant,
  Message,
} from '@/kordi-app/types';
import { isCanonicalBridgeSessionId } from '@/features/canonical/sessionResolver';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import { formatDesktopClockTime } from '@/lib/time';
import { buildCanonicalIndexes } from './readModel/indexes';
import type { CanonicalIndexes } from './readModel/indexes';
import {
  sessionDisplayTitle,
  sessionHasActiveProcessing,
  sessionMetadata,
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
  canonicalContextSnapshotCount?: number;
  canonicalPresenceSummary?: string;
  canonicalParticipants?: ConversationParticipant[];
  bridgeTarget?: ConversationBridgeTarget | null;
  bridgeUnreadByParentSessionId?: Record<string, number>;
  outreach?: { parentSessionId?: string | null } | null;
  participantSpaceId?: string | null;
  directness?: string | null;
  statusIndicator?: Conversation['statusIndicator'];
  updatedAtLabel?: string;
  unread?: number;
  name: string;
  subtitle: string;
  participants: string[];
  messages: Message[];
};

function messageResponseText(message: Message) {
  return (message.turn?.assistantText ?? message.text).trim();
}

function hasLocalOwnedAgentRuntimeStatus(message: Message) {
  return message.role === 'owned-agent'
    && Boolean(message.turn)
    && (
      (message.turn?.tools?.length ?? 0) > 0
      || (message.turn?.thinkingText?.trim().length ?? 0) > 0
      || message.turn?.completed === false
    );
}

function mergeLocalOwnedAgentRuntimeStatus(
  canonicalMessages: Message[],
  existingMessages: Message[],
) {
  const merged = [...canonicalMessages];
  for (const localMessage of existingMessages.filter(hasLocalOwnedAgentRuntimeStatus)) {
    const localText = messageResponseText(localMessage);
    const matchingCanonicalIndex = localText
      ? merged.findIndex((message) => message.role === 'owned-agent' && messageResponseText(message) === localText)
      : -1;
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
    .filter((session) => session.kind !== 'project' && session.status !== 'archived')
    .sort((left, right) => {
      const leftTs = left.lastMessageAtMs ?? left.updatedAtMs ?? left.createdAtMs;
      const rightTs = right.lastMessageAtMs ?? right.updatedAtMs ?? right.createdAtMs;
      return rightTs - leftTs;
    });

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
      const canonicalMessages = this.messages(sessionId);
      const messages = (isBridgePersonSession || isBridgeSessionThread) && canonicalMessages.length > 0
        ? mergeLocalOwnedAgentRuntimeStatus(canonicalMessages, conversation.messages)
        : this.preferMessages(sessionId, conversation.messages);
      const participants = this.participantNames(sessionId, conversation.participants);
      const canonicalParticipants = this.participantDetails(sessionId);
      const displayTitle = sessionDisplayTitle(messages, session.title || conversation.name);
      const latestTime = messages[messages.length - 1]?.time
        ?? conversation.updatedAtLabel
        ?? formatDesktopClockTime(session.lastMessageAtMs ?? session.updatedAtMs ?? session.createdAtMs);
      const hasActiveProcessing = sessionHasActiveProcessing(messages);

      const scopedUnread = conversation.bridgeUnreadByParentSessionId
        ? conversation.bridgeUnreadByParentSessionId[sessionId] ?? 0
        : conversation.unread ?? 0;

      return {
        ...conversation,
        canonicalSessionId: sessionId,
        canonicalCreatedByIdentityId: session.createdByIdentityId,
        canonicalStoragePath: indexes.storagePath,
        name: displayTitle,
        subtitle: buildSubtitle(messages, conversation.subtitle),
        unread: scopedUnread,
        participants,
        canonicalParticipants: canonicalParticipants.length > 0 ? canonicalParticipants : undefined,
        participantSpaceId: conversation.participantSpaceId ?? syntheticParticipantSpaceId(session),
        directness: session.kind === 'group' ? 'Group chat' : conversation.directness,
        messages,
        updatedAtLabel: latestTime,
        statusIndicator: hasActiveProcessing ? { label: 'Running', tone: 'running', live: true } : conversation.statusIndicator,
        bridgeTarget: conversation.bridgeTarget ?? syntheticBridgeTarget(session, canonicalParticipants),
        canonicalParticipantCount: (indexes.participantsBySessionId.get(sessionId) ?? []).length,
        canonicalMessageCount: indexes.rawMessageCountBySessionId.get(sessionId) ?? 0,
        canonicalDelegatedExchangeCount: indexes.delegatedExchangeCountBySessionId.get(sessionId) ?? 0,
        canonicalContextSnapshotCount: indexes.contextSnapshotCountBySessionId.get(sessionId) ?? 0,
        canonicalPresenceSummary: indexes.presenceSummaryBySessionId.get(sessionId),
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
          const leftTs = left[0]?.lastMessageAtMs ?? left[0]?.updatedAtMs ?? left[0]?.createdAtMs ?? 0;
          const rightTs = right[0]?.lastMessageAtMs ?? right[0]?.updatedAtMs ?? right[0]?.createdAtMs ?? 0;
          return rightTs - leftTs;
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
                syntheticConversation(representative, this.participantDetails(representative.id), this.messages(representative.id), buildSubtitle),
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
            syntheticConversation(fallbackSession, fallbackParticipants, fallbackMessages, buildSubtitle),
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
