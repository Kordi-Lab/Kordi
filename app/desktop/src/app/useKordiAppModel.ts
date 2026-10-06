import { useKordiAppActions } from '@/app/useKordiAppActions';
import { useKordiAppFoundation } from '@/app/useKordiAppFoundation';
import { useKordiAppShellComposition } from '@/app/useKordiAppShellComposition';
import { useKordiWorkspaceState } from '@/app/useKordiWorkspaceState';
import type { UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { useCloudCalls } from '@/features/cloud/useCloudCalls';
import { useEffect, useMemo } from 'react';
import { chatNavigationIndex } from '@/features/chat/chatNavigation';

export function useKordiAppModel({
  cloudSessionOverride,
}: {
  cloudSessionOverride?: UseCloudSessionResult;
} = {}) {
  const foundation = useKordiAppFoundation({ cloudSessionOverride });
  // Transcript mapping runs while composing this same render. Keep the stable
  // adapter seed current synchronously to avoid a one-render fallback-avatar
  // flash before workspace view-model composition.
  foundation.refs.syncLocalAvatarSeeds({
    human: foundation.profile.localProfileAvatarSeed,
    humanDisplayName: foundation.profile.localProfileDisplayName,
    humanProfileImageUrl: foundation.profile.localProfileImageUrl,
    agent: foundation.profile.localAgentAvatarSeed,
    agentDisplayName: foundation.profile.localAgentDisplayName,
  });
  const workspace = useKordiWorkspaceState(foundation);
  const { chatConversations, archivedParticipantSpaces } = workspace.conversations;
  const chatDestinations = useMemo(() => chatNavigationIndex([
    ...chatConversations,
    ...archivedParticipantSpaces.flatMap(space => space.sessions.map(session => session.conversation)),
  ]), [archivedParticipantSpaces, chatConversations]);
  const updateChatNavigationIndex = foundation.navigation.updateChatNavigationIndex;
  useEffect(() => updateChatNavigationIndex(chatDestinations), [chatDestinations, updateChatNavigationIndex]);
  const actions = useKordiAppActions({ foundation, workspace });
  const cloudCalls = useCloudCalls({
    account: foundation.environment.cloudSession.account,
    conversations: workspace.conversations.chatConversations,
  });

  const shell = useKordiAppShellComposition({
    foundation,
    workspace,
    actions,
  });
  return {
    ...shell,
    cloudCalls,
    callConversations: workspace.conversations.chatConversations,
  };
}
