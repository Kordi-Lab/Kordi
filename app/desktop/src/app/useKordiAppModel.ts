import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildAuthDisplayProviders, normalizeSelectedProviderId } from '@/kordi-app/auth/model';
import { contactRequests, projects, settingsSections } from '@/kordi-app/data';
import { assembleKordiShellSlots } from '@/app/assembleKordiShellSlots';
import { useAppLayoutState } from '@/app/useAppLayoutState';
import { useKordiDesktopActivity } from '@/app/useKordiDesktopActivity';
import { useKordiLocalUiState } from '@/app/useKordiLocalUiState';
import { useKordiShellArgs } from '@/app/useKordiShellArgs';
import { useKordiShellViewModel } from '@/app/useKordiShellViewModel';
import { useKordiUiEffects } from '@/app/useKordiUiEffects';
import { useWorkspaceViewModels } from '@/app/useWorkspaceViewModels';
import { useWorkspaceController } from '@/app/useWorkspaceController';
import { useDesktopAuthState } from '@/features/auth/useDesktopAuthState';
import { useDesktopAuthUiState } from '@/features/auth/useDesktopAuthUiState';
import { buildProjectRoutingGroups, canonicalProjectGroupIdFromRoot, isCanonicalBridgeSessionId } from '@/features/canonical/sessionResolver';
import { useDesktopChatState } from '@/features/chat/useDesktopChatState';
import { useComposerController } from '@/features/chat/useComposerController';
import { useComposerViewModel } from '@/features/chat/useComposerViewModel';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { useDesktopSessionController } from '@/features/chat/useDesktopSessionController';
import { useDesktopTranscriptAdapter } from '@/features/chat/useDesktopTranscriptAdapter';
import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import { useBridgeOrchestration } from '@/features/bridge/useBridgeOrchestration';
import { useBridgeState } from '@/features/bridge/useBridgeState';
import { useProjectSettingsState } from '@/features/projects/useProjectSettingsState';
import type { ComposerMentionOption } from '@/kordi-app/components';
import { setLocalAgentAvatarSeed, setLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { CanonicalSessionState, DesktopChatState } from '@/kordi-app/types';
import {
  archiveDesktopChatSession,
  deleteDesktopChatSessionForever,
  fetchCanonicalSessionState,
  moveDesktopChatSessionToProject,
} from '@/lib/desktop';

function normalizeMentionSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

type MentionQuery = {
  normalized: string;
  raw: string;
  trailingWhitespace: boolean;
};

function currentMentionQuery(text: string): MentionQuery | null {
  const match = /(^|\s)@([^@\n\r]*)$/.exec(text);
  if (!match) return null;
  const raw = match[2];
  if (raw.length > 96) return null;
  return {
    normalized: normalizeMentionSearch(raw),
    raw,
    trailingWhitespace: /\s$/.test(raw),
  };
}

function mentionTargetMatchesExactly(target: ComposerMentionOption, normalizedQuery: string) {
  return [target.value, target.label]
    .map(normalizeMentionSearch)
    .some((value) => value === normalizedQuery);
}

function filterMentionTargets(targets: ComposerMentionOption[], query: MentionQuery | null) {
  if (query === null) return [];
  if (!query.normalized) return targets.slice(0, 8);
  if (query.trailingWhitespace && targets.some((target) => mentionTargetMatchesExactly(target, query.normalized))) {
    return [];
  }

  return targets
    .filter((target) => {
      const haystack = normalizeMentionSearch(`${target.label} ${target.detail ?? ''} ${target.nodeId} ${target.runtime}`);
      return haystack.includes(query.normalized);
    })
    .slice(0, 8);
}

function removeSessionFromDesktopState(state: DesktopChatState | null, sessionId: string) {
  if (!state) return state;
  return {
    ...state,
    sessions: state.sessions.filter((session) => session.id !== sessionId),
    projects: state.projects.map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => session.id !== sessionId),
    })).filter((project) => project.sessions.length > 0),
  };
}

function removeSessionFromCanonicalState(state: CanonicalSessionState | null, sessionId: string) {
  if (!state) return state;
  return {
    ...state,
    sessions: state.sessions.filter((session) => session.id !== sessionId),
    participants: state.participants.filter((participant) => participant.sessionId !== sessionId),
    messages: state.messages.filter((message) => message.sessionId !== sessionId),
    delegatedExchanges: state.delegatedExchanges.filter((exchange) => exchange.sessionId !== sessionId),
    presence: state.presence.filter((presence) => presence.sessionId !== sessionId),
    contextSnapshots: state.contextSnapshots.filter((snapshot) => snapshot.sessionId !== sessionId),
  };
}

function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false;
  return typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

