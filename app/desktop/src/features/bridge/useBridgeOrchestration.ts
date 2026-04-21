import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { findBridgeProjectForWorkspace } from '@/app/useWorkspaceViewModels';
import type { DesktopBridgeProject, DesktopBridgeState, Project } from '@/kordi-app/types';
import {
  createDesktopBridgeInvite,
  createDesktopBridgeProject,
  openDesktopBridgeConversation,
  startDesktopBridgeLocalServer,
  stopDesktopBridgeLocalServer,
} from '@/lib/desktop';

function slugifyBridgeProjectName(value?: string | null) {
  const normalized = (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || `project-${Date.now()}`;
}

type UseBridgeOrchestrationArgs = {
  isNativeShell: boolean;
  activeProject: Project;
  activeProjectBridgeHost: DesktopBridgeState['hosts'][number] | null;
  activeBridgeHost: DesktopBridgeState['hosts'][number] | null;
  bridgeSettingsDraft: { serverUrl: string; displayName: string; ownerName: string; endpoint: string } | null;
  setDesktopBridgeState: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  setDesktopBridgeError: Dispatch<SetStateAction<string | null>>;
  setBridgeInvite: Dispatch<SetStateAction<any>>;
  setIsProjectBridgeBusy: Dispatch<SetStateAction<boolean>>;
  setActiveNav: (nav: string) => void;
  setActiveConvId: Dispatch<SetStateAction<string>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  handleCopyBridgeText: (value: string, successMessage: string) => Promise<void>;
};

export function useBridgeOrchestration({
  isNativeShell,
  activeProject,
  activeProjectBridgeHost,
  activeBridgeHost,
  bridgeSettingsDraft,
  setDesktopBridgeState,
  setDesktopBridgeError,
  setBridgeInvite,
  setIsProjectBridgeBusy,
  setActiveNav,
  setActiveConvId,
  setDesktopChatError,
  handleCopyBridgeText,
}: UseBridgeOrchestrationArgs) {
  const handleCreateProjectBridgeInvite = useCallback(async () => {
    const host = activeProjectBridgeHost;
    if (!host) {
      setDesktopBridgeError('Choose or connect a bridge host first.');
      return;
    }

    try {
      setIsProjectBridgeBusy(true);
      setDesktopBridgeError(null);

      let resolvedHost = host;
      let resolvedProject = findBridgeProjectForWorkspace(host, activeProject.name, activeProject.root);

      if (!resolvedProject) {
        const state = await createDesktopBridgeProject(
          host.id,
          slugifyBridgeProjectName(activeProject.name || activeProject.id),
          activeProject.name,
          activeProject.summary,
        );
        setDesktopBridgeState(state);
        resolvedHost = state.hosts.find((item) => item.id === host.id) ?? state.hosts[0] ?? host;
        resolvedProject = findBridgeProjectForWorkspace(resolvedHost, activeProject.name, activeProject.root);
      }

      if (!resolvedProject) {
        throw new Error('Unable to find the bridge project for this workspace after creating it.');
      }

      const invite = await createDesktopBridgeInvite(resolvedHost.id, resolvedProject.id, 20);
      setBridgeInvite(invite);
      await handleCopyBridgeText(invite.shareText, 'Project invite copied');
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to create bridge project invite');
    } finally {
      setIsProjectBridgeBusy(false);
    }
  }, [activeProject, activeProjectBridgeHost, handleCopyBridgeText, setBridgeInvite, setDesktopBridgeError, setDesktopBridgeState, setIsProjectBridgeBusy]);

  const handleOpenBridgeConversation = useCallback(async (
    hostId: string,
    peerNodeId: string,
    peerDisplayName?: string | null,
    peerOwnerName?: string | null,
    peerRuntime?: string | null,
    project?: DesktopBridgeProject | null,
  ) => {
    if (!isNativeShell) return;
    try {
      const nextState = await openDesktopBridgeConversation(
        hostId,
        peerNodeId,
        peerDisplayName ?? undefined,
        peerOwnerName ?? undefined,
        peerRuntime ?? undefined,
        project?.id,
        project?.name,
      );
      setDesktopBridgeState(nextState);
      setActiveNav('chats');
      const conversationId = `bridge:${hostId}:${peerNodeId}${project?.id ? `:${project.id}` : ''}`;
      setActiveConvId(conversationId);
      setDesktopChatError(null);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to open bridge conversation');
    }
  }, [isNativeShell, setActiveConvId, setActiveNav, setDesktopBridgeState, setDesktopChatError]);

  const handleStartLocalBridgeHost = useCallback(() => {
    void startDesktopBridgeLocalServer(
      17080,
      bridgeSettingsDraft?.displayName || activeBridgeHost?.displayName,
      bridgeSettingsDraft?.ownerName || activeBridgeHost?.ownerName,
    )
      .then((state) => {
        setDesktopBridgeState(state);
        setDesktopBridgeError(null);
      })
      .catch((error) => {
        setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to start local bridge server');
      });
  }, [activeBridgeHost?.displayName, activeBridgeHost?.ownerName, bridgeSettingsDraft?.displayName, bridgeSettingsDraft?.ownerName, setDesktopBridgeError, setDesktopBridgeState]);

  const handleStopLocalBridgeHost = useCallback(() => {
    void stopDesktopBridgeLocalServer()
      .then((state) => {
        setDesktopBridgeState(state);
        setDesktopBridgeError(null);
      })
      .catch((error) => {
        setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to stop local bridge server');
      });
  }, [setDesktopBridgeError, setDesktopBridgeState]);

  return {
    handleCreateProjectBridgeInvite,
    handleOpenBridgeConversation,
    handleStartLocalBridgeHost,
    handleStopLocalBridgeHost,
  };
}
