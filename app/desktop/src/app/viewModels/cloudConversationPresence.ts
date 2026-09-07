import {cloudTaskActivitiesForSession,type CloudSessionActivityStore} from '@/features/cloud/cloudSessionActivity';
import type {ThreadAttention} from '@/features/cloud/threadAttention';
import { presenceStatusForAccount, type CloudPresenceStore } from '@/features/cloud/presence';
import type { Conversation } from '@/kordi-app/types';

function cloudAccountIdFromParticipant(participant: {
  id?: string | null;
  humanId?: string | null;
  sourceIdentityId?: string | null;
}) {
  const candidates = [participant.humanId, participant.sourceIdentityId, participant.id]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
    .flatMap((value) => [value, value.replace(/^human:/, '')]);
  return candidates.find((value) => value.startsWith('acct_')) ?? null;
}

export function applyCloudPresenceToConversations(
  conversations: Conversation[],
  cloudPresence: CloudPresenceStore,
): Conversation[] {
  if (Object.keys(cloudPresence).length === 0) return conversations;
  return conversations.map((conversation) => {
    const participants = conversation.canonicalParticipants;
    if (!participants?.length) {
      const accountId = cloudAccountIdFromParticipant({
        humanId: conversation.collaborationTarget?.humanId,
        sourceIdentityId: conversation.collaborationTarget?.nodeId,
      });
      if (!accountId || !cloudPresence[accountId]) return conversation;
      const presenceStatus = presenceStatusForAccount(cloudPresence, accountId);
      if (conversation.participantPresenceStatuses?.[accountId] === presenceStatus) return conversation;
      return {
        ...conversation,
        participantPresenceStatuses: {
          ...(conversation.participantPresenceStatuses ?? {}),
          [accountId]: presenceStatus,
        },
      };
    }
    let changed = false;
    const canonicalParticipants = participants.map((participant) => {
      if (participant.kind !== 'human') return participant;
      const accountId = cloudAccountIdFromParticipant(participant);
      if (!accountId) return participant;
      const presenceStatus = presenceStatusForAccount(cloudPresence, accountId);
      if (participant.presenceStatus === presenceStatus) return participant;
      changed = true;
      return { ...participant, presenceStatus };
    });
    return changed ? { ...conversation, canonicalParticipants } : conversation;
  });
}

export function decorateCloudConversations(conversations: Conversation[], cloudSessionActivity: CloudSessionActivityStore, threadAttention?: Record<string,ThreadAttention>) {
    const withCloudActivity = conversations.map((conversation) => {
      const sessionId = conversation.canonicalSessionId ?? conversation.id;
      const cloudTaskActivities = cloudTaskActivitiesForSession(cloudSessionActivity, sessionId);
      if (cloudTaskActivities.length === 0) return conversation;
      const existingTaskActivities = 'taskActivities' in conversation
        ? conversation.taskActivities ?? []
        : [];
      const existingIds = new Set(existingTaskActivities.map((activity) => activity.id));
      return {
        ...conversation,
        taskActivities: [
          ...existingTaskActivities,
          ...cloudTaskActivities.filter((activity) => !existingIds.has(activity.id)),
        ],
      };
    });
    return withCloudActivity.map(conversation => {
      const attention=threadAttention?.[conversation.canonicalSessionId??conversation.id];
      return attention ? {...conversation,unread:attention.unread_count,threadAttention:attention,
        collaborationUnreadByParentSessionId:{[conversation.canonicalSessionId??conversation.id]:attention.unread_count}} : conversation;
    });
}
