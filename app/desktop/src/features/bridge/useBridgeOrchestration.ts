import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { findBridgeProjectForWorkspace } from '@/app/useWorkspaceViewModels';
import { DEFAULT_LOCAL_BRIDGE_SERVER_PORT } from '@/features/bridge/constants';
import { mergeDesktopBridgeState } from '@/features/bridge/useBridgeState';
import type {
  CanonicalSessionState,
  DesktopBridgeConversation,
  DesktopBridgeInvite,
  DesktopBridgeProject,
  DesktopBridgeState,
  NavId,
  Project,
} from '@/kordi-app/types';
import {
  activateDesktopBridgeAgent,
  addDesktopBridgeContact,
  createDesktopBridgeAgent,
  createDesktopBridgeInvite,
  createDesktopBridgeProject,
  openDesktopBridgeConversation,
  openOrCreateCanonicalSession,
  removeDesktopBridgeContact,
  renameDesktopBridgeAgent,
  setDesktopBridgeDefaultAgent,
  updateDesktopBridgeAgentModelRouting,
  updateDesktopLocalAgentModelRouting,
  setDesktopBridgeDiscoveryMode,
  startDesktopBridgeLocalServer,
  stopDesktopBridgeLocalServer,
} from '@/lib/desktop';

function slugifyBridgeProjectName(value?: string | null) {
  const normalized = (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || `project-${Date.now()}`;
}

function buildBridgeConversationId(hostId: string, peerNodeId: string, peerRuntime?: string | null, projectId?: string | null) {
  return `bridge:${hostId}:${peerNodeId}${projectId ? `:${projectId}` : ''}${peerRuntime?.trim().toLowerCase() === 'person' ? ':person' : ''}`;
}

function buildCanonicalBridgeSessionId(conversationId: string) {
  return `session:bridge:${conversationId}`;
}

function newBridgePersonSessionId() {
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  return `session:bridge:humans:${randomId}`;
}

function bridgePersonIdentityId(target: { nodeId: string; humanId?: string | null }) {
  const humanId = target.humanId?.trim();
  return humanId ? `human:${humanId}` : `human:bridge-node:${target.nodeId}`;
}

function optimisticBridgeConversation({
  hostId,
  peerNodeId,
  peerDisplayName,
  peerOwnerName,
  peerRuntime,
  project,
}: {
  hostId: string;
  peerNodeId: string;
  peerDisplayName?: string | null;
  peerOwnerName?: string | null;
  peerRuntime?: string | null;
  project?: DesktopBridgeProject | null;
}): DesktopBridgeConversation {
  const timestampMs = Date.now();
  const isPerson = peerRuntime?.trim().toLowerCase() === 'person';
  const title = (isPerson ? peerOwnerName : peerDisplayName) || peerOwnerName || peerDisplayName || peerNodeId;
  const subtitle = project?.name
    ? `Shared in ${project.name}`
    : isPerson
      ? 'Direct human chat'
      : 'Remote agent thread';
  const updatedAtLabel = new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestampMs));

  const conversationId = buildBridgeConversationId(hostId, peerNodeId, peerRuntime, project?.id);

  return {
    id: conversationId,
    canonicalSessionId: buildCanonicalBridgeSessionId(conversationId),
    hostId,
    peerNodeId,
    peerDisplayName: peerDisplayName ?? null,
    peerOwnerName: peerOwnerName ?? null,
    peerRuntime: peerRuntime?.trim() || 'person',
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    title,
    subtitle,
    unreadCount: 0,
    updatedAtMs: timestampMs,
    updatedAtLabel,
    awaitingReply: false,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    messages: [],
  };
}

function upsertOptimisticBridgeConversation(
  current: DesktopBridgeState | null,
  conversation: DesktopBridgeConversation,
): DesktopBridgeState | null {
  if (!current) return current;

  const conversations = [
    conversation,
    ...current.conversations.filter((item) => item.id !== conversation.id),
  ].sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    ...current,
    conversations,
  };
}

