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
  sessionHasActiveProcessing,
  sessionMetadata,
  shouldUseCanonicalMessages,
  syntheticBridgeTarget,
  syntheticConversation,
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
  statusIndicator?: Conversation['statusIndicator'];
  updatedAtLabel?: string;
  name: string;
  subtitle: string;
  participants: string[];
  messages: Message[];
};

function shouldKeepLegacyChatConversationExtra(
  conversation: Conversation,
  indexes: CanonicalIndexes,
) {
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

      const canonicalMessages = this.messages(sessionId);
      const messages = isCanonicalBridgeSessionId(sessionId) && canonicalMessages.length > 0
        ? canonicalMessages
        : this.preferMessages(sessionId, conversation.messages);
      const participants = this.participantNames(sessionId, conversation.participants);
      const bridgePersonMessageTitle = session.kind === 'direct-person' && isCanonicalBridgeSessionId(sessionId)
        ? messages.find((message) => message.role !== 'system' && message.text.trim())?.text.trim()
        : null;
      const canonicalParticipants = this.participantDetails(sessionId);
      const latestTime = messages[messages.length - 1]?.time
        ?? conversation.updatedAtLabel
        ?? formatDesktopClockTime(session.lastMessageAtMs ?? session.updatedAtMs ?? session.createdAtMs);
      const hasActiveProcessing = sessionHasActiveProcessing(messages);

      return {
        ...conversation,
        canonicalSessionId: sessionId,
        canonicalStoragePath: indexes.storagePath,
        name: bridgePersonMessageTitle || session.title || conversation.name,
        subtitle: buildSubtitle(messages, conversation.subtitle),
        unread: 0,
        participants,
        canonicalParticipants: canonicalParticipants.length > 0 ? canonicalParticipants : undefined,
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
      const sourceBySessionId = new Map(conversations.map((conversation) => [conversation.canonicalSessionId ?? conversation.id, conversation]));
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
            const source = sourceBySessionId.get(representative.id);
            return source
              ? [this.applyConversation(source, buildSubtitle)]
              : [this.applyConversation(
                syntheticConversation(representative, this.participantDetails(representative.id), this.messages(representative.id), buildSubtitle),
                buildSubtitle,
              )];
          }

          const fallbackSession = sessions[0];
          const fallbackParticipants = this.participantDetails(fallbackSession.id);
          const fallbackMessages = this.messages(fallbackSession.id);
          const fallbackMetadata = sessionMetadata(fallbackSession);
          if (fallbackMessages.length === 0 && (
            fallbackSession.kind === 'self-agent'
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
