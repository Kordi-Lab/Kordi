import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authStateSatisfiesStartupGate, buildAuthDisplayProviders, normalizeSelectedProviderId } from '@/kordi-app/auth/model';
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
import {
  buildProjectRoutingGroups,
  canonicalProjectGroupIdFromRoot,
  isCanonicalBridgeSessionId,
} from '@/features/canonical/sessionResolver';
import { useDesktopChatState } from '@/features/chat/useDesktopChatState';
import { useComposerController } from '@/features/chat/useComposerController';
import { useComposerViewModel } from '@/features/chat/useComposerViewModel';
import { mentionScopeConversationForActiveConversation } from '@/features/chat/messageActions/mentions';
import {
  adminIdentityIdsFromMetadata,
  agentCanonicalIdentityRequest,
  buildChatAgentSessionKind,
  buildChatAgentSessionMetadata,
  buildChatCreateGroupBridgeInviteParticipants,
  buildChatCreateGroupBridgeInviteTargets,
  buildChatCreateGroupInviteText,
  buildChatCreateGroupMetadata,
  buildChatGroupBridgeUpdateParticipants,
  buildChatGroupBridgeUpdateTargets,
  CHAT_GROUP_INVITE_CONTEXT_POLICY,
  CHAT_GROUP_UPDATE_CONTEXT_POLICY,
  buildChatCreatePersonOptions,
  buildParticipantSpaceContinuationMetadata,
  chatSessionIdForAgentStart,
  chatSessionIdForParticipantSpaceContinuation,
  chatSessionIdForPersonStart,
  contactCanonicalIdentityRequest,
  existingBlankSessionIdForAgentStart,
  existingBlankSessionIdForParticipantSpace,
  groupDefaultName,
} from '@/features/chat/chatCreateFlows';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID, projectDraftSessionId } from '@/features/chat/draftSessions';
import { updateScopeDraft } from '@/features/chat/composerDrafts';
import { useDesktopSessionController } from '@/features/chat/useDesktopSessionController';
import { useDesktopTranscriptAdapter } from '@/features/chat/useDesktopTranscriptAdapter';
import { useBridgeOrchestration } from '@/features/bridge/useBridgeOrchestration';
import { mergeDesktopBridgeState, useBridgeState } from '@/features/bridge/useBridgeState';
import { buildBridgeMentionTargetsByScope } from '@/app/useKordiAppModelBridgeMentions';
import { setLocalAgentAvatarSeed, setLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { Agent, CanonicalSessionState, ComposerScope, Contact, DesktopChatState, ParticipantSpaceViewModel } from '@/kordi-app/types';
import { createSingleFlightState, requestSingleFlightRun } from '@/lib/singleFlight';
import {
  addCanonicalSessionParticipants,
  archiveDesktopChatSession,
  createDesktopBridgeOutreach,
  createDesktopProject,
  createDesktopProjectFromFolder,
  deleteDesktopChatSessionForever,
  fetchCanonicalSessionState,
  moveDesktopChatSessionToProject,
  openOrCreateCanonicalSession,
  removeCanonicalSessionParticipant,
  renameCanonicalSession,
  setCanonicalSessionParticipantRole,
  updateCanonicalSessionMetadata,
  upsertCanonicalIdentity,
} from '@/lib/desktop';

import {
  activeGroupAdminIds,
  canonicalAvatarSeed,
  canonicalGroupInviteContextForSession,
  canonicalGroupParticipantsForSession,
  canonicalLocalAgentAvatarSeed,
  currentMentionQuery,
  filterMentionTargets,
  isNativeDesktopShell,
  metadataGroupSpaceId,
  metadataString,
  metadataStringArray,
  normalizeMentionSearch,
  normalizeStoredGroupSpaceId,
  participantSpaceCreateKey,
  participantSpaceNonSelfIdentities,
  removeSessionFromCanonicalState,
  removeSessionFromDesktopState,
  sessionMetadataRecord,
  uniqueStrings,
} from '@/app/useKordiAppModelHelpers';

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
  const canonicalRefreshFlightRef = useRef(createSingleFlightState());
  const pendingParticipantSpaceCreateRef = useRef<Map<string, string>>(new Map());

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

  const startupGateSatisfied = useMemo(
    () => authStateSatisfiesStartupGate(desktopAuthState),
    [desktopAuthState],
  );

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
    startupGateSatisfied,
    setActiveNav,
    setActiveSettingsSectionId: settingsUi.setActiveSettingsSectionId,
    setActiveLoginProviderId,
    clearDesktopAuthError,
  });

  const composerDraftsView = useMemo<Record<ComposerScope, string>>(() => ({
    chat:    composerUi.composerDrafts.chat[activeConvId]?.text                ?? '',
    project: composerUi.composerDrafts.project[activeProjectSessionId]?.text   ?? '',
  }), [composerUi.composerDrafts, activeConvId, activeProjectSessionId]);

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
    composerDrafts: composerDraftsView,
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
    composerChatText: composerDraftsView.chat,
    shouldAutoFollowChatRef,
  });

  const avatarBridgeHost = desktopBridgeState?.hosts.find((host) => host.id === desktopBridgeState.activeHostId)
    ?? desktopBridgeState?.hosts[0]
    ?? null;
  const avatarBridgeHostAgentId = avatarBridgeHost?.activeAgentId ?? null;
  const avatarBridgeAgent = avatarBridgeHost?.agents.find((agent) => agent.id === avatarBridgeHostAgentId)
    ?? avatarBridgeHost?.agents.find((agent) => agent.isActive)
    ?? avatarBridgeHost?.agents.find((agent) => agent.isDefault)
    ?? avatarBridgeHost?.agents[0]
    ?? null;
  const localProfileAvatarSeed = canonicalAvatarSeed(canonicalSessionState, canonicalSessionState?.profile.humanIdentityId)
    || avatarBridgeHost?.humanId?.trim()
    || canonicalSessionState?.profile.id?.trim()
    || null;
  const localAgentAvatarSeed = canonicalLocalAgentAvatarSeed(canonicalSessionState)
    || avatarBridgeAgent?.id?.trim()
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
      ...(desktopChatState?.projects ?? []).flatMap((project) => [
        `${project.id}:${project.root}:${project.name}:${project.sessions.length}`,
        ...project.sessions.map((session) => `${project.id}:${session.id}:${session.messageCount}:${session.updatedAtLabel}`),
      ]),
    ].join('|'),
    [desktopChatState],
  );

  const bridgeCanonicalRefreshKey = useMemo(
    () => (desktopBridgeState?.conversations ?? []).map((conversation) => `${conversation.id}:${conversation.updatedAtMs}:${conversation.messages.length}`).join('|'),
    [desktopBridgeState?.conversations],
  );

  const refreshCanonicalState = useCallback(async () => {
    if (!isNativeShell) return;
    const flight = canonicalRefreshFlightRef.current;
    const run = requestSingleFlightRun(flight, async () => {
      try {
        setCanonicalSessionState(await fetchCanonicalSessionState());
      } catch {
        // Canonical state is additive during migration; legacy UI remains usable if it is unavailable.
      }
    });
    await (run ?? flight.currentPromise ?? Promise.resolve());
  }, [isNativeShell]);

  useEffect(() => {
    void refreshCanonicalState();
  }, [bridgeCanonicalRefreshKey, desktopCanonicalRefreshKey, refreshCanonicalState]);

  const {
    chatConversations,
    filteredConversations,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
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

  const activeConvMentionScope = useMemo(
    () => mentionScopeConversationForActiveConversation(activeConv, chatConversations),
    [activeConv, chatConversations],
  );

  const bridgeMentionTargetsByScope = useMemo(() => buildBridgeMentionTargetsByScope({
    isNativeShell,
    desktopBridgeState,
    desktopChatState,
    activeConvMentionScope,
  }), [activeConvMentionScope, desktopBridgeState, desktopChatState, isNativeShell]);

  const chatMentionQuery = useMemo(() => currentMentionQuery(composerDraftsView.chat), [composerDraftsView.chat]);
  const projectMentionQuery = useMemo(() => currentMentionQuery(composerDraftsView.project), [composerDraftsView.project]);
  const filteredChatMentionTargets = useMemo(() => filterMentionTargets(bridgeMentionTargetsByScope.chat, chatMentionQuery), [bridgeMentionTargetsByScope.chat, chatMentionQuery]);
  const filteredProjectMentionTargets = useMemo(() => filterMentionTargets(bridgeMentionTargetsByScope.project, projectMentionQuery), [bridgeMentionTargetsByScope.project, projectMentionQuery]);

  useEffect(() => {
    for (const [spaceKey, sessionId] of pendingParticipantSpaceCreateRef.current) {
      const space = participantSpaces.find((candidate) => participantSpaceCreateKey(candidate) === spaceKey);
      const pendingSessionIsVisible = space?.sessions.some((session) => session.id === sessionId || session.canonicalSessionId === sessionId);
      if (!space || existingBlankSessionIdForParticipantSpace(space) || pendingSessionIsVisible) {
        pendingParticipantSpaceCreateRef.current.delete(spaceKey);
      }
    }
  }, [participantSpaces]);

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

  const {
    handleAddBridgeContact,
    handleActivateBridgeAgent,
    handleCreateBridgeAgent,
    handleCreateProjectBridgeInvite,
    handleOpenBridgeConversation,
    handleRemoveBridgeContact,
    handleStartBridgePersonSession,
    handleSetBridgeDiscoveryMode,
    handleSetDefaultBridgeAgent,
    handleUpdateBridgeAgentModelRouting,
    handleUpdateLocalAgentModelRouting,
    handleStartLocalBridgeHost,
    handleStopLocalBridgeHost,
  } = useBridgeOrchestration({
    isNativeShell,
    activeProject,
    activeProjectBridgeHost,
    activeBridgeHost,
    bridgeSettingsDraft,
    canonicalHumanIdentityId: canonicalSessionState?.profile.humanIdentityId,
    setCanonicalSessionState,
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
    saveDesktopAttachmentPaths,
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
    handleStopBridgeAgentRequest,
  } = useComposerController({
    isNativeShell,
    activeConversationIsBridge,
    activeConvId: activeConv.id,
    activeConvCanonicalSessionId: activeConv.canonicalSessionId,
    activeConvMessages: activeConv.messages,
    activeConvBridgeTarget: activeConv.bridgeTarget,
    activeConvMentionScope,
    activeProjectId,
    activeProjectSessionId,
    activeProjectRoot: activeProject.root,
    selectProjectSession,
    desktopChatState,
    desktopBridgeState,
    canonicalHumanIdentityId: canonicalSessionState?.profile.humanIdentityId,
    setCanonicalSessionState,
    desktopLiveTurn: activeDesktopLiveTurn,
    composerSelections: composerUi.composerSelections,
    setComposerSelections: composerUi.setComposerSelections,
    composerDrafts: composerDraftsView,
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
      .filter((provider) => provider.configured);

    if (configuredProviders.length === 0) {
      lastAutoAuthProviderSwitchRef.current = null;
      return;
    }

    const normalizedCurrentProvider =
      normalizeSelectedProviderId(desktopChatState.activeSession.provider) ?? desktopChatState.activeSession.provider;
    const currentProviderIsConfigured = configuredProviders.some((provider) => provider.id === normalizedCurrentProvider);
    const currentProviderHasRuntimeModels = desktopChatState.modelOptions.some((option) => (
      (normalizeSelectedProviderId(option.provider) ?? option.provider) === normalizedCurrentProvider
    ));

    if (currentProviderIsConfigured || currentProviderHasRuntimeModels) {
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
    desktopChatState?.modelOptions,
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
    composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'chat', sessionId, ''));
    if (activeConvId === sessionId || desktopChatState?.activeSessionId === sessionId) {
      setActiveConvId(fallbackSessionId);
    }
  }, [activeConvId, composerUi.setComposerDrafts, desktopChatState?.activeSessionId, desktopChatState?.sessions, setActiveConvId, setDesktopChatState]);

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

  const handleSelectCreatedProject = useCallback(async (projectRoot: string) => {
    const projectId = canonicalProjectGroupIdFromRoot(projectRoot) ?? projectRoot;
    setActiveNav('projects');
    selectProject(projectId);
    projectsUi.setExpandedProjectIds((current) => ({ ...current, [projectId]: true }));
    await refreshDesktopChat(desktopChatState?.activeSessionId);
    await refreshCanonicalState();
  }, [desktopChatState?.activeSessionId, projectsUi.setExpandedProjectIds, refreshCanonicalState, refreshDesktopChat, selectProject, setActiveNav]);

  const handleCreateProjectFromFolder = useCallback(async (folderPath: string, name?: string) => {
    if (!isNativeShell) return;
    try {
      setDesktopChatError(null);
      const project = await createDesktopProjectFromFolder(folderPath, name);
      await handleSelectCreatedProject(project.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create project from folder';
      setDesktopChatError(message);
      throw new Error(message);
    }
  }, [handleSelectCreatedProject, isNativeShell, setDesktopChatError]);

  const handleCreateProject = useCallback(async (name: string, parentDir?: string) => {
    if (!isNativeShell) return;
    try {
      setDesktopChatError(null);
      const project = await createDesktopProject(name, parentDir);
      await handleSelectCreatedProject(project.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create project';
      setDesktopChatError(message);
      throw new Error(message);
    }
  }, [handleSelectCreatedProject, isNativeShell, setDesktopChatError]);

  const handleCreateProjectSession = useCallback(async () => {
    if (!isNativeShell) return;
    const projectRoot = activeProject.root?.trim();
    if (!projectRoot) return;

    setDesktopChatError(null);
    const projectId = canonicalProjectGroupIdFromRoot(projectRoot) ?? activeProject.id;
    const draftSessionId = projectDraftSessionId(projectId);
    selectProjectSession(projectId, draftSessionId);
    projectsUi.setExpandedProjectIds((current) => ({ ...current, [projectId]: true }));
    composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'project', draftSessionId, ''));
    composerUi.setChatComposerAttachments([]);
    composerUi.setOpenComposerSelector(null);
    setActiveNav('projects');
  }, [
    activeProject.id,
    activeProject.root,
    composerUi.setChatComposerAttachments,
    composerUi.setComposerDrafts,
    composerUi.setOpenComposerSelector,
    isNativeShell,
    projectsUi.setExpandedProjectIds,
    selectProjectSession,
    setActiveNav,
    setDesktopChatError,
  ]);

  const peopleContactById = useMemo(() => new Map(
    buildChatCreatePersonOptions(displayedContacts).map((option) => [option.id, option.contact]),
  ), [displayedContacts]);

  const selectNewChatSession = useCallback((sessionId: string) => {
    setActiveNav('chats');
    setActiveConvId(sessionId);
    composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'chat', sessionId, ''));
    composerUi.setChatComposerAttachments([]);
    composerUi.setOpenComposerSelector(null);
  }, [
    composerUi.setChatComposerAttachments,
    composerUi.setComposerDrafts,
    composerUi.setOpenComposerSelector,
    setActiveConvId,
    setActiveNav,
  ]);

  const handleStartChatWithPerson = useCallback(async (contact: Contact) => {
    setDesktopChatError(null);
    if (contact.bridgeHostId && contact.bridgePeerNodeId) {
      await handleStartBridgePersonSession({
        hostId: contact.bridgeHostId,
        nodeId: contact.bridgePeerNodeId,
        displayName: contact.name,
        ownerName: contact.owner,
        humanId: contact.bridgeHumanId,
      });
      return;
    }

    if (!isNativeShell) return;
    const creatorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const identityRequest = contactCanonicalIdentityRequest(contact);
    const targetIdentityId = identityRequest.id?.trim();
    if (!targetIdentityId) {
      throw new Error('Unable to resolve contact identity.');
    }
    const identityState = await upsertCanonicalIdentity(identityRequest);
    setCanonicalSessionState(identityState);
    const sessionId = chatSessionIdForPersonStart(crypto.randomUUID());
    const nextState = await openOrCreateCanonicalSession({
      id: sessionId,
      kind: 'direct-person',
      title: 'New session',
      status: 'active',
      createdByIdentityId: creatorIdentityId,
      primaryIdentityId: targetIdentityId,
      relationshipIdentityId: targetIdentityId,
      participantIdentityIds: [targetIdentityId],
      metadata: { createdFrom: 'chat-create-flow', contactId: contact.id, participantSpaceKind: 'direct-human' },
    });
    setCanonicalSessionState(nextState);
    selectNewChatSession(sessionId);
  }, [
    canonicalSessionState?.profile.humanIdentityId,
    handleStartBridgePersonSession,
    isNativeShell,
    selectNewChatSession,
    setDesktopChatError,
  ]);

  const handleStartChatWithAgent = useCallback(async (agent: Agent) => {
    setDesktopChatError(null);
    setActiveNav('chats');

    if (agent.isOwned) {
      if (!isNativeShell) {
        await handleCreateChatSession();
        return;
      }
      const creatorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
      if (!creatorIdentityId) {
        throw new Error('Local profile identity is not ready yet.');
      }
      if (agent.bridgeHostId && agent.bridgeAgentId && !agent.isBridgeActive) {
        await handleActivateBridgeAgent(agent.bridgeHostId, agent.bridgeAgentId);
      }
      const existingBlankSessionId = existingBlankSessionIdForAgentStart(agent, chatConversations);
      if (existingBlankSessionId) {
        selectNewChatSession(existingBlankSessionId);
        return;
      }
      const identityRequest = agentCanonicalIdentityRequest(agent);
      const targetIdentityId = identityRequest.id?.trim();
      if (!targetIdentityId) {
        throw new Error('Unable to resolve agent identity.');
      }
      const identityState = await upsertCanonicalIdentity(identityRequest);
      setCanonicalSessionState(identityState);
      const sessionId = chatSessionIdForAgentStart(agent, crypto.randomUUID());
      const nextState = await openOrCreateCanonicalSession({
        id: sessionId,
        kind: buildChatAgentSessionKind(agent),
        title: agent.name || 'New session',
        status: 'active',
        createdByIdentityId: creatorIdentityId,
        primaryIdentityId: targetIdentityId,
        relationshipIdentityId: null,
        participantIdentityIds: [targetIdentityId],
        metadata: buildChatAgentSessionMetadata(agent),
      });
      setCanonicalSessionState(nextState);
      selectNewChatSession(sessionId);
      return;
    }

    if (!isNativeShell) return;
    const creatorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const identityRequest = agentCanonicalIdentityRequest(agent);
    const targetIdentityId = identityRequest.id?.trim();
    if (!targetIdentityId) {
      throw new Error('Unable to resolve agent identity.');
    }
    const identityState = await upsertCanonicalIdentity(identityRequest);
    setCanonicalSessionState(identityState);
    const sessionId = chatSessionIdForAgentStart(agent, crypto.randomUUID());
    const nextState = await openOrCreateCanonicalSession({
      id: sessionId,
      kind: buildChatAgentSessionKind(agent),
      title: agent.name || 'New session',
      status: 'active',
      createdByIdentityId: creatorIdentityId,
      primaryIdentityId: targetIdentityId,
      relationshipIdentityId: null,
      participantIdentityIds: [targetIdentityId],
      metadata: buildChatAgentSessionMetadata(agent),
    });
    setCanonicalSessionState(nextState);
    selectNewChatSession(sessionId);
  }, [
    canonicalSessionState?.profile.humanIdentityId,
    chatConversations,
    handleActivateBridgeAgent,
    handleCreateChatSession,
    isNativeShell,
    selectNewChatSession,
    setActiveNav,
    setDesktopChatError,
  ]);

  const handleCreateChatGroup = useCallback(async (request: { name?: string | null; contactIds: string[] }) => {
    if (!isNativeShell) return;
    setDesktopChatError(null);
    const currentCanonicalState = canonicalSessionState;
    const creatorIdentityId = currentCanonicalState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId || !currentCanonicalState) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const contacts = uniqueStrings(request.contactIds)
      .map((contactId) => peopleContactById.get(contactId))
      .filter((contact): contact is Contact => Boolean(contact));
    if (contacts.length < 2) {
      throw new Error('Select at least 2 people to start a group.');
    }

    const identityIds: string[] = [];
    for (const contact of contacts) {
      const identityRequest = contactCanonicalIdentityRequest(contact);
      const identityId = identityRequest.id?.trim();
      if (!identityId) continue;
      const identityState = await upsertCanonicalIdentity(identityRequest);
      setCanonicalSessionState(identityState);
      identityIds.push(identityId);
    }

    const participantIdentityIds = uniqueStrings(identityIds);
    if (participantIdentityIds.length < 2) {
      throw new Error('Select at least 2 people to start a group.');
    }
    const selectedNames = contacts.map((contact) => contact.name);
    const groupDisplayName = request.name?.trim() || groupDefaultName(selectedNames);
    const sessionId = `session:group:${crypto.randomUUID()}`;
    const nextState = await openOrCreateCanonicalSession({
      id: sessionId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId: creatorIdentityId,
      primaryIdentityId: null,
      relationshipIdentityId: null,
      participantIdentityIds,
      metadata: buildChatCreateGroupMetadata({
        creatorIdentityId,
        selectedContactIds: contacts.map((contact) => contact.id),
        selectedNames,
        customName: groupDisplayName,
        groupSpaceId: sessionId,
      }),
    });
    setCanonicalSessionState(nextState);

    const creatorIdentity = currentCanonicalState.identities.find((identity) => identity.id === creatorIdentityId);
    const creatorInviteIdentity = {
      id: creatorIdentityId,
      displayName: creatorIdentity?.displayName?.trim()
        || currentCanonicalState.profile.displayName?.trim()
        || activeBridgeHost?.ownerName?.trim()
        || 'Me',
      bridgeNodeId: creatorIdentity?.bridgeNodeId?.trim() || activeBridgeHost?.nodeId?.trim() || null,
      humanId: creatorIdentity?.humanId?.trim() || activeBridgeHost?.humanId?.trim() || null,
    };
    const inviteTargets = buildChatCreateGroupBridgeInviteTargets(contacts);
    const inviteParticipants = buildChatCreateGroupBridgeInviteParticipants({
      creator: creatorInviteIdentity,
      contacts,
    });
    if (inviteTargets.length > 0) {
      const inviteText = buildChatCreateGroupInviteText(groupDisplayName);
      try {
        for (const target of inviteTargets) {
          const inviteState = await createDesktopBridgeOutreach({
            hostId: target.hostId,
            targetNodeId: target.nodeId,
            targetKind: 'bridge-person',
            requestText: inviteText,
            targetDisplayName: target.displayName,
            targetOwnerName: target.ownerName,
            targetRuntime: 'person',
            targetHumanId: target.humanId,
            targetAgentId: null,
            triggerText: null,
            contextText: null,
            contextPolicy: CHAT_GROUP_INVITE_CONTEXT_POLICY,
            parentSessionId: sessionId,
            parentSessionTitle: groupDisplayName,
            parentSessionKind: 'group',
            parentSessionParticipants: inviteParticipants,
            parentSessionMessages: [],
            parentTurnId: null,
            parentMessageId: null,
            projectId: null,
            projectName: null,
          });
          setDesktopBridgeState((current) => mergeDesktopBridgeState(current, inviteState));
        }
      } catch (error) {
        setDesktopChatError(`Group created, but Bridge invites failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    selectNewChatSession(sessionId);
  }, [
    activeBridgeHost,
    canonicalSessionState,
    isNativeShell,
    peopleContactById,
    selectNewChatSession,
    setDesktopBridgeState,
    setDesktopChatError,
  ]);

  const handleCreateChatSessionInParticipantSpace = useCallback(async (space: ParticipantSpaceViewModel) => {
    if (space.kind === 'self') {
      await handleCreateChatSession();
      return;
    }

    const existingBlankSessionId = existingBlankSessionIdForParticipantSpace(space);
    if (existingBlankSessionId) {
      selectNewChatSession(existingBlankSessionId);
      return;
    }

    if (!isNativeShell) return;
    setDesktopChatError(null);

    const creatorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }

    const sourceSession = space.sessions[0] ?? null;
    const sourceSessionId = sourceSession?.canonicalSessionId ?? sourceSession?.id ?? null;
    const sourceMetadata = sourceSessionId ? sessionMetadataRecord(canonicalSessionState, sourceSessionId) : {};
    const sessionId = chatSessionIdForParticipantSpaceContinuation(space, crypto.randomUUID());
    const createKey = participantSpaceCreateKey(space);
    const pendingSessionId = pendingParticipantSpaceCreateRef.current.get(createKey);
    if (pendingSessionId) {
      selectNewChatSession(pendingSessionId);
      return;
    }
    pendingParticipantSpaceCreateRef.current.set(createKey, sessionId);

    try {
      if (space.kind === 'group') {
        const members = participantSpaceNonSelfIdentities(space, 'human');
        const participantIdentityIds = uniqueStrings(members.map((member) => member.id));
        if (participantIdentityIds.length < 2) {
          throw new Error('A group session needs at least 2 other people.');
        }

        const adminIds = sourceSessionId
          ? uniqueStrings(activeGroupAdminIds(canonicalSessionState, sourceSessionId))
          : [];
        const metadataAdminIds = adminIdentityIdsFromMetadata(sourceMetadata);
        const customName = metadataString(sourceMetadata, 'customName') || space.title;
        const participantNames = members.map((member) => member.name);
        const groupSpaceId = metadataGroupSpaceId(sourceMetadata) || normalizeStoredGroupSpaceId(space.id) || sourceSessionId;
        const nextState = await openOrCreateCanonicalSession({
          id: sessionId,
          kind: 'group',
          title: 'New session',
          status: 'active',
          createdByIdentityId: creatorIdentityId,
          primaryIdentityId: null,
          relationshipIdentityId: null,
          participantIdentityIds,
          metadata: {
            ...sourceMetadata,
            schemaVersion: 1,
            kind: 'chat-group',
            customName,
            groupId: groupSpaceId,
            groupSpaceId,
            adminIdentityIds: uniqueStrings([creatorIdentityId, ...adminIds, ...metadataAdminIds]),
            initialContactIds: metadataStringArray(sourceMetadata, 'initialContactIds'),
            initialParticipantNames: uniqueStrings([
              ...metadataStringArray(sourceMetadata, 'initialParticipantNames'),
              ...participantNames,
            ]),
            memberApprovalPolicy: 'under-50-open',
            createdFrom: 'chat-create-flow',
            continuedFromSessionId: sourceSessionId,
            continuedFromSpaceId: space.id,
          },
        });
        setCanonicalSessionState(nextState);
        selectNewChatSession(sessionId);
        return;
      }

      const receiver = participantSpaceNonSelfIdentities(space)[0];
      if (!receiver) {
        pendingParticipantSpaceCreateRef.current.delete(createKey);
        await handleCreateChatSession();
        return;
      }

      const kind = receiver.kind === 'agent' ? 'direct-agent' : 'direct-person';
      const nextState = await openOrCreateCanonicalSession({
        id: sessionId,
        kind,
        title: 'New session',
        status: 'active',
        createdByIdentityId: creatorIdentityId,
        primaryIdentityId: receiver.id,
        relationshipIdentityId: receiver.id,
        participantIdentityIds: [receiver.id],
        metadata: buildParticipantSpaceContinuationMetadata({
          sourceMetadata,
          continuedFromSessionId: sourceSessionId,
          continuedFromSpaceId: space.id,
          participantSpaceKind: space.kind,
        }),
      });
      setCanonicalSessionState(nextState);
      selectNewChatSession(sessionId);
    } catch (error) {
      pendingParticipantSpaceCreateRef.current.delete(createKey);
      throw error;
    }
  }, [
    canonicalSessionState,
    handleCreateChatSession,
    isNativeShell,
    selectNewChatSession,
    setDesktopChatError,
  ]);

  const handleRenameChatGroup = useCallback(async (sessionIds: string[], name: string) => {
    if (!isNativeShell) return;
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
    const title = name.trim();
    if (!title) throw new Error('Group name is required.');
    setDesktopChatError(null);

    const actorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!actorIdentityId) throw new Error('Local profile identity is not ready yet.');

    const fallbackGroupSpaceId = groupSessionIds[0];
    let nextState = canonicalSessionState;
    const renamedGroupIds = new Map<string, string>();
    for (const sessionId of groupSessionIds) {
      nextState = await renameCanonicalSession({
        sessionId,
        title,
        requestedByIdentityId: actorIdentityId,
      });
      const currentMetadata = sessionMetadataRecord(nextState, sessionId);
      const groupId = metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId;
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: actorIdentityId,
        metadata: {
          ...currentMetadata,
          customName: title,
          groupId,
          groupSpaceId: groupId,
        },
      });
      renamedGroupIds.set(groupId, sessionId);
    }
    setCanonicalSessionState(nextState);

    try {
      for (const [groupId, sourceSessionId] of renamedGroupIds) {
        const participants = canonicalGroupParticipantsForSession(nextState, sourceSessionId);
        const targets = buildChatGroupBridgeUpdateTargets({ actorIdentityId, participants });
        if (targets.length === 0) continue;
        const updateParticipants = buildChatGroupBridgeUpdateParticipants({
          participants,
          adminIdentityIds: activeGroupAdminIds(nextState, sourceSessionId),
        });
        for (const target of targets) {
          const bridgeState = await createDesktopBridgeOutreach({
            hostId: target.hostId,
            targetNodeId: target.nodeId,
            targetKind: 'bridge-person',
            requestText: `Group renamed to ${title}`,
            targetDisplayName: target.displayName,
            targetOwnerName: target.ownerName,
            targetRuntime: 'person',
            targetHumanId: target.humanId,
            targetAgentId: null,
            triggerText: null,
            contextText: null,
            contextPolicy: CHAT_GROUP_UPDATE_CONTEXT_POLICY,
            parentSessionId: groupId,
            parentSessionTitle: title,
            parentSessionKind: 'group',
            parentSessionParticipants: updateParticipants,
            parentSessionMessages: [],
            parentTurnId: null,
            parentMessageId: null,
            projectId: null,
            projectName: null,
          });
          setDesktopBridgeState((current) => mergeDesktopBridgeState(current, bridgeState));
        }
      }
    } catch (error) {
      setDesktopChatError(`Group renamed, but Bridge rename sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [canonicalSessionState, isNativeShell, setDesktopBridgeState, setDesktopChatError]);

  const handleAddChatGroupMembers = useCallback(async (sessionIds: string[], contactIds: string[]) => {
    if (!isNativeShell) return;
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
    setDesktopChatError(null);
    const creatorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const contacts = uniqueStrings(contactIds)
      .map((contactId) => peopleContactById.get(contactId))
      .filter((contact): contact is Contact => Boolean(contact));
    const identityIds: string[] = [];
    let nextState = canonicalSessionState;
    for (const contact of contacts) {
      const identityRequest = contactCanonicalIdentityRequest(contact);
      const identityId = identityRequest.id?.trim();
      if (!identityId) continue;
      nextState = await upsertCanonicalIdentity(identityRequest);
      identityIds.push(identityId);
    }
    const participantIdentityIds = uniqueStrings(identityIds);
    if (participantIdentityIds.length === 0) return;

    for (const sessionId of groupSessionIds) {
      nextState = await addCanonicalSessionParticipants({
        sessionId,
        identityIds: participantIdentityIds,
        addedByIdentityId: creatorIdentityId,
      });
    }

    const fallbackGroupSpaceId = groupSessionIds[0];
    const addedContactIds = contacts.map((contact) => contact.id);
    const addedNames = contacts.map((contact) => contact.name);
    for (const sessionId of groupSessionIds) {
      const currentMetadata = sessionMetadataRecord(nextState, sessionId);
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: creatorIdentityId,
        metadata: {
          ...currentMetadata,
          groupId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          groupSpaceId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          initialContactIds: uniqueStrings([...metadataStringArray(currentMetadata, 'initialContactIds'), ...addedContactIds]),
          initialParticipantNames: uniqueStrings([...metadataStringArray(currentMetadata, 'initialParticipantNames'), ...addedNames]),
        },
      });
    }
    setCanonicalSessionState(nextState);

    const inviteTargets = buildChatCreateGroupBridgeInviteTargets(contacts);
    if (inviteTargets.length > 0) {
      try {
        for (const sessionId of groupSessionIds) {
          const inviteContext = canonicalGroupInviteContextForSession(
            nextState,
            sessionId,
            fallbackGroupSpaceId,
          );
          const inviteText = buildChatCreateGroupInviteText(inviteContext.parentSessionTitle);
          for (const target of inviteTargets) {
            const inviteState = await createDesktopBridgeOutreach({
              hostId: target.hostId,
              targetNodeId: target.nodeId,
              targetKind: 'bridge-person',
              requestText: inviteText,
              targetDisplayName: target.displayName,
              targetOwnerName: target.ownerName,
              targetRuntime: 'person',
              targetHumanId: target.humanId,
              targetAgentId: null,
              triggerText: null,
              contextText: null,
              contextPolicy: CHAT_GROUP_INVITE_CONTEXT_POLICY,
              parentSessionId: sessionId,
              parentSessionTitle: inviteContext.parentSessionTitle,
              parentSessionKind: 'group',
              parentGroupSpaceId: inviteContext.parentGroupSpaceId,
              parentSessionParticipants: inviteContext.parentSessionParticipants,
              parentSessionMessages: inviteContext.parentSessionMessages,
              parentTurnId: null,
              parentMessageId: null,
              projectId: null,
              projectName: null,
            });
            setDesktopBridgeState((current) => mergeDesktopBridgeState(current, inviteState));
          }
        }
      } catch (error) {
        setDesktopChatError(`Group members added, but Bridge invites failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [
    canonicalSessionState,
    isNativeShell,
    peopleContactById,
    setDesktopBridgeState,
    setDesktopChatError,
  ]);

  const handleRemoveChatGroupMember = useCallback(async (sessionIds: string[], identityId: string) => {
    if (!isNativeShell) return;
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
    setDesktopChatError(null);
    const actorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!actorIdentityId) throw new Error('Local profile identity is not ready yet.');
    const fallbackGroupSpaceId = groupSessionIds[0];
    let nextState = canonicalSessionState;
    for (const sessionId of groupSessionIds) {
      nextState = await removeCanonicalSessionParticipant({ sessionId, identityId, removedByIdentityId: actorIdentityId });
      const currentMetadata = sessionMetadataRecord(nextState, sessionId);
      const adminIds = adminIdentityIdsFromMetadata(currentMetadata).filter((adminId) => adminId !== identityId);
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: actorIdentityId,
        metadata: {
          ...currentMetadata,
          groupId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          groupSpaceId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          adminIdentityIds: adminIds.length > 0 ? adminIds : activeGroupAdminIds(nextState, sessionId),
        },
      });
    }
    setCanonicalSessionState(nextState);
  }, [canonicalSessionState, isNativeShell, setDesktopChatError]);

  const handleSetChatGroupAdmin = useCallback(async (sessionIds: string[], identityId: string, isAdmin: boolean) => {
    if (!isNativeShell) return;
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
    setDesktopChatError(null);
    const actorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!actorIdentityId) throw new Error('Local profile identity is not ready yet.');
    const fallbackGroupSpaceId = groupSessionIds[0];
    let nextState = canonicalSessionState;
    for (const sessionId of groupSessionIds) {
      nextState = await setCanonicalSessionParticipantRole({
        sessionId,
        identityId,
        role: isAdmin ? 'admin' : 'person',
        requestedByIdentityId: actorIdentityId,
      });
      const currentMetadata = sessionMetadataRecord(nextState, sessionId);
      const adminIds = uniqueStrings([
        ...adminIdentityIdsFromMetadata(currentMetadata),
        ...activeGroupAdminIds(nextState, sessionId),
      ]);
      const nextAdminIds = isAdmin
        ? uniqueStrings([...adminIds, identityId])
        : adminIds.filter((adminId) => adminId !== identityId);
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: actorIdentityId,
        metadata: {
          ...currentMetadata,
          groupId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          groupSpaceId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          adminIdentityIds: nextAdminIds.length > 0 ? nextAdminIds : activeGroupAdminIds(nextState, sessionId),
        },
      });
    }
    setCanonicalSessionState(nextState);
  }, [canonicalSessionState, isNativeShell, setDesktopChatError]);

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
    desktopChatState,
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
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    handleCreateChatSession,
    handleSelectChatSession,
    handleStartChatWithPerson,
    handleStartChatWithAgent,
    handleCreateChatGroup,
    handleCreateChatSessionInParticipantSpace,
    handleRenameChatGroup,
    handleAddChatGroupMembers,
    handleRemoveChatGroupMember,
    handleSetChatGroupAdmin,
    handleArchiveChatSession,
    handleDeleteChatSession,
    handleMoveChatSessionToProject,
    handleCreateProjectFromFolder,
    handleCreateProject,
    handleCreateProjectSession,
    chatSearch: chatsUi.chatSearch,
    setChatSearch: chatsUi.setChatSearch,
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
    handleStartBridgePersonSession,
    handleSetBridgeDiscoveryMode,
    handleSetDefaultBridgeAgent,
    handleUpdateBridgeAgentModelRouting,
    handleUpdateLocalAgentModelRouting,
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
    saveDesktopAttachmentPaths,
    removeChatComposerAttachment,
    projectComposerText: composerDraftsView.project,
    chatComposerText: composerDraftsView.chat,
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
    handleStopBridgeAgentRequest,
    handleSendProjectMessage: wrappedSendProjectMessage,
    handleSendChatMessage: wrappedSendChatMessage,
    showChatDetailRail,
    activeDetailTab,
    setActiveDetailTab,
    activeProjectLastMessage,
    isProjectBridgeBusy,
    bridgeInvite,
    handleCreateProjectBridgeInvite,
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