type UseBridgeOrchestrationArgs = {
  isNativeShell: boolean;
  activeProject: Project;
  activeProjectBridgeHost: DesktopBridgeState['hosts'][number] | null;
  activeBridgeHost: DesktopBridgeState['hosts'][number] | null;
  bridgeSettingsDraft: { serverUrl: string; displayName: string; ownerName: string } | null;
  canonicalHumanIdentityId?: string | null;
  setCanonicalSessionState: Dispatch<SetStateAction<CanonicalSessionState | null>>;
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
  canonicalHumanIdentityId,
  setCanonicalSessionState,
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

  const handleStartBridgePersonSession = useCallback(async (target: {
    hostId: string;
    nodeId: string;
    displayName?: string | null;
    ownerName?: string | null;
    humanId?: string | null;
  }) => {
    if (!isNativeShell) return;
    if (!canonicalHumanIdentityId) {
      setDesktopChatError('Bridge identity is still loading. Try again in a moment.');
      return;
    }

    const sessionId = newBridgePersonSessionId();
    const remoteIdentityId = bridgePersonIdentityId(target);
    setActiveNav('chats');
    setActiveConvId(sessionId);
    setDesktopChatError(null);

    try {
      const nextState = await openOrCreateCanonicalSession({
        id: sessionId,
        kind: 'direct-person',
        title: 'New session',
        status: 'active',
        createdByIdentityId: canonicalHumanIdentityId,
        primaryIdentityId: remoteIdentityId,
        projectId: null,
        projectName: null,
        relationshipIdentityId: remoteIdentityId,
        participantIdentityIds: [remoteIdentityId],
        metadata: {
          source: 'bridge-session-thread',
          bridgeHostId: target.hostId,
          peerNodeId: target.nodeId,
          peerRuntime: 'person',
          peerDisplayName: target.displayName ?? null,
          peerOwnerName: target.ownerName ?? target.displayName ?? null,
          peerHumanId: target.humanId ?? null,
        },
      });
      setCanonicalSessionState(nextState);
      void addDesktopBridgeContact(target.hostId, target.nodeId)
        .then((state) => {
          setDesktopBridgeState((current) => mergeDesktopBridgeState(current, state));
        })
        .catch(() => {});
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to start bridge session');
    }
  }, [canonicalHumanIdentityId, isNativeShell, setActiveConvId, setActiveNav, setCanonicalSessionState, setDesktopBridgeState, setDesktopChatError]);

  const handleOpenBridgeConversation = useCallback(async (
    hostId: string,
    peerNodeId: string,
    peerDisplayName?: string | null,
    peerOwnerName?: string | null,
    peerRuntime?: string | null,
    project?: DesktopBridgeProject | null,
  ) => {
    if (!isNativeShell) return;

    const conversationId = buildBridgeConversationId(hostId, peerNodeId, peerRuntime, project?.id);
    setActiveNav('chats');
    setActiveConvId(conversationId);
    setDesktopChatError(null);
    setDesktopBridgeState((current) => upsertOptimisticBridgeConversation(current, optimisticBridgeConversation({
      hostId,
      peerNodeId,
      peerDisplayName,
      peerOwnerName,
      peerRuntime,
      project,
    })));

    if (!project?.id && peerRuntime?.trim().toLowerCase() === 'person') {
      void addDesktopBridgeContact(hostId, peerNodeId)
        .then((state) => {
          setDesktopBridgeState((current) => mergeDesktopBridgeState(current, state));
        })
        .catch(() => {});
    }

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
      setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
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

  const handleUpdateBridgeAgentModelRouting = useCallback(async (
    hostId: string,
    agentId: string,
    defaultModel?: string | null,
    fallbackModel?: string | null,
    thinking?: string | null,
    defaultAuthProvider?: string | null,
    defaultAuthChoice?: string | null,
    fallbackAuthProvider?: string | null,
    fallbackAuthChoice?: string | null,
  ) => {
    if (!isNativeShell) return;
    try {
      const nextState = await updateDesktopBridgeAgentModelRouting(
        hostId,
        agentId,
        defaultModel,
        fallbackModel,
        thinking,
        defaultAuthProvider,
        defaultAuthChoice,
        fallbackAuthProvider,
        fallbackAuthChoice,
      );
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to update bridge agent model routing');
      throw error;
    }
  }, [isNativeShell, setDesktopBridgeError, setDesktopBridgeState]);

  const handleUpdateLocalAgentModelRouting = useCallback(async (
    defaultModel?: string | null,
    fallbackModel?: string | null,
    thinking?: string | null,
    defaultAuthProvider?: string | null,
    defaultAuthChoice?: string | null,
    fallbackAuthProvider?: string | null,
    fallbackAuthChoice?: string | null,
  ) => {
    if (!isNativeShell) return;
    try {
      const nextState = await updateDesktopLocalAgentModelRouting(
        defaultModel,
        fallbackModel,
        thinking,
        defaultAuthProvider,
        defaultAuthChoice,
        fallbackAuthProvider,
        fallbackAuthChoice,
      );
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to update local agent model routing');
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
    handleStartBridgePersonSession,
    handleRenameBridgeAgent,
    handleSetBridgeDiscoveryMode,
    handleSetDefaultBridgeAgent,
    handleUpdateBridgeAgentModelRouting,
    handleUpdateLocalAgentModelRouting,
    handleStartLocalBridgeHost,
    handleStopLocalBridgeHost,
  };
}
