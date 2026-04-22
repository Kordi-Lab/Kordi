import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  contactRequests,
  projects,
  settingsSections,
} from '@/kordi-app/data';
import { AppShellFrame } from '@/app/AppShellFrame';
import { assembleKordiShellSlots } from '@/app/assembleKordiShellSlots';
import { useAppLayoutState } from '@/app/useAppLayoutState';
import { useKordiLocalUiState } from '@/app/useKordiLocalUiState';
import { useKordiShellArgs } from '@/app/useKordiShellArgs';
import { useKordiShellViewModel } from '@/app/useKordiShellViewModel';
import { useKordiUiEffects } from '@/app/useKordiUiEffects';
import { useWorkspaceViewModels } from '@/app/useWorkspaceViewModels';
import { useWorkspaceController } from '@/app/useWorkspaceController';
import { useDesktopAuthState } from '@/features/auth/useDesktopAuthState';
import { useDesktopAuthUiState } from '@/features/auth/useDesktopAuthUiState';
import { useDesktopChatState } from '@/features/chat/useDesktopChatState';
import { useComposerController } from '@/features/chat/useComposerController';
import { useComposerViewModel } from '@/features/chat/useComposerViewModel';
import { useDesktopSessionController } from '@/features/chat/useDesktopSessionController';
import { useDesktopTranscriptAdapter } from '@/features/chat/useDesktopTranscriptAdapter';
import { useBridgeOrchestration } from '@/features/bridge/useBridgeOrchestration';
import { useBridgeState } from '@/features/bridge/useBridgeState';
import { useProjectSettingsState } from '@/features/projects/useProjectSettingsState';

function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in (window as Window & Record<string, unknown>);
}

