import { useCallback, useEffect, useMemo } from 'react';

import { participantSpaceCreateKey } from '@/app/useKordiAppModelHelpers';
import type { KordiAppFoundation } from '@/app/useKordiAppFoundation';
import { useKordiCollaborationMentions } from '@/app/useKordiCollaborationMentions';
import { useKordiDesktopActivity } from '@/app/useKordiDesktopActivity';
import { useKordiMessageActions } from '@/app/useKordiMessageActions';
import { useKordiUiEffects } from '@/app/useKordiUiEffects';
import { useWorkspaceViewModels } from '@/app/useWorkspaceViewModels';
import { collaborationContactRequestsForContactsPage } from '@/app/viewModels/helpers';
import { conversationWithHydratedSupportRoute } from '@/app/viewModels/conversationSelection';
import { existingBlankSessionIdForParticipantSpace } from '@/features/chat/chatCreateFlows';
import {
  navigateToTranscriptMessage,
  scrollTranscriptToBottom,
} from '@/features/chat/transcriptNavigation';
import {
  contactRequests as demoContactRequests,
} from '@/kordi-app/data';

export function useKordiWorkspaceState(foundation: KordiAppFoundation) {
  const {
    environment: {
      isNativeShell,
      cloudSession,
      cloudPresence,
    },
    refs: {
      composerControlsRef,
      chatTranscriptScrollRef,
      shouldAutoFollowChatRef,
      setChatTranscriptAtLatest,
      lastSeenArtifactByContextRef,
    },
    canonical: {
      canonicalStore,
      canonicalSessionState,
      setCanonicalSessionState,
    },
    participants: {
      locallyHiddenSessionIds,
      pendingParticipantSpaceCreateRef,
      participantSpaceDrafts,
    },
    ui: {
      contactsUi,
      agentsUi,
      projectsUi,
      settingsUi,
      sessionUi,
      composerUi,
    },
    auth: {
      desktopAuthState,
    },
    chat: {
      desktopChatState,
      isDesktopChatLoading,
      setDesktopChatError,
      isDesktopCollaborationSending,
      desktopLiveTurnsBySession,
      pendingUserChatMessage,
      cachedChatSessionMessages,
      cachedProjectSessionMessages,
      cachedDesktopSessionSourceMessages,
      hydratedDesktopSessionIds,
      localSessionUnreadCounts,
      setVisibleLocalSessionId,
      refreshDesktopChat,
      mapDesktopMessages,
    },
    navigation: {
      activeNav,
      setActiveNav,
      activeConvId,
      setActiveConvId,
      activeProjectId,
      activeProjectSessionId,
      projectSelectedSessionIds,
      setActiveDetailTab,
    },
    authNavigation: {
      visibleSettingsSections,
      visibleActiveSettingsSectionId,
    },
    composer: {
      chatDraftSessionId,
      composerDraftsView,
      chatSlashQuery,
      projectSlashQuery,
      filteredChatSlashCommands,
      filteredProjectSlashCommands,
    },
    layout: {
      isDetailPanelCollapsed,
    },
    cloud: {
      desktopCollaborationState,
      prepareCloudForwardAttachments,
      sendCloudCollaborationMessage,
      sendCloudGroupControl,
      setCloudMessageReaction,
      refreshSharedCloudAgents,
      sharedCloudAgents,
      cloudAgentDefinitionsById,
      cloudContacts,
      cloudSessionActivity,
      cloudHiddenSessionIds,
      cloudDeletedSessionIds,
      initialMessagesSettled,
      pendingGroupProjectionSessionIds,
      cloudLegacyGroupSessionTitlesById,
      cloudReliableGroupSessionTitleIds,
      cloudReliableGroupSessionActivityAtMs,
    },
  } = foundation;

  const combinedHiddenSessionIds = useMemo(() => new Set([
    ...locallyHiddenSessionIds,
    ...cloudHiddenSessionIds,
    ...cloudDeletedSessionIds,
  ]), [cloudDeletedSessionIds, cloudHiddenSessionIds, locallyHiddenSessionIds]);
  const transientChatConversations = useMemo(
    () => participantSpaceDrafts.map((draft) => draft.conversation),
    [participantSpaceDrafts],
  );

  const {
    chatConversations,
    companionConversations,
    filteredConversations,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    activeConv: selectedActiveConv,
    activeConversationUsesCollaboration,
    activeLastMessage,
    activeConvHasSubtitle,
    displayedContacts,
    addableContacts,
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
    activeCollaborationHost,
    activeCollaborationConversation,
    activeCollaborationConversationHost,
    activeCollaborationAwaitingReply,
  } = useWorkspaceViewModels({
    isNativeShell,
    isDesktopChatLoading,
    desktopChatState,
    localAgentDisplayName: foundation.profile.localAgentDisplayName,
    desktopCollaborationState,
    canonicalSessionState,
    canonicalSessionSummaries: canonicalStore.catalog?.summaries,
    canonicalHydrationBySessionId: canonicalStore.hydrationBySessionId,
    hiddenSessionIds: combinedHiddenSessionIds,
    projectWorkspaces: projectsUi.projectWorkspaces,
    projectSelectedSessionIds,
    activeNav,
    activeConvId,
    activeProjectId,
    activeProjectSessionId,
    chatSearch: foundation.ui.chatsUi.chatSearch,
    projectSearch: projectsUi.projectSearch,
    contactSearch: contactsUi.contactSearch,
    activeContactId: contactsUi.activeContactId,
    activeAgentId: agentsUi.activeAgentId,
    cachedChatSessionMessages,
    cachedProjectSessionMessages,
    cachedDesktopSessionSourceMessages,
    hydratedDesktopSessionIds,
    localSessionUnreadCounts,
    desktopLiveTurnsBySession,
    mapDesktopMessages,
    cloudSessionActivity,
    cloudAgentDefinitionsById,
    cloudPresence: cloudPresence.snapshot,
    cloudUnreadReady: initialMessagesSettled,
    pendingGroupProjectionSessionIds,
    cloudLegacyGroupSessionTitlesById,
    cloudReliableGroupSessionTitleIds,
    cloudReliableGroupSessionActivityAtMs,
    transientChatConversations,
  });
  const activeConv = useMemo(
    () => conversationWithHydratedSupportRoute(selectedActiveConv, cloudContacts),
    [cloudContacts, selectedActiveConv],
  );

  const {
    activeMessageSelection,
    selectedMessageIds,
    selectedMessageCount,
    onReplyMessage,
    onForwardMessage,
    onReactMessage,
    onSelectMessage,
    isMessageSelectable,
    onToggleSelectedMessage,
    onSelectionDragStart,
    onSelectionDragEnter,
    onSelectionDragEnd,
    onCancelMessageSelection,
    onSelectAllMessages,
    onCopySelectedMessages,
    onForwardSelectedMessages,
    messageForwardDialog,
  } = useKordiMessageActions({
    activeConversation: activeConv,
    conversations: chatConversations,
    draftSessionId: chatDraftSessionId,
    isNativeShell,
    transcriptScrollRef: chatTranscriptScrollRef,
    setActiveConversationId: setActiveConvId,
    setDesktopChatError,
    setChatQuoteBySessionId: composerUi.setChatQuoteBySessionId,
    canonicalState: canonicalSessionState,
    setCanonicalState: setCanonicalSessionState,
    account: cloudSession.account,
    collaborationState: desktopCollaborationState,
    cloudTransport: {
      prepareCloudForwardAttachments,
      sendCloudCollaborationMessage,
      sendCloudGroupControl,
      setCloudMessageReaction,
    },
  });

  const {
    activeConversationScope: activeConvMentionScope,
    filteredChatMentionTargets,
    filteredProjectMentionTargets,
    mentionableCloudAgents,
    resolveSharedCloudAgentsForMention,
  } = useKordiCollaborationMentions({
    account: cloudSession.account,
    activeConversation: activeConv,
    cloudAgentDefinitionsById,
    collaborationState: desktopCollaborationState,
    conversations: chatConversations,
    desktopChatState,
    drafts: composerDraftsView,
    isNativeShell,
    refreshSharedCloudAgents,
    sharedCloudAgents,
  });

  useEffect(() => {
    for (
      const [spaceKey, sessionId]
      of pendingParticipantSpaceCreateRef.current
    ) {
      const space = participantSpaces.find(
        (candidate) => participantSpaceCreateKey(candidate) === spaceKey,
      );
      const pendingSessionIsVisible = space?.sessions.some(
        (session) =>
          session.id === sessionId
          || session.canonicalSessionId === sessionId,
      );
      if (
        !space
        || existingBlankSessionIdForParticipantSpace(space)
        || pendingSessionIsVisible
      ) {
        pendingParticipantSpaceCreateRef.current.delete(spaceKey);
      }
    }
  }, [participantSpaces, pendingParticipantSpaceCreateRef]);

  const collaborationContactRequests = useMemo(
    () => collaborationContactRequestsForContactsPage(activeCollaborationHost),
    [activeCollaborationHost],
  );
  const contactRequests = isNativeShell
    ? collaborationContactRequests
    : demoContactRequests;

  const openNotificationSession = useCallback((sessionId: string, messageId: string) => {
    const conversation = chatConversations.find((candidate) => (
      candidate.id === sessionId
      || candidate.canonicalSessionId === sessionId
    ));
    setActiveNav('chats');
    setActiveConvId(conversation?.id ?? sessionId);
    const revealMessage = (attempt: number) => {
      if (navigateToTranscriptMessage(messageId, chatTranscriptScrollRef)) return;
      if (attempt < 8) {
        window.setTimeout(() => revealMessage(attempt + 1), 120);
      } else {
        scrollTranscriptToBottom(chatTranscriptScrollRef);
      }
    };
    window.setTimeout(() => revealMessage(0), 120);
  }, [chatConversations, chatTranscriptScrollRef, setActiveConvId, setActiveNav]);

  const {
    activeContactRequest,
    activeSettingsSection,
    activeDesktopLiveTurn,
    isDesktopChatSending,
    activeChatArtifacts,
    activeProjectArtifacts,
  } = useKordiDesktopActivity({
    activeContactRequestId: contactsUi.activeContactRequestId,
    activeSettingsSectionId: visibleActiveSettingsSectionId,
    settingsSections: visibleSettingsSections,
    contactRequests,
    activeNav,
    activeConvId,
    activeConv,
    activeProjectSessionId,
    activeProjectSession,
    activeConversationUsesCollaboration,
    isDesktopCollaborationSending,
    desktopLiveTurnsBySession,
    chatConversations,
    isNativeShell,
    attentionReady: initialMessagesSettled,
    chatTranscriptScrollRef,
    onOpenNotificationSession: openNotificationSession,
    setVisibleLocalSessionId,
    setActiveSourcePreview: settingsUi.setActiveSourcePreview,
    setActiveArtifactId: settingsUi.setActiveArtifactId,
    setActiveDetailTab,
    isDetailPanelCollapsed,
    lastSeenArtifactByContextRef,
    cloudSessionActivity,
  });

  const cloudAwareDisplayedContacts = cloudSession.account
    ? cloudContacts
    : displayedContacts;
  const activeTranscriptLastMessage = activeNav === 'projects'
    ? activeProjectLastMessage
    : activeLastMessage;

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
    displayedContacts: cloudAwareDisplayedContacts,
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
    themeMode: settingsUi.themeMode,
    resolvedThemeMode: settingsUi.resolvedThemeMode,
    activeConversationUsesCollaboration,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    setComposerSelections: composerUi.setComposerSelections,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
    setChatTranscriptAtLatest,
    activeConvMessagesLength: activeConv.messages.length,
    activeLastMessageTime: activeLastMessage?.time,
    activeTranscriptLastMessageIsOwn: Boolean(
      activeTranscriptLastMessage
      && (
        activeTranscriptLastMessage.isOwnMessage
        ?? activeTranscriptLastMessage.role === 'user'
      )
    ),
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
    if (normalized.includes('pending') || normalized.includes('approval')) {
      return 'app-badge-attention';
    }
    return 'app-badge-neutral';
  };

  return {
    conversations: {
      chatConversations,
      companionConversations,
      filteredConversations,
      participantSpaces,
      contactParticipantSpaces,
      agentParticipantSpaces,
      activeConv,
      activeConversationUsesCollaboration,
      activeLastMessage,
      activeConvHasSubtitle,
      activeCollaborationHost,
      activeCollaborationConversation,
      activeCollaborationConversationHost,
      activeCollaborationAwaitingReply,
    },
    directory: {
      displayedContacts,
      addableContacts,
      displayedAgents,
      groupedContacts,
      filteredGroupedContacts,
      activeContact,
      activeAgent,
      cloudAwareDisplayedContacts,
    },
    projects: {
      runtimeProjects,
      filteredProjects,
      activeProject,
      activeProjectSession,
      activeProjectLastMessage,
    },
    messages: {
      activeMessageSelection,
      selectedMessageIds,
      selectedMessageCount,
      onReplyMessage,
      onForwardMessage,
      onReactMessage,
      onSelectMessage,
      isMessageSelectable,
      onToggleSelectedMessage,
      onSelectionDragStart,
      onSelectionDragEnter,
      onSelectionDragEnd,
      onCancelMessageSelection,
      onSelectAllMessages,
      onCopySelectedMessages,
      onForwardSelectedMessages,
      messageForwardDialog,
    },
    mentions: {
      activeConvMentionScope,
      filteredChatMentionTargets,
      filteredProjectMentionTargets,
      mentionableCloudAgents,
      resolveSharedCloudAgentsForMention,
    },
    activity: {
      contactRequests,
      activeContactRequest,
      activeSettingsSection,
      activeDesktopLiveTurn,
      isDesktopChatSending,
      activeChatArtifacts,
      activeProjectArtifacts,
    },
    presentation: {
      getStatusBadgeClass,
    },
  };
}

export type KordiWorkspaceState = ReturnType<typeof useKordiWorkspaceState>;
