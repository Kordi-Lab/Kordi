import { useCallback, useEffect, useMemo } from 'react';

import {
  buildCollaborationMentionTargetsByScope,
  mentionableCloudAgentSummaries,
  sharedCloudAgentOwnerIdsForMentionScope,
} from '@/app/useKordiAppModelCollaborationMentions';
import {
  currentMentionQuery,
  filterMentionTargets,
} from '@/app/useKordiAppModelHelpers';
import type { CloudAccount } from '@/features/cloud/authClient';
import type {
  CloudAgentDefinition,
  SharedCloudAgentSummary,
} from '@/features/cloud/cloudAgents';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';
import { mentionScopeConversationForActiveConversation } from '@/features/chat/messageActions/mentions';
import type {
  Conversation,
  DesktopCollaborationState,
  DesktopChatState,
} from '@/kordi-app/types';

type UseKordiCollaborationMentionsArgs = {
  account: CloudAccount | null;
  activeConversation: Conversation;
  cloudAgentDefinitionsById: Record<string, CloudAgentDefinition>;
  collaborationState: DesktopCollaborationState | null;
  conversations: Conversation[];
  desktopChatState: DesktopChatState | null;
  isNativeShell: boolean;
  refreshSharedCloudAgents:
    UseCloudCollaborationStateResult['refreshSharedCloudAgents'];
  sharedCloudAgents: SharedCloudAgentSummary[];
};

export function useKordiCollaborationMentions({
  account,
  activeConversation,
  cloudAgentDefinitionsById,
  collaborationState,
  conversations,
  desktopChatState,
  isNativeShell,
  refreshSharedCloudAgents,
  sharedCloudAgents,
}: UseKordiCollaborationMentionsArgs) {
  const activeConversationScope = useMemo(
    () => mentionScopeConversationForActiveConversation(
      activeConversation,
      conversations,
    ),
    [activeConversation, conversations],
  );

  const sharedAgentOwnerIds = useMemo(
    () => sharedCloudAgentOwnerIdsForMentionScope(
      activeConversationScope,
      account?.accountId,
    ),
    [account?.accountId, activeConversationScope],
  );

  useEffect(() => {
    void refreshSharedCloudAgents(sharedAgentOwnerIds).catch(() => undefined);
  }, [refreshSharedCloudAgents, sharedAgentOwnerIds]);

  const mentionableCloudAgents = useMemo(
    () => mentionableCloudAgentSummaries({
      sharedCloudAgents,
      ownedCloudAgentsById: cloudAgentDefinitionsById,
      ownerDisplayName:
        account?.displayName?.trim()
        || account?.primaryEmail?.trim()
        || null,
    }),
    [
      account?.displayName,
      account?.primaryEmail,
      cloudAgentDefinitionsById,
      sharedCloudAgents,
    ],
  );

  const resolveSharedCloudAgentsForMention = useCallback(async () => {
    const refreshed = await refreshSharedCloudAgents(
      sharedAgentOwnerIds,
    ).catch(() => []);
    return mentionableCloudAgentSummaries({
      sharedCloudAgents: [...sharedCloudAgents, ...refreshed],
      ownedCloudAgentsById: cloudAgentDefinitionsById,
      ownerDisplayName:
        account?.displayName?.trim()
        || account?.primaryEmail?.trim()
        || null,
    });
  }, [
    account?.displayName,
    account?.primaryEmail,
    cloudAgentDefinitionsById,
    refreshSharedCloudAgents,
    sharedAgentOwnerIds,
    sharedCloudAgents,
  ]);

  const targetsByScope = useMemo(
    () => buildCollaborationMentionTargetsByScope({
      isNativeShell,
      desktopCollaborationState: collaborationState,
      desktopChatState,
      activeConvMentionScope: activeConversationScope,
      conversations,
      sharedCloudAgents: mentionableCloudAgents,
    }),
    [
      activeConversationScope,
      collaborationState,
      conversations,
      desktopChatState,
      isNativeShell,
      mentionableCloudAgents,
    ],
  );

  const chatMentionTargetsForText = useCallback(
    (text: string, cursor = text.length) => filterMentionTargets(
      targetsByScope.chat,
      currentMentionQuery(text, cursor),
      { allowLocalFiles: isNativeShell },
    ),
    [isNativeShell, targetsByScope.chat],
  );
  const projectMentionTargetsForText = useCallback(
    (text: string, cursor = text.length) => filterMentionTargets(
      targetsByScope.project,
      currentMentionQuery(text, cursor),
      { allowLocalFiles: isNativeShell },
    ),
    [isNativeShell, targetsByScope.project],
  );
  return {
    activeConversationScope,
    chatMentionTargetsForText,
    projectMentionTargetsForText,
    mentionableCloudAgents,
    resolveSharedCloudAgentsForMention,
  };
}