export default function KordiApp() {
  const isNativeShell = isNativeDesktopShell();
  const composerControlsRef = useRef<HTMLDivElement | null>(null);
  const chatAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const chatTranscriptScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoFollowChatRef = useRef(true);

  const {
    contactsUi: {
      activeContactGroup,
      setActiveContactGroup,
      activeContactId,
      setActiveContactId,
      isContactRequestsOpen,
      setIsContactRequestsOpen,
      activeContactRequestId,
      setActiveContactRequestId,
      contactOverlayMode,
      setContactOverlayMode,
      contactSearch,
      setContactSearch,
      expandedContactGroups,
      setExpandedContactGroups,
    },
    agentsUi: {
      activeAgentId,
      setActiveAgentId,
      isAgentOverlayOpen,
      setIsAgentOverlayOpen,
    },
    projectsUi: {
      projectWorkspaces,
      setProjectWorkspaces,
      projectSearch,
      setProjectSearch,
      expandedProjectIds,
      setExpandedProjectIds,
    },
    settingsUi: {
      activeSettingsSectionId,
      setActiveSettingsSectionId,
      activeSourcePreview,
      setActiveSourcePreview,
      themeMode,
      setThemeMode,
    },
    sessionUi: {
      desktopSessionRenameDraft,
      setDesktopSessionRenameDraft,
      isEditingDesktopSessionTitle,
      setIsEditingDesktopSessionTitle,
    },
    composerUi: {
      composerSelections,
      setComposerSelections,
      composerDrafts,
      setComposerDrafts,
      openComposerSelector,
      setOpenComposerSelector,
      chatSlashMenuIndex,
      setChatSlashMenuIndex,
      chatComposerAttachments,
      setChatComposerAttachments,
    },
    chatsUi: {
      chatFilter,
      setChatFilter,
      chatSearch,
      setChatSearch,
    },
  } = useKordiLocalUiState();

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

  const { mapDesktopMessages } = useDesktopTranscriptAdapter();

  const {
    desktopChatState,
    setDesktopChatState,
    isDesktopChatLoading,
    desktopChatError,
    setDesktopChatError,
    isDesktopChatSending: isDesktopBridgeSending,
    setIsDesktopChatSending: setIsDesktopBridgeSending,
    desktopLiveTurnsBySession,
    pendingUserChatMessage,
    setPendingUserChatMessage,
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
    initialProjects: projects,
    desktopProjects: desktopChatState?.projects,
    isNativeShell,
  });

  const {
    inlineAuthDialog,
    openLoginFlow,
    handleCloseInlineAuthDialog,
    showAuthGate,
  } = useDesktopAuthUiState({
    isNativeShell,
    activeNav,
    activeSettingsSectionId,
    desktopAuthState,
    isDesktopAuthLoading,
    setActiveNav,
    setActiveSettingsSectionId,
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
    composerSelections,
    composerDrafts,
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
  } = useBridgeState({
    isNativeShell,
    activeNav,
    activeConvId,
    activeConversationIsBridge: isNativeShell && activeConvId.startsWith('bridge:'),
    composerChatText: composerDrafts.chat,
  });

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
    projectWorkspaces,
    projectSelectedSessionIds,
    activeConvId,
    activeProjectId,
    activeProjectSessionId,
    chatFilter,
    chatSearch,
    projectSearch,
    contactSearch,
    activeContactId,
    activeAgentId,
    cachedChatSessionMessages,
    cachedProjectSessionMessages,
    localSessionUnreadCounts,
    mapDesktopMessages,
  });

  const activeContactRequest = contactRequests.find((request) => request.id === activeContactRequestId) ?? contactRequests[0];
  const activeSettingsSection = settingsSections.find((section) => section.id === activeSettingsSectionId) ?? settingsSections[0];
  const activeProjectBridgeHost = activeBridgeHost;
  const activeChatLiveTurn = activeConvId.startsWith('bridge:') ? null : (desktopLiveTurnsBySession[activeConvId] ?? null);
  const activeProjectLiveTurn = activeProjectSessionId ? (desktopLiveTurnsBySession[activeProjectSessionId] ?? null) : null;
  const activeDesktopLiveTurn = activeNav === 'projects' ? activeProjectLiveTurn : activeChatLiveTurn;
  const isDesktopChatSending = activeNav === 'projects'
    ? Boolean(activeProjectLiveTurn && !activeProjectLiveTurn.completed)
    : activeNav === 'chats' && activeConvId.startsWith('bridge:')
      ? isDesktopBridgeSending
      : Boolean(activeChatLiveTurn && !activeChatLiveTurn.completed);
  const totalUnreadMessages = useMemo(
    () => chatConversations.reduce((sum, conversation) => sum + Math.max(0, conversation.unread ?? 0), 0),
    [chatConversations],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = totalUnreadMessages > 0 ? `(${totalUnreadMessages}) Kordi` : 'Kordi';
  }, [totalUnreadMessages]);

  useEffect(() => {
    const visibleLocalSessionId = activeNav === 'projects'
      ? (activeProjectSessionId || null)
      : activeNav === 'chats' && !activeConvId.startsWith('bridge:')
        ? activeConvId
        : null;
    setVisibleLocalSessionId(visibleLocalSessionId);
  }, [activeConvId, activeNav, activeProjectSessionId, setVisibleLocalSessionId]);

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
    activeContactId,
    setActiveContactId,
    setActiveContactGroup,
    displayedAgents,
    activeAgentId,
    setActiveAgentId,
    setActiveSourcePreview,
    setOpenComposerSelector,
    setChatComposerAttachments,
    openComposerSelector,
    composerControlsRef,
    themeMode,
    activeConversationIsBridge,
    setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle,
    setComposerSelections,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
    activeConvMessagesLength: activeConv.messages.length,
    activeLastMessageTime: activeLastMessage?.time,
    activeProjectSessionIdValue: activeProjectSession.id,
    activeProjectSessionMessagesLength: activeProjectSession.messages.length,
    activeProjectLastMessageTime: activeProjectLastMessage?.time,
    pendingUserChatMessageText: pendingUserChatMessage?.text,
    desktopLiveTurn: activeDesktopLiveTurn,
    setChatSlashMenuIndex,
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
    setActiveSettingsSectionId('projects');
  }, []);

  const {
    handleCreateProjectBridgeInvite,
    handleOpenBridgeConversation,
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
    desktopChatState,
    desktopSessionRenameDraft,
    selectProjectSession,
    refreshDesktopChat,
    shouldAutoFollowChatRef,
    setActiveConvId,
    setPendingUserChatMessage,
    setChatComposerAttachments,
    setDesktopBridgeState,
    setDesktopChatError,
    setDesktopChatState,
    setComposerDrafts,
    setOpenComposerSelector,
    setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle,
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
    handleSendChatMessage,
    handleSendProjectMessage,
    handleStopDesktopChatTurn,
  } = useComposerController({
    isNativeShell,
    activeConversationIsBridge,
    activeConvId: activeConv.id,
    activeConvMessages: activeConv.messages,
    activeProjectId,
    activeProjectSessionId,
    desktopChatState,
    desktopLiveTurn: activeDesktopLiveTurn,
    composerSelections,
    setComposerSelections,
    composerDrafts,
    setComposerDrafts,
    setProjectWorkspaces,
    setOpenComposerSelector,
    chatComposerAttachments,
    setChatComposerAttachments,
    chatModelOptions,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    handleSelectAuthChoice,
    refreshDesktopAuth,
    refreshDesktopChat,
    handleCreateChatSession,
    handleRenameDesktopSession,
    setActiveNav,
    setActiveSettingsSectionId,
    setActiveDetailTab,
    setIsDetailPanelCollapsed,
    setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle,
    setDesktopChatState,
    setDesktopChatError,
    setIsDesktopChatSending: setIsDesktopBridgeSending,
    setPendingUserChatMessage,
    setDesktopBridgeState,
    watchDesktopLiveTurn,
    shouldAutoFollowChatRef,
  });

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
    themeMode,
    lastBridgePollAt,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
    desktopChatState,
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
    activeConvId,
    activeProjectId,
    activeProjectSessionId,
    activeSettingsSectionId,
    isSingleWorkspacePage,
    collapseChatSessions,
    showSessionRail,
    sessionRailWidth,
    chatConversations,
    isDesktopChatLoading,
    desktopChatError,
    filteredConversations,
    setActiveNav,
    handleCreateChatSession,
    chatSearch,
    setChatSearch,
    chatFilter,
    setChatFilter,
    runtimeProjects,
    projectSearch,
    setProjectSearch,
    filteredProjects,
    projectSelectedSessionIds,
    selectProject,
    expandedProjectIds,
    setExpandedProjectIds,
    groupedContacts,
    displayedContacts,
    setActiveContactGroup,
    setActiveContactId,
    displayedAgents,
    activeBridgeHost,
    refreshDesktopBridge,
    handleCopyBridgeText,
    handleCreateBridgeDraft,
    handleSelectChatSession,
    handleSelectProjectSession,
    filteredGroupedContacts,
    isContactRequestsOpen,
    setIsContactRequestsOpen,
    contactRequests,
    activeContactRequestId,
    setActiveContactRequestId,
    setContactOverlayMode,
    contactOverlayMode,
    contactSearch,
    setContactSearch,
    expandedContactGroups,
    setExpandedContactGroups,
    activeContactId,
    activeContact,
    activeContactRequest,
    getStatusBadgeClass,
    handleOpenBridgeConversation,
    activeAgentId,
    setActiveAgentId,
    activeAgent,
    isAgentOverlayOpen,
    setIsAgentOverlayOpen,
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
    settingsRailWidth,
    settingsContentRef,
    setActiveSettingsSectionId,
    settingsSections,
    activeSettingsSection,
    authSettingsLayoutWidth,
    desktopAuthState,
    isDesktopAuthLoading,
    desktopAuthError,
    activeLoginProviderId,
    selectAuthProvider,
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
    themeMode,
    setThemeMode,
    showRightDetailRail,
    isDetailPanelCollapsed,
    setIsDetailPanelCollapsed,
    setIsSessionPanelCollapsed,
    activeProject,
    activeProjectSession,
    desktopSessionRenameDraft,
    setDesktopSessionRenameDraft,
    isEditingDesktopSessionTitle,
    setIsEditingDesktopSessionTitle,
    handleRenameDesktopSession,
    activeProjectBridgeHost,
    activeProjectBridgeProject,
    chatTranscriptScrollRef,
    onProjectTranscriptScroll,
    onChatTranscriptScroll,
    activeSourcePreview,
    setActiveSourcePreview,
    desktopLiveTurn: activeDesktopLiveTurn,
    filteredProjectSlashCommands,
    filteredChatSlashCommands,
    chatSlashMenuIndex,
    setChatSlashMenuIndex,
    acceptProjectSlashCommand,
    acceptChatSlashCommand,
    chatAttachmentInputRef,
    chatComposerAttachments,
    saveDesktopAttachments,
    removeChatComposerAttachment,
    projectComposerText: composerDrafts.project,
    chatComposerText: composerDrafts.chat,
    updateProjectComposerDraft: (value, target) => updateComposerDraft('project', value, target),
    updateChatComposerDraft: (value, target) => updateComposerDraft('chat', value, target),
    setProjectComposerText,
    setChatComposerText,
    composerControlsRef,
    activeRuntimeSessionId,
    activeRuntimeContextStatus,
    activeRuntimeCacheText,
    composerSelectionProject: composerSelections.project,
    composerSelectionChat: composerSelections.chat,
    openComposerSelector,
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
    showAuthGate,
    inlineAuthDialog,
    handleCloseInlineAuthDialog,
    startWindowResize,
  });

  const shellSlots = assembleKordiShellSlots(shellArgs);

  return (
    <AppShellFrame
      rootThemeClass={rootThemeClass}
      isNativeShell={isNativeShell}
      isLayoutResizing={isLayoutResizing}
      windowSize={windowSize}
      leftWorkspaceWidth={leftWorkspaceWidth}
      isSingleWorkspacePage={isSingleWorkspacePage}
      showSessionRail={showSessionRail}
      collapseChatSessions={collapseChatSessions}
      showRightDetailRail={showRightDetailRail}
      isDetailPanelCollapsed={isDetailPanelCollapsed}
      detailRailWidth={detailRailWidth}
      onSessionResizeMouseDown={startPanelResize('session')}
      onDetailResizeMouseDown={startPanelResize('detail')}
      sidebar={shellSlots.sidebar}
      mainContent={shellSlots.mainContent}
      rightDetailRail={shellSlots.rightDetailRail}
      authGate={shellSlots.authGate}
      inlineAuthDialog={shellSlots.inlineAuthDialog}
      windowResizeHandles={shellSlots.windowResizeHandles}
    />
  );
}
