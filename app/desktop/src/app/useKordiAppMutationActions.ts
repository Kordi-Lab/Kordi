import { useCallback, useMemo } from 'react';

import type { KordiAppFoundation } from '@/app/useKordiAppFoundation';
import type { KordiAppRuntimeActions } from '@/app/useKordiAppRuntimeActions';
import { useKordiChatSessionActions } from '@/app/useKordiChatSessionActions';
import { useKordiChatStartActions } from '@/app/useKordiChatStartActions';
import { useKordiGroupCreation } from '@/app/useKordiGroupCreation';
import { useKordiGroupMemberInvites } from '@/app/useKordiGroupMemberInvites';
import { useKordiGroupMemberRoles } from '@/app/useKordiGroupMemberRoles';
import { useKordiGroupRename } from '@/app/useKordiGroupRename';
import { useKordiParticipantDraftSend } from '@/app/useKordiParticipantDraftSend';
import { useKordiParticipantSpaceContinuation } from '@/app/useKordiParticipantSpaceContinuation';
import { useKordiProjectActions } from '@/app/useKordiProjectActions';
import type { KordiWorkspaceState } from '@/app/useKordiWorkspaceState';
import { buildChatCreatePeopleContactLookup } from '@/features/chat/chatCreateFlows';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { sendChatMessageWithImmediateQuoteClear } from '@/features/chat/composerQuoteClear';
import { authStateSatisfiesStartupGate } from '@/kordi-app/auth/model';
import type { ComposerQuoteState } from '@/kordi-app/types';
import type { DesktopChatContextMessage } from '@/lib/desktop';

