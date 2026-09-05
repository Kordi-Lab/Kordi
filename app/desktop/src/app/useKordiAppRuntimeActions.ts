import type { KordiAppFoundation } from '@/app/useKordiAppFoundation';
import { useKordiCloudAgentFork } from '@/app/useKordiCloudAgentFork';
import { useKordiCollaborationNavigationActions } from '@/app/useKordiCollaborationNavigationActions';
import { useKordiProviderAutoSwitch } from '@/app/useKordiProviderAutoSwitch';
import { useKordiQueuedMessageActions } from '@/app/useKordiQueuedMessageActions';
import type { KordiWorkspaceState } from '@/app/useKordiWorkspaceState';
import { authStateHasChatReadyProvider } from '@/kordi-app/auth/model';
import { useComposerController } from '@/features/chat/useComposerController';
import { useDesktopSessionController } from '@/features/chat/useDesktopSessionController';

export function useKordiAppRuntimeActions({
  foundation,
  workspace,
}: {
  foundation: KordiAppFoundation;
  workspace: KordiWorkspaceState;
}) {
  const {
    environment: {
      isNativeShell,
      cloudSession,
    },
    refs: {
      shouldAutoFollowChatRef,
    },
    canonical: {
      canonicalSessionState,
      setCanonicalSessionState,
      hydrateCanonicalSessionPage,
    },
    ui: {
      projectsUi,
      settingsUi,
      sessionUi,
      composerUi,
    },
    auth: {
      desktopAuthState,
      activeLoginProviderId,
      refreshDesktopAuth,
      handleSelectAuthChoice,
    },
    chat: {
      desktopChatState,
      setDesktopChatState,
      setDesktopChatError,
      isDesktopCollaborationSending,
      setIsDesktopCollaborationSending,
      setDesktopLiveTurnsBySession,
      setPendingUserChatMessage,
      queuedDesktopMessagesBySession,
      setQueuedDesktopMessagesBySession,
      isDesktopSessionTranscriptCached,
      preloadDesktopSessionTranscript,
      refreshDesktopChat,
      watchDesktopLiveTurn,
    },
    navigation: {
      activeConvId,
      setActiveConvId,
      activeProjectId,
      activeProjectSessionId,
      setActiveNav,
      setActiveDetailTab,
      selectProjectSession,
    },
    composer: {
      chatDraftSessionId,
      activeChatQuote,
      composerDraftsView,
      chatModelOptions,
      preferredModelValueForProvider,
      resolveComposerProviderId,
    },
    layout: {
      setIsDetailPanelCollapsed,
    },
    cloud: {
      setCloudCollaborationState,
      desktopCollaborationState,
      sendCloudCollaborationMessage,
      sendCloudGroupControl,
      recordCloudSessionFork,
      cancelCloudAgentRequest,
      unsupportedLegacyCollaborationAction,
      resolveChatRuntimeRoute,
      inheritCloudAgentRuntimeRoute,
      publishCloudAgentRuntimeRouteChange,
    },
  } = foundation;
  const {
    conversations: {
      chatConversations,
      activeConv,
      activeConversationUsesCollaboration,
    },
    projects: {
      activeProject,
    },
    mentions: {
      activeConvMentionScope,
      mentionableCloudAgents,
      resolveSharedCloudAgentsForMention,
    },
    activity: {
      activeDesktopLiveTurn,
    },
  } = workspace;

  const {
    addContact: handleAddCollaborationContact,
    approveContactRequest: handleApproveCollaborationContactRequest,
    openConversation: handleOpenCollaborationConversation,
    rejectContactRequest: handleRejectCollaborationContactRequest,
    removeContact: handleRemoveCollaborationContact,
    startPersonSession: handleStartCollaborationPersonSession,
    updateAgentModelRoutingForActiveSession:
      handleUpdateCollaborationAgentModelRoutingForActiveSession,
    updateLocalAgentModelRouting: handleUpdateLocalAgentModelRouting,
  } = useKordiCollaborationNavigationActions({
    accountId: cloudSession.account?.accountId ?? null,
    activeConversation: activeConv,
    activeConversationId: activeConvId,
    setActiveConversationId: setActiveConvId,
    setActiveNav,
    setDesktopChatError,
    publishCloudAgentRuntimeRouteChange,
    unsupportedAction: unsupportedLegacyCollaborationAction,
  });

  const syncCloudAgentFork = useKordiCloudAgentFork({
    account: cloudSession.account,
    recordCloudSessionFork,
  });

  const {
    handlePrefetchChatSession,
    handleSelectChatSession,
    handleCreateChatSession,
    handleSelectProjectSession,
    handleRenameDesktopSession,
    handleForkChatMessage,
  } = useDesktopSessionController({
    isNativeShell,
    activeConversationUsesCollaboration,
    activeConvId,
    desktopChatState,
    desktopSessionRenameDraft: sessionUi.desktopSessionRenameDraft,
    selectProjectSession,
    refreshDesktopChat,
    hydrateCanonicalSessionPage,
    isDesktopSessionTranscriptCached,
    preloadDesktopSessionTranscript,
    shouldAutoFollowChatRef,
    setActiveConvId,
    setPendingUserChatMessage,
    setChatComposerAttachments: composerUi.setChatComposerAttachments,
    setDesktopChatError,
    setDesktopChatState,
    setComposerDrafts: composerUi.setComposerDrafts,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    onPrepareChatDraftSession: () => inheritCloudAgentRuntimeRoute(
      activeConv.canonicalSessionId || activeConvId,
      'draft:local-chat',
    ),
    onForkCreated: syncCloudAgentFork,
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
    updateChatComposerAttachment,
    setChatComposerText,
    setProjectComposerText,
    acceptChatSlashCommand,
    acceptProjectSlashCommand,
    acceptChatMentionTarget,
    handleSendChatMessage,
    handleRetryChatMessage,
    handleSendProjectMessage,
    handleStopDesktopChatTurn,
    handleStopCollaborationAgentRequest,
  } = useComposerController({
    environment: {
      isNativeShell,
      hasAnyDesktopAuth:
        authStateHasChatReadyProvider(desktopAuthState, chatModelOptions),
    },
    conversation: {
      activeConversationUsesCollaboration,
      chatConversations,
      // Keep the reader and writer on the same resolved draft key. The raw
      // active id can be empty before native session hydration.
      activeConvId: chatDraftSessionId,
      activeConvCanonicalSessionId: activeConv.canonicalSessionId,
      activeConvMessages: activeConv.messages,
      activeConvCollaborationTarget: activeConv.collaborationTarget,
      activeConvSupportTicketEnabled: activeConv.supportTicketEnabled,
      activeConvMentionScope,
      sharedCloudAgents: mentionableCloudAgents,
      resolveSharedCloudAgentsForMention,
    },
    project: {
      activeProjectId,
      activeProjectSessionId,
      activeProjectRoot: activeProject.root,
      selectProjectSession,
      setProjectWorkspaces: projectsUi.setProjectWorkspaces,
    },
    runtime: {
      desktopChatState,
      desktopCollaborationState,
      canonicalSessionState,
      canonicalHumanIdentityId: canonicalSessionState?.profile.humanIdentityId,
      setCanonicalSessionState,
      desktopLiveTurn: activeDesktopLiveTurn,
      resolveChatRuntimeRoute,
    },
    draft: {
      composerSelections: composerUi.composerSelections,
      setComposerSelections: composerUi.setComposerSelections,
      composerDrafts: composerDraftsView,
      setComposerDrafts: composerUi.setComposerDrafts,
      activeChatQuote,
      setOpenComposerSelector: composerUi.setOpenComposerSelector,
      chatComposerAttachments: composerUi.chatComposerAttachments,
      setChatComposerAttachments: composerUi.setChatComposerAttachments,
      chatModelOptions,
      preferredModelValueForProvider,
      resolveComposerProviderId,
    },
    authNavigation: {
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
    },
    messageRuntime: {
      setDesktopChatState,
      setDesktopChatError,
      isDesktopChatSending: isDesktopCollaborationSending,
      setIsDesktopChatSending: setIsDesktopCollaborationSending,
      setPendingUserChatMessage,
      queuedDesktopMessagesBySession,
      setQueuedDesktopMessagesBySession,
      setDesktopLiveTurnsBySession,
      setCloudCollaborationState,
      sendCloudCollaborationMessage,
      sendCloudGroupControl,
      publishCloudAgentRuntimeRouteChange,
      cancelCloudAgentRequest,
      watchDesktopLiveTurn,
      shouldAutoFollowChatRef,
      setActiveConvId,
    },
  });

  const {
    cancelQueuedMessage: handleCancelQueuedMessage,
    editQueuedMessage: handleEditQueuedMessage,
  } = useKordiQueuedMessageActions({
    isNativeShell,
    canonicalHumanIdentityId: canonicalSessionState?.profile.humanIdentityId,
    setCanonicalSessionState,
    onError: setDesktopChatError,
    queuedMessagesBySession: queuedDesktopMessagesBySession,
    setComposerDrafts: composerUi.setComposerDrafts,
    setQueuedMessagesBySession: setQueuedDesktopMessagesBySession,
  });

  useKordiProviderAutoSwitch({
    activeLoginProviderId,
    activeProjectSessionId,
    desktopAuthState,
    desktopChatState,
    isNativeShell,
    preferredModelValueForProvider,
    selectComposerValue,
  });

  const activeQueuedDesktopMessages =
    queuedDesktopMessagesBySession[activeConv.canonicalSessionId ?? activeConv.id]
    ?? queuedDesktopMessagesBySession[activeConv.id]
    ?? ('queuedMessages' in activeConv ? activeConv.queuedMessages : undefined)
    ?? [];

  return {
    collaboration: {
      handleAddCollaborationContact,
      handleApproveCollaborationContactRequest,
      handleOpenCollaborationConversation,
      handleRejectCollaborationContactRequest,
      handleRemoveCollaborationContact,
      handleStartCollaborationPersonSession,
      handleUpdateCollaborationAgentModelRoutingForActiveSession,
      handleUpdateLocalAgentModelRouting,
    },
    sessions: {
      handlePrefetchChatSession,
      handleSelectChatSession,
      handleCreateChatSession,
      handleSelectProjectSession,
      handleRenameDesktopSession,
      handleForkChatMessage,
    },
    composer: {
      toggleComposerSelector,
      selectComposerValue,
      selectComposerAuthChoice,
      selectComposerProviderChoice,
      updateComposerDraft,
      saveDesktopAttachments,
      saveDesktopAttachmentPaths,
      removeChatComposerAttachment,
      updateChatComposerAttachment,
      setChatComposerText,
      setProjectComposerText,
      acceptChatSlashCommand,
      acceptProjectSlashCommand,
      acceptChatMentionTarget,
      handleSendChatMessage,
      handleRetryChatMessage,
      handleSendProjectMessage,
      handleStopDesktopChatTurn,
      handleStopCollaborationAgentRequest,
    },
    queue: {
      activeQueuedDesktopMessages,
      handleCancelQueuedMessage,
      handleEditQueuedMessage,
    },
  };
}

export type KordiAppRuntimeActions =
  ReturnType<typeof useKordiAppRuntimeActions>;
