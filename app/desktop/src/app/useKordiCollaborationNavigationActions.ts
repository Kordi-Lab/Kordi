import { useCallback, type Dispatch, type SetStateAction } from 'react';

import { cloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentRuntime';
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
import type { DesktopChatMessageRoute } from '@/lib/desktop';

type UnsupportedCollaborationAction = (...args: unknown[]) => Promise<void>;

type UseKordiCollaborationNavigationActionsArgs = {
  accountId: string | null;
  activeConversation: Pick<Conversation, 'canonicalSessionId' | 'id'>;
  activeConversationId: string;
  setActiveConversationId: Dispatch<SetStateAction<string>>;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  setRuntimeRoutesBySessionId: Dispatch<
    SetStateAction<Record<string, DesktopChatMessageRoute>>
  >;
  unsupportedAction: UnsupportedCollaborationAction;
};

export function useKordiCollaborationNavigationActions({
  accountId,
  activeConversation,
  activeConversationId,
  setActiveConversationId,
  setActiveNav,
  setDesktopChatError,
  setRuntimeRoutesBySessionId,
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
      const runtimeSessionId = cloudAgentRuntimeSessionId(
        accountId,
        routeTargetSessionId,
      );
      if (!runtimeSessionId) {
        setDesktopChatError(
          'Account is still loading. Try again in a moment.',
        );
        return;
      }
      setRuntimeRoutesBySessionId((current) => ({
        ...current,
        [runtimeSessionId]: {
          model: defaultModel ?? null,
          authProvider: defaultAuthProvider ?? null,
          authChoice: defaultAuthChoice ?? null,
          thinking: thinking ?? null,
        },
      }));
      setDesktopChatError(null);
    },
    [
      accountId,
      activeConversation.canonicalSessionId,
      activeConversation.id,
      activeConversationId,
      setDesktopChatError,
      setRuntimeRoutesBySessionId,
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