export function useKordiAppModel() {
  const isNativeShell = isNativeDesktopShell();
  const composerControlsRef = useRef<HTMLDivElement | null>(null);
  const chatAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const chatTranscriptScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoFollowChatRef = useRef(true);
  const lastSeenArtifactByContextRef = useRef<Record<string, string | null>>({});
  const lastAutoAuthProviderSwitchRef = useRef<string | null>(null);
  const [canonicalSessionState, setCanonicalSessionState] = useState<CanonicalSessionState | null>(null);
  const [locallyHiddenSessionIds, setLocallyHiddenSessionIds] = useState<Set<string>>(() => new Set());
  const localAvatarSeedsRef = useRef<{ human?: string | null; agent?: string | null }>({});

  const localUi = useKordiLocalUiState();
  const {
    contactsUi,
    agentsUi,
    projectsUi,
    settingsUi,
    sessionUi,
    composerUi,
    chatsUi,
  } = localUi;

  const {
    desktopAuthState,
    isDesktopAuthLoading,
    desktopAuthError,
    clearDesktopAuthError,
    activeLoginProviderId,
    setActiveLoginProviderId,
    selectAuthProvider,
    refreshDesktopAuth,
    handleLogoutProvider,
    handleSelectAuthChoice,
    handleRemoveAuthProfile,
  } = useDesktopAuthState({
    isNativeShell,
  });

  const { mapDesktopMessages } = useDesktopTranscriptAdapter({ localAvatarSeedsRef });

  const {
    desktopChatState,
    setDesktopChatState,
    isDesktopChatLoading,
    desktopChatError,
    setDesktopChatError,
    isDesktopChatSending: isDesktopBridgeSending,
    setIsDesktopChatSending: setIsDesktopBridgeSending,
    desktopLiveTurnsBySession,
    setDesktopLiveTurnsBySession,
    pendingUserChatMessage,
    setPendingUserChatMessage,
    queuedDesktopMessagesBySession,
    setQueuedDesktopMessagesBySession,
    cachedChatSessionMessages,
    cachedProjectSessionMessages,
    localSessionUnreadCounts,
    setVisibleLocalSessionId,
    refreshDesktopChat,
    watchDesktopLiveTurn,
  } = useDesktopChatState({
    isNativeShell,
    mapDesktopMessages,
  });

  const projectRoutingGroups = useMemo(
    () => buildProjectRoutingGroups(desktopChatState?.projects, canonicalSessionState),
    [canonicalSessionState, desktopChatState?.projects],
  );

  const {
    activeNav,
    setActiveNav,
    activeConvId,
    setActiveConvId,
    activeProjectId,
    activeProjectSessionId,
    projectSelectedSessionIds,
    activeDetailTab,
    setActiveDetailTab,
    selectProject,
    selectProjectSession,
  } = useWorkspaceController({
    initialProjects: isNativeShell ? [] : projects,
    projectRoutingGroups,
    isNativeShell,
  });

  const {
    inlineAuthDialog,
    openAuthSettings,
    openLoginFlow,
    handleCloseInlineAuthDialog,
    dismissAuthGate,
    showAuthGate,
  } = useDesktopAuthUiState({
    isNativeShell,
    activeNav,
    activeSettingsSectionId: settingsUi.activeSettingsSectionId,
    desktopAuthState,
    isDesktopAuthLoading,
    setActiveNav,
    setActiveSettingsSectionId: settingsUi.setActiveSettingsSectionId,
    setActiveLoginProviderId,
    clearDesktopAuthError,
  });

  const {
    projectSettingsDraft,
    isDesktopProjectSaving,
    desktopProjectError,
    updateProjectSettingsDraft,
    handleSaveProjectSettings,
  } = useProjectSettingsState({
    isNativeShell,
    activeNav,
    activeProjectId,
    activeProjectSessionId,
    activeChatSessionId: desktopChatState?.activeSessionId,
    projects: desktopChatState?.projects,
    refreshDesktopChat,
  });

  const {
    chatModelOptions,
    composerProviderOptions,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    composerAuthByScope,
    chatSlashQuery,
    projectSlashQuery,
    filteredChatSlashCommands,
    filteredProjectSlashCommands,
  } = useComposerViewModel({
    isNativeShell,
    desktopAuthState,
    desktopChatState,
    composerSelections: composerUi.composerSelections,
    composerDrafts: composerUi.composerDrafts,
  });

  const {
    settingsContentRef,
    isSessionPanelCollapsed,
    setIsSessionPanelCollapsed,
    isDetailPanelCollapsed,
    setIsDetailPanelCollapsed,
    windowSize,
    sessionRailWidth,
    detailRailWidth,
    settingsRailWidth,
    authSettingsLayoutWidth,
    isLayoutResizing,
    showSessionRail,
    showRightDetailRail,
    showChatDetailRail,
    collapseChatSessions,
    isSingleWorkspacePage,
    leftWorkspaceWidth,
    startWindowResize,
    startPanelResize,
  } = useAppLayoutState({
    activeNav,
    isNativeShell,
  });

  const {
    desktopBridgeState,
    setDesktopBridgeState,
    bridgeSettingsDraft,
    setBridgeSettingsDraft,
    isDesktopBridgeSaving,
    desktopBridgeError,
    setDesktopBridgeError,
    isBridgePolling,
    lastBridgePollAt,
    bridgeInvite,
    setBridgeInvite,
    isProjectBridgeBusy,
    setIsProjectBridgeBusy,
    bridgeWizardOpen,
    setBridgeWizardOpen,
    bridgeWizardStep,
    setBridgeWizardStep,
    bridgeWizardDraft,
    setBridgeWizardDraft,
    refreshDesktopBridge,
    handleSaveBridgeSettings,
    handleSelectBridgeHost,
    handleRemoveBridgeHost,
    handleCreateBridgeDraft,
    openBridgeWizard,
    handleBridgeWizardPrimary,
    handleCopyBridgeText,
    handleOpenBridgeConfigFolder,
    handleRevealBridgeStorageFile,
    handleExportBridgeHostsConfig,
    handleImportBridgeHostsConfig,
  } = useBridgeState({
    isNativeShell,
    activeNav,
    activeConvId,
    activeConversationIsBridge: isNativeShell && (activeConvId.startsWith('bridge:') || isCanonicalBridgeSessionId(activeConvId)),
    composerChatText: composerUi.composerDrafts.chat,
    shouldAutoFollowChatRef,
  });

  const bridgeMentionTargets = useMemo<ComposerMentionOption[]>(() => {
    if (!isNativeShell) return [];

    const hosts = desktopBridgeState?.hosts ?? [];
    const options: ComposerMentionOption[] = [];
    const seen = new Set<string>();
    const pushOption = (option: ComposerMentionOption) => {
      const key = `${option.targetKind}:${option.bridgeHostId}:${option.nodeId}:${normalizeMentionSearch(option.value)}`;
      if (seen.has(key)) return;
      seen.add(key);
      options.push(option);
    };

    const activeHost = hosts.find((host) => host.id === desktopBridgeState?.activeHostId)
      ?? hosts[0]
      ?? null;
    const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
      ?? activeHost?.agents.find((agent) => agent.isActive)
      ?? activeHost?.agents.find((agent) => agent.isDefault)
      ?? activeHost?.agents[0]
      ?? null;
    const localAgentBaseLabel = 'Kordi';
    if (desktopChatState?.localAgent || activeAgent) {
      const runtimeAgentLabel = desktopChatState?.localAgent?.label?.trim();
      const bridgeAgentLabel = activeAgent?.label?.trim() || runtimeAgentLabel || localAgentBaseLabel;
      const ownerName = activeHost?.ownerName?.trim();
      const hostDisplayName = activeHost?.displayName?.trim();
      const ownerPrefix = ownerName ? `${ownerName}'s ` : '';
      const localAgentLabel = ownerPrefix && !bridgeAgentLabel.startsWith(ownerPrefix)
        ? `${ownerPrefix}${bridgeAgentLabel}`
        : (bridgeAgentLabel || hostDisplayName || localAgentBaseLabel);
      pushOption({
        value: localAgentLabel,
        label: localAgentLabel,
        detail: [
          'My agent',
          activeAgent?.id ? `agent ${activeAgent.id}` : null,
          activeAgent?.nodeId ? `node ${activeAgent.nodeId}` : null,
          activeAgent?.runtime,
        ].filter((value): value is string => Boolean(value)).join(' • '),
        targetKind: 'bridge-agent',
        bridgeHostId: activeHost?.id ?? 'local',
        nodeId: activeAgent?.nodeId?.trim() || activeHost?.nodeId?.trim() || `local-agent:${localAgentLabel}`,
        runtime: activeAgent?.runtime ?? 'kordi-local',
      });
    }

    for (const host of hosts) {
      for (const peer of host.visiblePeers) {
        const isAgent = isBridgeAgentRuntime(peer.runtime);
        const owner = peer.ownerName?.trim();
        const agentLabel = peer.displayName?.trim() || owner || peer.nodeId;

        if (isAgent && peer.isDefaultAgent && owner && peer.humanId?.trim()) {
          pushOption({
            value: owner,
            label: owner,
            detail: ['Bridge person', `Owns ${agentLabel}`, host.displayName || host.ownerName].filter(Boolean).join(' • '),
            targetKind: 'bridge-person',
            bridgeHostId: host.id,
            nodeId: peer.nodeId,
            runtime: 'person',
          });
        }

        pushOption({
          value: agentLabel,
          label: agentLabel,
          detail: [
            isAgent ? 'Bridge agent' : 'Bridge person',
            owner && owner !== agentLabel ? owner : null,
            host.displayName || host.ownerName,
            peer.runtime,
          ].filter((value): value is string => Boolean(value)).join(' • '),
          targetKind: isAgent ? 'bridge-agent' : 'bridge-person',
          bridgeHostId: host.id,
          nodeId: peer.nodeId,
          runtime: peer.runtime,
        });
      }
    }

    return options;
  }, [desktopBridgeState?.hosts, desktopChatState?.localAgent?.label, isNativeShell]);

  const chatMentionQuery = useMemo(() => currentMentionQuery(composerUi.composerDrafts.chat), [composerUi.composerDrafts.chat]);
  const projectMentionQuery = useMemo(() => currentMentionQuery(composerUi.composerDrafts.project), [composerUi.composerDrafts.project]);
  const filteredChatMentionTargets = useMemo(() => filterMentionTargets(bridgeMentionTargets, chatMentionQuery), [bridgeMentionTargets, chatMentionQuery]);
  const filteredProjectMentionTargets = useMemo(() => filterMentionTargets(bridgeMentionTargets, projectMentionQuery), [bridgeMentionTargets, projectMentionQuery]);

  const avatarBridgeHost = desktopBridgeState?.hosts.find((host) => host.id === desktopBridgeState.activeHostId)
    ?? desktopBridgeState?.hosts[0]
    ?? null;
  const avatarBridgeHostAgentId = avatarBridgeHost?.activeAgentId ?? null;
  const avatarBridgeAgent = avatarBridgeHost?.agents.find((agent) => agent.id === avatarBridgeHostAgentId)
    ?? avatarBridgeHost?.agents.find((agent) => agent.isActive)
    ?? avatarBridgeHost?.agents.find((agent) => agent.isDefault)
    ?? avatarBridgeHost?.agents[0]
    ?? null;
  const localProfileAvatarSeed = avatarBridgeHost?.humanId?.trim()
    || canonicalSessionState?.profile.humanIdentityId?.trim()
    || canonicalSessionState?.profile.id?.trim()
    || null;
  const localAgentAvatarSeed = avatarBridgeAgent?.id?.trim()
    || avatarBridgeHost?.activeAgentId?.trim()
    || avatarBridgeAgent?.nodeId?.trim()
    || avatarBridgeHost?.nodeId?.trim()
    || null;
  localAvatarSeedsRef.current.human = localProfileAvatarSeed;
  localAvatarSeedsRef.current.agent = localAgentAvatarSeed;

  const desktopCanonicalRefreshKey = useMemo(
    () => [
      desktopChatState?.activeSessionId ?? '',
      desktopChatState?.activeSession.messages.length ?? 0,
      ...(desktopChatState?.sessions ?? []).map((session) => `${session.id}:${session.messageCount}:${session.updatedAtLabel}`),
      ...(desktopChatState?.projects ?? []).flatMap((project) => project.sessions.map((session) => `${project.id}:${session.id}:${session.messageCount}:${session.updatedAtLabel}`)),
    ].join('|'),
    [desktopChatState],
  );

  const bridgeCanonicalRefreshKey = useMemo(
    () => (desktopBridgeState?.conversations ?? []).map((conversation) => `${conversation.id}:${conversation.updatedAtMs}:${conversation.messages.length}`).join('|'),
    [desktopBridgeState?.conversations],
  );

  const refreshCanonicalState = useCallback(async () => {
    if (!isNativeShell) return;
    try {
      setCanonicalSessionState(await fetchCanonicalSessionState());
    } catch {
      // Canonical state is additive during migration; legacy UI remains usable if it is unavailable.
    }
  }, [isNativeShell]);

  useEffect(() => {
    void refreshCanonicalState();
  }, [bridgeCanonicalRefreshKey, desktopCanonicalRefreshKey, refreshCanonicalState]);

  const {
    chatConversations,
    filteredConversations,
    activeConv,
    activeConversationIsBridge,
    activeLastMessage,
    activeConvHasSubtitle,
    displayedContacts,
    displayedAgents,
    groupedContacts,
    filteredGroupedContacts,
    activeContact,
    activeAgent,
    runtimeProjects,
    filteredProjects,
    activeProject,
    activeProjectSession,
    activeProjectLastMessage,
    activeBridgeHost,
    activeProjectBridgeProject,
    activeBridgeConversation,
    activeBridgeConversationHost,
    activeBridgePeople,
    activeBridgeAgents,
    activeBridgeAwaitingReply,
  } = useWorkspaceViewModels({
    isNativeShell,
    isDesktopChatLoading,
    desktopChatState,
    desktopBridgeState,
    canonicalSessionState,
    hiddenSessionIds: locallyHiddenSessionIds,
    projectWorkspaces: projectsUi.projectWorkspaces,
    projectSelectedSessionIds,
    activeNav,
    activeConvId,
    activeProjectId,
    activeProjectSessionId,
    chatFilter: chatsUi.chatFilter,
    chatSearch: chatsUi.chatSearch,
    projectSearch: projectsUi.projectSearch,
    contactSearch: contactsUi.contactSearch,
    activeContactId: contactsUi.activeContactId,
    activeAgentId: agentsUi.activeAgentId,
    cachedChatSessionMessages,
    cachedProjectSessionMessages,
    localSessionUnreadCounts,
    desktopLiveTurnsBySession,
    mapDesktopMessages,
  });

  useEffect(() => {
    setLocalProfileAvatarSeed(localProfileAvatarSeed);
  }, [localProfileAvatarSeed]);

  useEffect(() => {
    setLocalAgentAvatarSeed(localAgentAvatarSeed);
  }, [localAgentAvatarSeed]);

  const {
    activeContactRequest,
    activeSettingsSection,
    activeProjectBridgeHost,
    activeDesktopLiveTurn,
    isDesktopChatSending,
    activeChatArtifacts,
    activeProjectArtifacts,
  } = useKordiDesktopActivity({
    activeContactRequestId: contactsUi.activeContactRequestId,
    activeSettingsSectionId: settingsUi.activeSettingsSectionId,
    activeBridgeHost,
    activeNav,
    activeConvId,
    activeConv,
    activeProjectSessionId,
    activeProjectSession,
    activeConversationIsBridge,
    isDesktopBridgeSending,
    desktopLiveTurnsBySession,
    chatConversations,
    setVisibleLocalSessionId,
    setActiveSourcePreview: settingsUi.setActiveSourcePreview,
    setActiveArtifactId: settingsUi.setActiveArtifactId,
    setActiveDetailTab,
    isDetailPanelCollapsed,
    lastSeenArtifactByContextRef,
  });

  useKordiUiEffects({
    isNativeShell,
    desktopChatState,
    desktopAuthState,
    refreshDesktopChat,
    activeNav,
    activeConvId,
    activeProjectId,
    activeProjectSessionId,
    setActiveConvId,
    displayedContacts,
    activeContactId: contactsUi.activeContactId,
    setActiveContactId: contactsUi.setActiveContactId,
    setActiveContactGroup: contactsUi.setActiveContactGroup,
    displayedAgents,
    activeAgentId: agentsUi.activeAgentId,
    setActiveAgentId: agentsUi.setActiveAgentId,
    setActiveSourcePreview: settingsUi.setActiveSourcePreview,
    setActiveArtifactId: settingsUi.setActiveArtifactId,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
    setChatComposerAttachments: composerUi.setChatComposerAttachments,
    openComposerSelector: composerUi.openComposerSelector,
    composerControlsRef,
    themeMode: settingsUi.resolvedThemeMode,
    activeConversationIsBridge,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    setComposerSelections: composerUi.setComposerSelections,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
    activeConvMessagesLength: activeConv.messages.length,
    activeLastMessageTime: activeLastMessage?.time,
    activeProjectSessionIdValue: activeProjectSession.id,
    activeProjectSessionMessagesLength: activeProjectSession.messages.length,
    activeProjectLastMessageTime: activeProjectLastMessage?.time,
    pendingUserChatMessageText: pendingUserChatMessage?.text,
    desktopLiveTurn: activeDesktopLiveTurn,
    setChatSlashMenuIndex: composerUi.setChatSlashMenuIndex,
    chatSlashQuery,
    filteredChatSlashCommandsLength: filteredChatSlashCommands.length,
    projectSlashQuery,
    filteredProjectSlashCommandsLength: filteredProjectSlashCommands.length,
  });

  const getStatusBadgeClass = (value: string) => {
    const normalized = value.toLowerCase();

    if (normalized.includes('owned')) return 'app-badge-owned';
    if (normalized.includes('pending') || normalized.includes('approval')) return 'app-badge-attention';
    return 'app-badge-neutral';
  };

  const openProjectSettings = useCallback(() => {
    setActiveNav('settings');
    settingsUi.setActiveSettingsSectionId('projects');
  }, [setActiveNav, settingsUi]);

  const {
    handleAddBridgeContact,
    handleActivateBridgeAgent,
    handleCreateBridgeAgent,
    handleCreateProjectBridgeInvite,
    handleOpenBridgeConversation,
    handleRemoveBridgeContact,
    handleSetBridgeDiscoveryMode,
    handleSetDefaultBridgeAgent,
    handleStartLocalBridgeHost,
    handleStopLocalBridgeHost,
  } = useBridgeOrchestration({
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
  });

  const {
    handleSelectChatSession,
    handleCreateChatSession,
    handleSelectProjectSession,
    handleRenameDesktopSession,
  } = useDesktopSessionController({
    isNativeShell,
    activeConversationIsBridge,
    activeConvId,
    desktopChatState,
    desktopSessionRenameDraft: sessionUi.desktopSessionRenameDraft,
    selectProjectSession,
    refreshDesktopChat,
    shouldAutoFollowChatRef,
    setActiveConvId,
    setPendingUserChatMessage,
    setChatComposerAttachments: composerUi.setChatComposerAttachments,
    setDesktopBridgeState,
    setDesktopChatError,
    setDesktopChatState,
    setComposerDrafts: composerUi.setComposerDrafts,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
  });

  const {
    toggleComposerSelector,
    selectComposerValue,
    selectComposerAuthChoice,
    selectComposerProviderChoice,
    updateComposerDraft,
    saveDesktopAttachments,
    removeChatComposerAttachment,
    setChatComposerText,
    setProjectComposerText,
    acceptChatSlashCommand,
    acceptProjectSlashCommand,
    acceptChatMentionTarget,
    acceptProjectMentionTarget,
    handleSendChatMessage,
    handleSendProjectMessage,
    handleStopDesktopChatTurn,
  } = useComposerController({
    isNativeShell,
    activeConversationIsBridge,
    activeConvId: activeConv.id,
    activeConvCanonicalSessionId: activeConv.canonicalSessionId,
    activeConvMessages: activeConv.messages,
    activeConvBridgeTarget: activeConv.bridgeTarget,
    activeProjectId,
    activeProjectSessionId,
    desktopChatState,
    desktopBridgeState,
    canonicalHumanIdentityId: canonicalSessionState?.profile.humanIdentityId,
    setCanonicalSessionState,
    desktopLiveTurn: activeDesktopLiveTurn,
    composerSelections: composerUi.composerSelections,
    setComposerSelections: composerUi.setComposerSelections,
    composerDrafts: composerUi.composerDrafts,
    setComposerDrafts: composerUi.setComposerDrafts,
    setProjectWorkspaces: projectsUi.setProjectWorkspaces,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
    chatComposerAttachments: composerUi.chatComposerAttachments,
    setChatComposerAttachments: composerUi.setChatComposerAttachments,
    chatModelOptions,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    handleSelectAuthChoice,
    refreshDesktopAuth,
    refreshDesktopChat,
    handleCreateChatSession,
    handleRenameDesktopSession,
    setActiveNav,
    setActiveSettingsSectionId: settingsUi.setActiveSettingsSectionId,
    setActiveDetailTab,
    setIsDetailPanelCollapsed,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    setDesktopChatState,
    setDesktopChatError,
    isDesktopChatSending: isDesktopBridgeSending,
    setIsDesktopChatSending: setIsDesktopBridgeSending,
    setPendingUserChatMessage,
    queuedDesktopMessagesBySession,
    setQueuedDesktopMessagesBySession,
    setDesktopLiveTurnsBySession,
    setDesktopBridgeState,
    watchDesktopLiveTurn,
    shouldAutoFollowChatRef,
    setActiveConvId,
  });

  useEffect(() => {
    if (!isNativeShell || !desktopAuthState || !desktopChatState?.activeSessionId) return;

    const configuredProviders = buildAuthDisplayProviders(desktopAuthState)
      .filter((provider) => provider.methods.some((method) => method.options.length > 0));

    if (configuredProviders.length === 0) {
      lastAutoAuthProviderSwitchRef.current = null;
      return;
    }

    const normalizedCurrentProvider =
      normalizeSelectedProviderId(desktopChatState.activeSession.provider) ?? desktopChatState.activeSession.provider;
    const currentProviderIsConfigured = configuredProviders.some((provider) => provider.id === normalizedCurrentProvider);

    if (currentProviderIsConfigured) {
      lastAutoAuthProviderSwitchRef.current = null;
      return;
    }

    const normalizedActiveLoginProviderId = normalizeSelectedProviderId(activeLoginProviderId);
    const preferredConfiguredProvider =
      configuredProviders.find((provider) => provider.id === normalizedActiveLoginProviderId)
      ?? configuredProviders.find((provider) => provider.methods.some((method) => method.options.some((option) => option.active)))
      ?? configuredProviders[0];

    if (!preferredConfiguredProvider) return;

    const nextModelValue = preferredModelValueForProvider(preferredConfiguredProvider.id);
    if (!nextModelValue) return;

    const signature = [
      desktopChatState.activeSessionId,
      normalizedCurrentProvider,
      preferredConfiguredProvider.id,
      nextModelValue,
    ].join(':');

    if (lastAutoAuthProviderSwitchRef.current === signature) return;
    lastAutoAuthProviderSwitchRef.current = signature;

    const scope = desktopChatState.activeSessionId === activeProjectSessionId ? 'project' : 'chat';
    void selectComposerValue(scope, 'provider', preferredConfiguredProvider.id);
  }, [
    activeLoginProviderId,
    activeProjectSessionId,
    desktopAuthState,
    desktopChatState?.activeSession.provider,
    desktopChatState?.activeSessionId,
    isNativeShell,
    preferredModelValueForProvider,
    selectComposerValue,
  ]);

  const activeQueuedDesktopMessages = queuedDesktopMessagesBySession[activeConv.id] ?? ('queuedMessages' in activeConv ? activeConv.queuedMessages : undefined) ?? [];

  const optimisticallyRemoveChatSession = useCallback((sessionId: string) => {
    const fallbackSessionId = desktopChatState?.sessions.find((session) => session.id !== sessionId)?.id
      ?? LOCAL_DRAFT_CHAT_CONVERSATION_ID;
    setLocallyHiddenSessionIds((current) => new Set(current).add(sessionId));
    setDesktopChatState((current) => removeSessionFromDesktopState(current, sessionId));
    setCanonicalSessionState((current) => removeSessionFromCanonicalState(current, sessionId));
    if (activeConvId === sessionId || desktopChatState?.activeSessionId === sessionId) {
      setActiveConvId(fallbackSessionId);
    }
  }, [activeConvId, desktopChatState?.activeSessionId, desktopChatState?.sessions, setActiveConvId, setDesktopChatState]);

  const handleArchiveChatSession = useCallback(async (sessionId: string) => {
    if (!isNativeShell || !sessionId.trim()) return;

    optimisticallyRemoveChatSession(sessionId);
    try {
      setDesktopChatError(null);
      const nextState = await archiveDesktopChatSession(sessionId, desktopChatState?.activeSessionId);
      setDesktopChatState(nextState);
      if (activeConvId === sessionId || desktopChatState?.activeSessionId === sessionId) {
        setActiveConvId(nextState.activeSessionId);
      }
      await refreshCanonicalState();
    } catch (error) {
      await refreshCanonicalState();
      const message = error instanceof Error ? error.message : 'Unable to hide session';
      setDesktopChatError(message.startsWith('Session not found') ? null : message);
    }
  }, [activeConvId, desktopChatState?.activeSessionId, isNativeShell, optimisticallyRemoveChatSession, refreshCanonicalState, setActiveConvId, setDesktopChatError, setDesktopChatState]);

  const handleDeleteChatSession = useCallback(async (sessionId: string) => {
    if (!isNativeShell || !sessionId.trim()) return;

    optimisticallyRemoveChatSession(sessionId);
    try {
      setDesktopChatError(null);
      const nextState = await deleteDesktopChatSessionForever(sessionId, desktopChatState?.activeSessionId);
      setDesktopChatState(nextState);
      if (activeConvId === sessionId || desktopChatState?.activeSessionId === sessionId) {
        setActiveConvId(nextState.activeSessionId);
      }
      await refreshCanonicalState();
    } catch (error) {
      await refreshCanonicalState();
      const message = error instanceof Error ? error.message : 'Unable to delete session';
      setDesktopChatError(message.startsWith('Session not found') ? null : message);
    }
  }, [activeConvId, desktopChatState?.activeSessionId, isNativeShell, optimisticallyRemoveChatSession, refreshCanonicalState, setActiveConvId, setDesktopChatError, setDesktopChatState]);

  const handleMoveChatSessionToProject = useCallback(async (sessionId: string, requestedProjectRoot: string) => {
    if (!isNativeShell || !sessionId.trim()) return;

    try {
      setDesktopChatError(null);
      const nextState = await moveDesktopChatSessionToProject(sessionId, requestedProjectRoot);
      setDesktopChatState(nextState);

      const resolvedProjectRoot = nextState.activeSession.project?.root ?? requestedProjectRoot;
      const resolvedProjectId = canonicalProjectGroupIdFromRoot(resolvedProjectRoot) ?? resolvedProjectRoot;
      if (resolvedProjectId) {
        selectProjectSession(resolvedProjectId, nextState.activeSessionId);
        projectsUi.setExpandedProjectIds((current) => ({ ...current, [resolvedProjectId]: true }));
      }
      setActiveNav('projects');
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to move session to project');
    }
  }, [isNativeShell, projectsUi.setExpandedProjectIds, selectProjectSession, setActiveNav, setDesktopChatError, setDesktopChatState]);

  const {
    rootThemeClass,
    lastBridgePollAtLabel,
    onProjectTranscriptScroll,
    onChatTranscriptScroll,
    activeRuntimeSessionId,
    activeRuntimeContextStatus,
    activeRuntimeCacheText,
    activeSessionProject,
    chatModelOptionsForShell,
    wrappedSelectComposerValue,
    wrappedSelectComposerAuthChoice,
    wrappedSelectComposerProviderChoice,
    wrappedStopDesktopChatTurn,
    wrappedSendProjectMessage,
    wrappedSendChatMessage,
  } = useKordiShellViewModel({
    themeMode: settingsUi.resolvedThemeMode,
    lastBridgePollAt,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
    desktopChatState,
    activeConv,
    activeConversationIsBridge,
    chatModelOptions,
    selectComposerValue,
    selectComposerAuthChoice,
    selectComposerProviderChoice,
    handleStopDesktopChatTurn,
    handleSendProjectMessage,
    handleSendChatMessage,
  });

  const shellArgs = useKordiShellArgs({
    isNativeShell,
    windowWidth: windowSize.width,
    activeNav,
    setActiveNav,
    activeConvId,
    setActiveConvId,
    activeProjectId,
    activeProjectSessionId,
    activeSettingsSectionId: settingsUi.activeSettingsSectionId,
    isSingleWorkspacePage,
    collapseChatSessions,
    showSessionRail,
    sessionRailWidth,
    chatConversations,
    isDesktopChatLoading,
    desktopChatError,
    filteredConversations,
    handleCreateChatSession,
    handleSelectChatSession,
    handleArchiveChatSession,
    handleDeleteChatSession,
    handleMoveChatSessionToProject,
    chatSearch: chatsUi.chatSearch,
    setChatSearch: chatsUi.setChatSearch,
    chatFilter: chatsUi.chatFilter,
    setChatFilter: chatsUi.setChatFilter,
    runtimeProjects,
    projectSearch: projectsUi.projectSearch,
    setProjectSearch: projectsUi.setProjectSearch,
    filteredProjects,
    projectSelectedSessionIds,
    selectProject,
    expandedProjectIds: projectsUi.expandedProjectIds,
    setExpandedProjectIds: projectsUi.setExpandedProjectIds,
    groupedContacts,
    displayedContacts,
    setActiveContactGroup: contactsUi.setActiveContactGroup,
    setActiveContactId: contactsUi.setActiveContactId,
    displayedAgents,
    activeBridgeHost,
    localProfileAvatarSeed,
    refreshDesktopBridge,
    handleCopyBridgeText,
    handleCreateBridgeDraft,
    handleSelectProjectSession,
    filteredGroupedContacts,
    isContactRequestsOpen: contactsUi.isContactRequestsOpen,
    setIsContactRequestsOpen: contactsUi.setIsContactRequestsOpen,
    contactRequests: contactRequests,
    activeContactRequestId: contactsUi.activeContactRequestId,
    setActiveContactRequestId: contactsUi.setActiveContactRequestId,
    setContactOverlayMode: contactsUi.setContactOverlayMode,
    contactSearch: contactsUi.contactSearch,
    setContactSearch: contactsUi.setContactSearch,
    expandedContactGroups: contactsUi.expandedContactGroups,
    setExpandedContactGroups: contactsUi.setExpandedContactGroups,
    activeContactId: contactsUi.activeContactId,
    contactOverlayMode: contactsUi.contactOverlayMode,
    activeContact,
    activeContactRequest,
    getStatusBadgeClass,
    handleAddBridgeContact,
    handleActivateBridgeAgent,
    handleCreateBridgeAgent,
    handleOpenBridgeConversation,
    handleRemoveBridgeContact,
    handleSetBridgeDiscoveryMode,
    handleSetDefaultBridgeAgent,
    activeAgentId: agentsUi.activeAgentId,
    setActiveAgentId: agentsUi.setActiveAgentId,
    activeAgent,
    isAgentOverlayOpen: agentsUi.isAgentOverlayOpen,
    setIsAgentOverlayOpen: agentsUi.setIsAgentOverlayOpen,
    desktopBridgeState,
    activeBridgePeople,
    activeBridgeAgents,
    bridgeSettingsDraft,
    setBridgeSettingsDraft,
    isDesktopBridgeSaving,
    desktopBridgeError,
    bridgeWizardOpen,
    setBridgeWizardOpen,
    bridgeWizardStep,
    setBridgeWizardStep,
    bridgeWizardDraft,
    setBridgeWizardDraft,
    handleSelectBridgeHost,
    openBridgeWizard,
    handleStartLocalBridgeHost,
    handleStopLocalBridgeHost,
    handleSaveBridgeSettings,
    handleRemoveBridgeHost,
    handleBridgeWizardPrimary,
    handleOpenBridgeConfigFolder,
    handleRevealBridgeStorageFile,
    handleExportBridgeHostsConfig,
    handleImportBridgeHostsConfig,
    settingsRailWidth,
    settingsContentRef,
    setActiveSettingsSectionId: settingsUi.setActiveSettingsSectionId,
    settingsSections,
    activeSettingsSection,
    authSettingsLayoutWidth,
    desktopAuthState,
    isDesktopAuthLoading,
    desktopAuthError,
    activeLoginProviderId,
    selectAuthProvider,
    openAuthSettings,
    openLoginFlow,
    refreshDesktopAuth,
    handleSelectAuthChoice,
    handleRemoveAuthProfile,
    handleLogoutProvider,
    projectSettingsDraft,
    isDesktopProjectSaving,
    desktopProjectError,
    handleSaveProjectSettings,
    updateProjectSettingsDraft,
    themeMode: settingsUi.themeMode,
    setThemeMode: settingsUi.setThemeMode,
    showRightDetailRail,
    isDetailPanelCollapsed,
    setIsDetailPanelCollapsed,
    setIsSessionPanelCollapsed,
    activeProject,
    activeProjectSession,
    desktopSessionRenameDraft: sessionUi.desktopSessionRenameDraft,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    isEditingDesktopSessionTitle: sessionUi.isEditingDesktopSessionTitle,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    handleRenameDesktopSession,
    activeProjectBridgeHost,
    activeProjectBridgeProject,
    chatTranscriptScrollRef,
    onProjectTranscriptScroll,
    onChatTranscriptScroll,
    activeSourcePreview: settingsUi.activeSourcePreview,
    setActiveSourcePreview: settingsUi.setActiveSourcePreview,
    activeArtifactId: settingsUi.activeArtifactId,
    setActiveArtifactId: settingsUi.setActiveArtifactId,
    activeChatArtifacts,
    activeProjectArtifacts,
    desktopLiveTurn: activeDesktopLiveTurn,
    filteredProjectSlashCommands,
    filteredChatSlashCommands,
    filteredProjectMentionTargets,
    filteredChatMentionTargets,
    chatSlashMenuIndex: composerUi.chatSlashMenuIndex,
    setChatSlashMenuIndex: composerUi.setChatSlashMenuIndex,
    acceptProjectSlashCommand,
    acceptChatSlashCommand,
    acceptProjectMentionTarget,
    acceptChatMentionTarget,
    chatAttachmentInputRef,
    chatComposerAttachments: composerUi.chatComposerAttachments,
    saveDesktopAttachments,
    removeChatComposerAttachment,
    projectComposerText: composerUi.composerDrafts.project,
    chatComposerText: composerUi.composerDrafts.chat,
    updateProjectComposerDraft: (value, target) => updateComposerDraft('project', value, target),
    updateChatComposerDraft: (value, target) => updateComposerDraft('chat', value, target),
    setProjectComposerText,
    setChatComposerText,
    composerControlsRef,
    activeRuntimeSessionId,
    activeRuntimeContextStatus,
    activeRuntimeCacheText,
    composerSelectionProject: composerUi.composerSelections.project,
    composerSelectionChat: composerUi.composerSelections.chat,
    openComposerSelector: composerUi.openComposerSelector,
    toggleComposerSelector,
    selectComposerValue: wrappedSelectComposerValue,
    composerAuthLabelProject: composerAuthByScope.labelByScope.project,
    composerAuthLabelChat: composerAuthByScope.labelByScope.chat,
    composerAuthOptionsProject: composerAuthByScope.optionsByScope.project,
    composerAuthOptionsChat: composerAuthByScope.optionsByScope.chat,
    selectComposerAuthChoice: wrappedSelectComposerAuthChoice,
    selectComposerProviderChoice: wrappedSelectComposerProviderChoice,
    composerProviderOptions,
    chatModelOptions: chatModelOptionsForShell,
    isDesktopChatSending,
    handleStopDesktopChatTurn: wrappedStopDesktopChatTurn,
    handleSendProjectMessage: wrappedSendProjectMessage,
    handleSendChatMessage: wrappedSendChatMessage,
    showChatDetailRail,
    activeDetailTab,
    setActiveDetailTab,
    activeProjectLastMessage,
    isProjectBridgeBusy,
    bridgeInvite,
    handleCreateProjectBridgeInvite,
    openProjectSettings,
    activeConv,
    activeConvHasSubtitle,
    activeLastMessage,
    activeConversationIsBridge,
    activeBridgeConversationHost,
    activeBridgeConversation,
    activeBridgeAwaitingReply,
    isBridgePolling,
    lastBridgePollAtLabel,
    activeSessionProject,
    activeQueuedDesktopMessages,
    showAuthGate,
    dismissAuthGate,
    inlineAuthDialog,
    handleCloseInlineAuthDialog,
    startWindowResize,
  });

  const shellSlots = assembleKordiShellSlots(shellArgs);

  return {
    rootThemeClass,
    isNativeShell,
    isLayoutResizing,
    windowSize,
    leftWorkspaceWidth,
    isSingleWorkspacePage,
    showSessionRail,
    collapseChatSessions,
    showRightDetailRail,
    isDetailPanelCollapsed,
    detailRailWidth,
    onSessionResizeMouseDown: startPanelResize('session'),
    onDetailResizeMouseDown: startPanelResize('detail'),
    sidebar: shellSlots.sidebar,
    mainContent: shellSlots.mainContent,
    rightDetailRail: shellSlots.rightDetailRail,
    authGate: shellSlots.authGate,
    inlineAuthDialog: shellSlots.inlineAuthDialog,
    windowResizeHandles: shellSlots.windowResizeHandles,
  };
}
