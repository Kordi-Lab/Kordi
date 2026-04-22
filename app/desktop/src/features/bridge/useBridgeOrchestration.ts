import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { findBridgeProjectForWorkspace } from '@/app/useWorkspaceViewModels';
import { DEFAULT_LOCAL_BRIDGE_SERVER_PORT } from '@/features/bridge/constants';
import type { DesktopBridgeInvite, DesktopBridgeProject, DesktopBridgeState, NavId, Project } from '@/kordi-app/types';
import {
  activateDesktopBridgeAgent,
  addDesktopBridgeContact,
  createDesktopBridgeAgent,
  createDesktopBridgeInvite,
  createDesktopBridgeProject,
  openDesktopBridgeConversation,
  removeDesktopBridgeContact,
  renameDesktopBridgeAgent,
  setDesktopBridgeDefaultAgent,
  setDesktopBridgeDiscoveryMode,
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
  bridgeSettingsDraft: { serverUrl: string; displayName: string; ownerName: string } | null;
  setDesktopBridgeState: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  setDesktopBridgeError: Dispatch<SetStateAction<string | null>>;
  setBridgeInvite: Dispatch<SetStateAction<DesktopBridgeInvite | null>>;
  setIsProjectBridgeBusy: Dispatch<SetStateAction<boolean>>;
  setActiveNav: (nav: NavId) => void;
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

  const handleAddBridgeContact = useCallback(async (hostId: string, peerNodeId: string) => {
    if (!isNativeShell) return;
    const trimmedNodeId = peerNodeId.trim();
    if (!trimmedNodeId) {
      setDesktopBridgeError('Enter a contact node ID first.');
      return;
    }

    try {
      const nextState = await addDesktopBridgeContact(hostId, trimmedNodeId);
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to add bridge contact');
      throw error;
    }
  }, [isNativeShell, setDesktopBridgeError, setDesktopBridgeState]);

  const handleRemoveBridgeContact = useCallback(async (hostId: string, peerNodeId: string) => {
    if (!isNativeShell) return;
    try {
      const nextState = await removeDesktopBridgeContact(hostId, peerNodeId);
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to remove bridge contact');
      throw error;
    }
  }, [isNativeShell, setDesktopBridgeError, setDesktopBridgeState]);

  const handleStartLocalBridgeHost = useCallback(() => {
    void startDesktopBridgeLocalServer(
      DEFAULT_LOCAL_BRIDGE_SERVER_PORT,
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

  const handleSetBridgeDiscoveryMode = useCallback(async (hostId: string, discoveryMode: 'off' | 'contacts' | 'open') => {
    if (!isNativeShell) return;
    try {
      const nextState = await setDesktopBridgeDiscoveryMode(hostId, discoveryMode);
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to update bridge discovery mode');
      throw error;
    }
  }, [isNativeShell, setDesktopBridgeError, setDesktopBridgeState]);

  const handleCreateBridgeAgent = useCallback(async (hostId: string, label?: string) => {
    if (!isNativeShell) return;
    try {
      const nextState = await createDesktopBridgeAgent(hostId, label?.trim() || undefined);
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to create bridge agent');
      throw error;
    }
  }, [isNativeShell, setDesktopBridgeError, setDesktopBridgeState]);

  const handleActivateBridgeAgent = useCallback(async (hostId: string, agentId: string) => {
    if (!isNativeShell) return;
    try {
      const nextState = await activateDesktopBridgeAgent(hostId, agentId);
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to switch bridge agent');
      throw error;
    }
  }, [isNativeShell, setDesktopBridgeError, setDesktopBridgeState]);

  const handleRenameBridgeAgent = useCallback(async (hostId: string, agentId: string, label: string) => {
    if (!isNativeShell) return;
    try {
      const nextState = await renameDesktopBridgeAgent(hostId, agentId, label);
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to rename bridge agent');
      throw error;
    }
  }, [isNativeShell, setDesktopBridgeError, setDesktopBridgeState]);

  const handleSetDefaultBridgeAgent = useCallback(async (hostId: string, agentId: string) => {
    if (!isNativeShell) return;
    try {
      const nextState = await setDesktopBridgeDefaultAgent(hostId, agentId);
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to set default bridge agent');
      throw error;
    }
  }, [isNativeShell, setDesktopBridgeError, setDesktopBridgeState]);

  return {
    handleAddBridgeContact,
    handleActivateBridgeAgent,
    handleCreateBridgeAgent,
    handleCreateProjectBridgeInvite,
    handleOpenBridgeConversation,
    handleRemoveBridgeContact,
    handleRenameBridgeAgent,
    handleSetBridgeDiscoveryMode,
    handleSetDefaultBridgeAgent,
    handleStartLocalBridgeHost,
    handleStopLocalBridgeHost,
  };
}
