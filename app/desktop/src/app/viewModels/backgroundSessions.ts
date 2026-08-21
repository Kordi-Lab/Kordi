import { isGroupForkSession } from '@/features/chat/forkLineage';
import type {
  CanonicalSessionState,
  Conversation,
  SessionStatusIndicator,
  SessionTaskActivity,
} from '@/kordi-app/types';

export function backgroundSessionStatusIndicator(
  status?: string | null,
): SessionStatusIndicator | undefined {
  switch (status?.trim().toLowerCase()) {
    case 'completed':
      return { label: 'Done', tone: 'ready' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'stopped':
      return { label: 'Stopped', tone: 'stopped' };
    default:
      return undefined;
  }
}

export function canonicalAvatarSeed(
  state: CanonicalSessionState | null | undefined,
  identityId?: string | null,
) {
  const id = identityId?.trim();
  if (!state || !id) return null;
  return state.identities.find((identity) => identity.id === id)?.avatarKey?.trim() || null;
}

export function canonicalTaskActivitiesForSession(
  readModel: { taskActivities: (sessionId: string) => SessionTaskActivity[] } | null,
  sessionId: string,
) {
  return readModel?.taskActivities(sessionId) ?? [];
}

export function companionConversationList(
  chatConversations: Conversation[],
  allConversations: Conversation[],
) {
  const visibleIds = new Set(chatConversations.map((conversation) => conversation.id));
  return [
    ...chatConversations,
    ...allConversations.filter((conversation) => (
      isGroupForkSession(conversation) && !visibleIds.has(conversation.id)
    )),
  ];
}
