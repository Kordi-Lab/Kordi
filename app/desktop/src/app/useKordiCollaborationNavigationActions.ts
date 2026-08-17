import { useCallback, type Dispatch, type SetStateAction } from 'react';

import type { CloudAgentRuntimeRouteChangeInput } from '@/features/cloud/cloudAgentRuntime';
import {
  cloudCollaborationConversationId,
  isCloudCollaborationHostId,
} from '@/features/cloud/cloudCollaborationState';
import { CLOUD_HOST_SENTINEL } from '@/features/cloud/useCloudContacts';
import type {
  Conversation,
  DesktopCollaborationProject,
  NavId,
} from '@/kordi-app/types';

type UnsupportedCollaborationAction = (...args: unknown[]) => Promise<void>;

type UseKordiCollaborationNavigationActionsArgs = {
  accountId: string | null;
  activeConversation: Pick<Conversation, 'canonicalSessionId' | 'id'>;
  activeConversationId: string;
  setActiveConversationId: Dispatch<SetStateAction<string>>;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  publishCloudAgentRuntimeRouteChange: (
    input: CloudAgentRuntimeRouteChangeInput,
  ) => Promise<void>;
  unsupportedAction: UnsupportedCollaborationAction;
};

export function useKordiCollaborationNavigationActions({
  accountId,
  activeConversation,
  activeConversationId,
  setActiveConversationId,
  setActiveNav,
  setDesktopChatError,
  publishCloudAgentRuntimeRouteChange,
  unsupportedAction,
}: UseKordiCollaborationNavigationActionsArgs) {
  const openConversation = useCallback(
    async (
      hostId: string,
      peerNodeId: string,
      _peerDisplayName?: string | null,
      _peerOwnerName?: string | null,
      peerRuntime?: string | null,
      _project?: DesktopCollaborationProject | null,
    ) => {
      if (hostId !== CLOUD_HOST_SENTINEL) {
        await unsupportedAction();
        return;
      }
      setActiveNav('chats');
      setActiveConversationId(
        cloudCollaborationConversationId(
          peerNodeId,
          peerRuntime ?? 'person',
        ),
      );
      setDesktopChatError(null);
    },
    [
      setActiveConversationId,
      setActiveNav,
      setDesktopChatError,
      unsupportedAction,
    ],
  );

  const startPersonSession = useCallback(
    async (target: {
      hostId: string;
      nodeId: string;
      displayName?: string | null;
      ownerName?: string | null;
      humanId?: string | null;
    }) => {
      if (target.hostId !== CLOUD_HOST_SENTINEL) {
        await unsupportedAction();
        return;
      }
      setActiveNav('chats');
      setActiveConversationId(
        cloudCollaborationConversationId(target.nodeId, 'person'),
      );
      setDesktopChatError(null);
    },
    [
      setActiveConversationId,
      setActiveNav,
      setDesktopChatError,
      unsupportedAction,
    ],
  );

  const updateAgentModelRoutingForActiveSession = useCallback(
    async (
      hostId: string,
      _agentId: string,
      defaultModel?: string | null,
      _fallbackModel?: string | null,
      thinking?: string | null,
      defaultAuthProvider?: string | null,
      defaultAuthChoice?: string | null,
      _fallbackAuthProvider?: string | null,
      _fallbackAuthChoice?: string | null,
      targetSessionIdOverride?: string | null,
    ) => {
      if (!isCloudCollaborationHostId(hostId)) {
        await unsupportedAction(
          hostId,
          _agentId,
          defaultModel,
          _fallbackModel,
          thinking,
          defaultAuthProvider,
          defaultAuthChoice,
          _fallbackAuthProvider,
          _fallbackAuthChoice,
        );
        return;
      }

      const routeTargetSessionId =
        targetSessionIdOverride?.trim()
        || activeConversation.canonicalSessionId
        || activeConversation.id
        || activeConversationId;
      if (!accountId || !routeTargetSessionId || !defaultModel?.trim()) {
        setDesktopChatError(
          'Account is still loading. Try again in a moment.',
        );
        return;
      }
      try {
        await publishCloudAgentRuntimeRouteChange({
          sessionId: routeTargetSessionId,
          model: defaultModel,
          authProvider: defaultAuthProvider,
          authChoice: defaultAuthChoice,
          thinking,
        });
        setDesktopChatError(null);
      } catch (error) {
        setDesktopChatError(
          error instanceof Error
            ? error.message
            : 'Unable to synchronize the session model.',
        );
      }
    },
    [
      accountId,
      activeConversation.canonicalSessionId,
      activeConversation.id,
      activeConversationId,
      setDesktopChatError,
      publishCloudAgentRuntimeRouteChange,
      unsupportedAction,
    ],
  );

  return {
    addContact: unsupportedAction,
    approveContactRequest: unsupportedAction,
    openConversation,
    rejectContactRequest: unsupportedAction,
    removeContact: unsupportedAction,
    startPersonSession,
    updateAgentModelRoutingForActiveSession,
    updateLocalAgentModelRouting: unsupportedAction,
  };
}