export function useKordiAppMutationActions({
  foundation,
  workspace,
  runtime,
}: {
  foundation: KordiAppFoundation;
  workspace: KordiWorkspaceState;
  runtime: KordiAppRuntimeActions;
}) {
  const {
    environment: {
      isNativeShell,
      cloudSession,
    },
    canonical: {
      canonicalSessionState,
      setCanonicalSessionState,
      refreshCanonicalState,
    },
    participants: {
      setLocallyHiddenSessionIds,
      pendingParticipantSpaceCreateRef,
      participantSpaceDraftByKeyRef,
      participantSpaceDraftBySessionIdRef,
      participantSpaceDraftMaterializeRef,
      setParticipantSpaceDrafts,
    },
    ui: {
      projectsUi,
      composerUi,
    },
    auth: {
      desktopAuthState,
    },
    authNavigation: {
      openCloudAccountAuthentication,
    },
    chat: {
      desktopChatState,
      setDesktopChatState,
      setDesktopChatError,
      refreshDesktopChat,
    },
    navigation: {
      activeConvId,
      setActiveConvId,
      setActiveNav,
      selectProject,
      selectProjectSession,
    },
    composer: {
      activeChatQuote,
      onClearChatQuote,
      composerDraftsView,
    },
    cloud: {
      sendCloudGroupControl,
      hideCloudSession,
      unhideCloudSession,
      setCloudSessionPinned,
      setCloudSessionMuted,
      setCloudSessionUnread,
      markCloudSessionsRead,
      setCloudGroupSpacePinned,
      setCloudGroupSpaceMuted,
      setCloudGroupSpaceArchived,
      deleteCloudSession,
    },
  } = foundation;
  const {
    conversations: {
      chatConversations,
    },
    directory: {
      displayedContacts,
    },
    projects: {
      activeProject,
    },
  } = workspace;

  const {
    renameSession: handleRenameChatSession,
    archiveSession: handleArchiveChatSession,
    restoreSession: handleRestoreChatSession,
    setSessionPinned: handleSetChatSessionPinned,
    setSessionMuted: handleSetChatSessionMuted,
    setSessionUnread: handleSetChatSessionUnread,
    markSessionsRead: handleMarkChatSessionsRead,
    setGroupPinned: handleSetChatGroupPinned,
    setGroupMuted: handleSetChatGroupMuted,
    setGroupArchived: handleSetChatGroupArchived,
    deleteSession: handleDeleteChatSession,
  } = useKordiChatSessionActions({
    account: cloudSession.account,
    activeConversationId: activeConvId,
    canonicalState: canonicalSessionState,
    desktopState: desktopChatState,
    isNativeShell,
    deleteCloudSession,
    hideCloudSession,
    unhideCloudSession,
    setCloudSessionPinned,
    setCloudSessionMuted,
    setCloudSessionUnread,
    markCloudSessionsRead,
    setCloudGroupSpacePinned,
    setCloudGroupSpaceMuted,
    setCloudGroupSpaceArchived,
    refreshCanonicalState,
    refreshDesktopChat,
    sendCloudGroupControl,
    setActiveConversationId: setActiveConvId,
    setCanonicalState: setCanonicalSessionState,
    setComposerDrafts: composerUi.setComposerDrafts,
    setDesktopError: setDesktopChatError,
    setDesktopState: setDesktopChatState,
    setLocallyHiddenSessionIds,
  });

  const {
    moveSessionToProject: handleMoveChatSessionToProject,
    createProjectFromFolder: handleCreateProjectFromFolder,
    createProject: handleCreateProject,
    createProjectSession: handleCreateProjectSession,
  } = useKordiProjectActions({
    activeProject,
    desktopState: desktopChatState,
    isNativeShell,
    refreshCanonicalState,
    refreshDesktopChat,
    selectProject,
    selectProjectSession,
    setActiveNav,
    setComposerAttachments: composerUi.setChatComposerAttachments,
    setComposerDrafts: composerUi.setComposerDrafts,
    setDesktopError: setDesktopChatError,
    setDesktopState: setDesktopChatState,
    setExpandedProjectIds: projectsUi.setExpandedProjectIds,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
  });

  const peopleContactById = useMemo(
    () => buildChatCreatePeopleContactLookup(displayedContacts),
    [displayedContacts],
  );

  const {
    selectNewSession: selectNewChatSession,
    startChatWithPerson: handleStartChatWithPerson,
    startChatWithAgent: handleStartChatWithAgent,
  } = useKordiChatStartActions({
    canonicalState: canonicalSessionState,
    cloudAccountId: cloudSession.account?.accountId,
    conversations: chatConversations,
    isNativeShell,
    hasAgentProvider: authStateSatisfiesStartupGate(desktopAuthState),
    createOwnedAgentSession: runtime.sessions.handleCreateChatSession,
    openAgentAuthentication: openCloudAccountAuthentication,
    startCollaborationPersonSession:
      runtime.collaboration.handleStartCollaborationPersonSession,
    setActiveConversationId: setActiveConvId,
    setActiveNav,
    setCanonicalState: setCanonicalSessionState,
    setComposerAttachments: composerUi.setChatComposerAttachments,
    setComposerDrafts: composerUi.setComposerDrafts,
    setDesktopError: setDesktopChatError,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
  });

  const handleCreateChatGroup = useKordiGroupCreation({
    account: cloudSession.account,
    canonicalState: canonicalSessionState,
    contactById: peopleContactById,
    isNativeShell,
    sendCloudGroupControl,
    selectNewSession: selectNewChatSession,
    setCanonicalState: setCanonicalSessionState,
    setDesktopError: setDesktopChatError,
  });

  const handleCreateChatSessionInParticipantSpace =
    useKordiParticipantSpaceContinuation({
      canonicalState: canonicalSessionState,
      createOwnedAgentSession: runtime.sessions.handleCreateChatSession,
      draftByKeyRef: participantSpaceDraftByKeyRef,
      draftBySessionIdRef: participantSpaceDraftBySessionIdRef,
      isNativeShell,
      pendingCreateRef: pendingParticipantSpaceCreateRef,
      selectNewSession: selectNewChatSession,
      setActiveConversationId: setActiveConvId,
      setActiveNav,
      setCanonicalState: setCanonicalSessionState,
      setDesktopError: setDesktopChatError,
      setDrafts: setParticipantSpaceDrafts,
    });

  const handleRenameChatGroup = useKordiGroupRename({
    account: cloudSession.account,
    canonicalState: canonicalSessionState,
    isNativeShell,
    sendCloudGroupControl,
    setCanonicalState: setCanonicalSessionState,
    setDesktopError: setDesktopChatError,
  });

  const handleAddChatGroupMembers = useKordiGroupMemberInvites({
    account: cloudSession.account,
    canonicalState: canonicalSessionState,
    contactById: peopleContactById,
    isNativeShell,
    sendCloudGroupControl,
    setCanonicalState: setCanonicalSessionState,
    setDesktopError: setDesktopChatError,
  });

  const {
    removeGroupMember: handleRemoveChatGroupMember,
    setGroupAdmin: handleSetChatGroupAdmin,
  } = useKordiGroupMemberRoles({
    account: cloudSession.account,
    canonicalState: canonicalSessionState,
    isNativeShell,
    sendCloudGroupControl,
    setCanonicalState: setCanonicalSessionState,
    setDesktopError: setDesktopChatError,
  });

  const handleSendChatMessageAfterMaterializingDraft =
    useKordiParticipantDraftSend({
      activeConversationId: activeConvId,
      attachmentCount: composerUi.chatComposerAttachments.length,
      canonicalState: canonicalSessionState,
      currentDraft: composerDraftsView.chat,
      draftByKeyRef: participantSpaceDraftByKeyRef,
      draftBySessionIdRef: participantSpaceDraftBySessionIdRef,
      materializeRef: participantSpaceDraftMaterializeRef,
      sendMessage: runtime.composer.handleSendChatMessage,
      setCanonicalState: setCanonicalSessionState,
      setDesktopError: setDesktopChatError,
      setDrafts: setParticipantSpaceDrafts,
    });

  const handleSendChatMessageWithQuoteClear = useCallback((
    draftOverride?: string,
    targetSessionId?: string,
    contextMessages?: DesktopChatContextMessage[],
    attachmentOverride?: AttachmentItem[],
    quoteOverride?: ComposerQuoteState | null,
  ) => quoteOverride ? runtime.composer.handleSendChatMessage(
    draftOverride,
    targetSessionId,
    contextMessages,
    attachmentOverride,
    quoteOverride,
  ) : sendChatMessageWithImmediateQuoteClear({
    draftOverride,
    targetSessionId,
    contextMessages,
    attachmentOverride,
    currentDraft: composerDraftsView.chat,
    attachmentCount: composerUi.chatComposerAttachments.length,
    activeChatQuote,
    send: handleSendChatMessageAfterMaterializingDraft,
    clearQuote: onClearChatQuote,
  }), [
    activeChatQuote,
    composerDraftsView.chat,
    composerUi.chatComposerAttachments.length,
    handleSendChatMessageAfterMaterializingDraft,
    onClearChatQuote,
    runtime.composer,
  ]);

  return {
    composer: {
      handleSendChatMessageWithQuoteClear,
    },
    chatSession: {
      handleRenameChatSession,
      handleArchiveChatSession,
      handleRestoreChatSession,
      handleSetChatSessionPinned,
      handleSetChatSessionMuted,
      handleSetChatSessionUnread,
      handleMarkChatSessionsRead,
      handleSetChatGroupPinned,
      handleSetChatGroupMuted,
      handleSetChatGroupArchived,
      handleDeleteChatSession,
    },
    project: {
      handleMoveChatSessionToProject,
      handleCreateProjectFromFolder,
      handleCreateProject,
      handleCreateProjectSession,
    },
    starts: {
      handleStartChatWithPerson,
      handleStartChatWithAgent,
    },
    groups: {
      handleCreateChatGroup,
      handleCreateChatSessionInParticipantSpace,
      handleRenameChatGroup,
      handleAddChatGroupMembers,
      handleRemoveChatGroupMember,
      handleSetChatGroupAdmin,
    },
  };
}

export type KordiAppMutationActions =
  ReturnType<typeof useKordiAppMutationActions>;
