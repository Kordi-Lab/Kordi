import {
  buildParticipantSpaces,
  ensureSelfParticipantSpace,
  filterParticipantSpaces,
} from '@/features/chat/participantSpaces';
import { sessionsForGlobalAttention } from '@/features/chat/unreadCounts';
import type { Conversation } from '@/kordi-app/types';

export function buildWorkspaceChatListViewModels({
  activeConversationId,
  allConversations,
  archivedSessionIds,
  avatarSeed,
  chatSearch,
  hiddenSessionIds,
  localAgentReachoutSessionIds,
}: {
  activeConversationId: string;
  allConversations: Conversation[];
  archivedSessionIds: ReadonlySet<string>;
  avatarSeed: string;
  chatSearch: string;
  hiddenSessionIds: ReadonlySet<string>;
  localAgentReachoutSessionIds: ReadonlySet<string>;
}) {
  const hiddenIds = new Set([...hiddenSessionIds, ...archivedSessionIds, ...localAgentReachoutSessionIds]);
  const chatConversations = hiddenIds.size === 0
    ? allConversations
    : allConversations.filter((conversation) => {
      const canonicalId = conversation.canonicalSessionId ?? conversation.id;
      if (activeConversationId === conversation.id || activeConversationId === canonicalId) {
        return true;
      }
      return !hiddenIds.has(canonicalId) && !hiddenIds.has(conversation.id);
    });
  const archivedConversations = allConversations.filter((conversation) => {
    const canonicalId = conversation.canonicalSessionId ?? conversation.id;
    return archivedSessionIds.has(canonicalId) || archivedSessionIds.has(conversation.id);
  });
  const participantSpaces = ensureSelfParticipantSpace(
    buildParticipantSpaces(sessionsForGlobalAttention(chatConversations, archivedSessionIds)),
    { avatarSeed },
  );
  return {
    chatConversations,
    participantSpaces,
    archivedParticipantSpaces: buildParticipantSpaces(archivedConversations),
    contactParticipantSpaces: filterParticipantSpaces(participantSpaces, chatSearch, 'contact'),
    agentParticipantSpaces: filterParticipantSpaces(participantSpaces, chatSearch, 'agent'),
  };
}
