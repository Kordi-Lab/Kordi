import { useCallback, useEffect, useRef, useState } from 'react';

import { isCloudCollaborationConversationId } from '@/features/cloud/cloudCollaborationState';
import { isCloudGroupAgentConversationId } from '@/features/cloud/cloudGroupMessages';
import type { CollaborationAgentRequestControl, ComposerScope } from '@/kordi-app/types';
import type { ComposerMentionOption } from '@/kordi-app/components';
import { cancelDesktopChatTurn } from '@/lib/desktop';

import { CHAT_COMPOSER_TEXTAREA_SELECTOR, resizeComposerTextarea } from './composerController.shared';
import type { UseComposerControllerArgs } from './composerController.types';
import { updateScopeDraft, type ComposerDraftState } from './composerDrafts';
import {
  appendDesktopSystemMessageToState,
  insertMentionIntoDraft,
  runLocalSlashCommand,
  type LocalChatSendInFlight,
  type PendingCollaborationOutreach,
  useChatMessageActions,
  useProjectMessageActions,
} from './messageActions';


type UseComposerMessageActionsArgs = UseComposerControllerArgs & {
  derived: {
    attachmentSummaryText: (text: string, attachments?: UseComposerControllerArgs['draft']['chatComposerAttachments']) => string;
    selectComposerValue: (
      scope: ComposerScope,
      type: 'model',
      value: string,
    ) => Promise<void>;
    appendProjectDraft: (value: string) => void;
    appendChatDraft: (value: string) => void;
  };
};

export function useComposerMessageActions({
  environment,
  conversation,
  project,
  runtime,
  draft,
  authNavigation,
  messageRuntime,
  derived,
}: UseComposerMessageActionsArgs) {
  const { isNativeShell, hasAnyDesktopAuth } = environment;
  const {
    activeConversationUsesCollaboration,
    chatConversations,
    activeConvId,
    activeConvCanonicalSessionId,
    activeConvMessages,
    activeConvCollaborationTarget,
    activeConvSupportTicketEnabled,
    activeConvMentionScope,
    sharedCloudAgents,
    resolveSharedCloudAgentsForMention,
  } = conversation;
  const {
    activeProjectId,
    activeProjectSessionId,
    activeProjectRoot,
    selectProjectSession,
    setProjectWorkspaces,
  } = project;
  const {
    desktopChatState,
    desktopCollaborationState,
    canonicalSessionState,
    canonicalHumanIdentityId,
    setCanonicalSessionState,
    desktopLiveTurn,
    resolveChatRuntimeRoute,
  } = runtime;
  const {
    composerSelections,
    composerDrafts,
    setComposerDrafts,
    activeChatQuote,
    setOpenComposerSelector,
    chatComposerAttachments,
    setChatComposerAttachments,
    chatModelOptions,
  } = draft;
  const {
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
  } = authNavigation;
  const {
    setDesktopChatState,
    setDesktopChatError,
    isDesktopChatSending,
    setIsDesktopChatSending,
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
  } = messageRuntime;
  const {
    attachmentSummaryText,
    selectComposerValue,
    appendProjectDraft,
    appendChatDraft,
  } = derived;
  const [pendingCollaborationOutreach, setPendingCollaborationOutreach] = useState<PendingCollaborationOutreach | null>(null);
  const pendingCollaborationOutreachRef = useRef<PendingCollaborationOutreach | null>(null);
  const pendingCollaborationCancelRequestedRef = useRef(false);
  const collaborationSendInFlightConversationIdsRef = useRef(new Set<string>());
  const localChatSendInFlightRef = useRef<LocalChatSendInFlight | null>(null);
  const selectedChatAgentMentionRef = useRef<ComposerMentionOption | null>(null);
  const userCancelledTurnIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    pendingCollaborationOutreachRef.current = pendingCollaborationOutreach;
  }, [pendingCollaborationOutreach]);

  useEffect(() => {
    selectedChatAgentMentionRef.current = null;
  }, [activeConvId]);

  useEffect(() => {
    if (!pendingCollaborationOutreach) return;
    const conversation = desktopCollaborationState?.conversations.find((candidate) => candidate.id === pendingCollaborationOutreach.conversationId);
    const status = conversation?.outreach?.status?.trim().toLowerCase();
    if (status && ['completed', 'complete', 'failed', 'cancelled', 'timeout'].includes(status)) {
      setPendingCollaborationOutreach(null);
      setIsDesktopChatSending(false);
    }
  }, [desktopCollaborationState?.conversations, pendingCollaborationOutreach, setIsDesktopChatSending]);

  const appendDesktopSystemMessage = useCallback((text: string) => {
    appendDesktopSystemMessageToState({ setDesktopChatState }, text);
  }, [setDesktopChatState]);

  const handleLocalSlashCommand = useCallback((rawText: string, scope: ComposerScope = 'chat') => runLocalSlashCommand({
    rawText,
    scope,
    activeConvId,
    activeConvMessages,
    appendDesktopSystemMessage,
    chatModelOptions,
    desktopChatState,
    handleCreateChatSession,
    handleRenameDesktopSession,
    refreshDesktopAuth,
    refreshDesktopChat,
    selectComposerValue,
    setActiveDetailTab,
    setActiveNav,
    setActiveSettingsSectionId,
    setDesktopSessionRenameDraft,
    setIsDetailPanelCollapsed,
    setIsEditingDesktopSessionTitle,
    setOpenComposerSelector,
  }), [
    activeConvId,
    activeConvMessages,
    appendDesktopSystemMessage,
    chatModelOptions,
    desktopChatState,
    handleCreateChatSession,
    handleRenameDesktopSession,
    refreshDesktopAuth,
    refreshDesktopChat,
    selectComposerValue,
    setActiveDetailTab,
    setActiveNav,
    setActiveSettingsSectionId,
    setDesktopSessionRenameDraft,
    setIsDetailPanelCollapsed,
    setIsEditingDesktopSessionTitle,
    setOpenComposerSelector,
  ]);

  const { handleSendChatMessage, handleRetryChatMessage } = useChatMessageActions({
    activeConversationUsesCollaboration,
    activeConvCollaborationTarget,
    activeConvSupportTicketEnabled,
    activeConvCanonicalSessionId,
    activeConvId,
    activeConvMessages,
    activeConvMentionScope,
    sharedCloudAgents,
    resolveSharedCloudAgentsForMention,
    chatConversations,
    attachmentSummaryText,
    canonicalSessionState,
    hasAnyDesktopAuth,
    canonicalHumanIdentityId,
    chatComposerAttachments,
    composerSelections,
    composerDrafts,
    activeChatQuote,
    desktopCollaborationState,
    desktopChatState,
    desktopLiveTurn,
    resolveChatRuntimeRoute,
    handleLocalSlashCommand,
    isDesktopChatSending,
    isNativeShell,
    pendingCollaborationCancelRequestedRef,
    collaborationSendInFlightConversationIdsRef,
    localChatSendInFlightRef,
    selectedChatAgentMentionRef,
    userCancelledTurnIdsRef,
    refreshDesktopChat,
    setActiveConvId,
    setCanonicalSessionState,
    setChatComposerAttachments,
    setComposerDrafts,
    setCloudCollaborationState,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
    publishCloudAgentRuntimeRouteChange,
    setDesktopChatError,
    setDesktopChatState,
    setDesktopLiveTurnsBySession,
    setIsDesktopChatSending,
    setOpenComposerSelector,
    setPendingCollaborationOutreach,
    setPendingUserChatMessage,
    queuedDesktopMessagesBySession,
    setQueuedDesktopMessagesBySession,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
  });

  const handleSendProjectMessage = useProjectMessageActions({
    activeConvMessages,
    activeProjectId,
    activeProjectSessionId,
    activeProjectRoot,
    selectProjectSession,
    appendProjectDraft,
    attachmentSummaryText,
    canonicalHumanIdentityId,
    chatComposerAttachments,
    composerDrafts,
    desktopCollaborationState,
    desktopChatState,
    desktopLiveTurn,
    isNativeShell,
    setCanonicalSessionState,
    setChatComposerAttachments,
    setDesktopChatError,
    setDesktopChatState,
    setIsDesktopChatSending,
    setProjectWorkspaces,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
  });

  const acceptChatMentionTarget = useCallback((label: string, option?: ComposerMentionOption) => {
    if (option?.targetKind === 'agent') selectedChatAgentMentionRef.current = option;
    setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(
      current,
      'chat',
      activeConvId,
      insertMentionIntoDraft(composerDrafts.chat, label),
    ));
    resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR, insertMentionIntoDraft(composerDrafts.chat, label));
  }, [activeConvId, composerDrafts.chat, setComposerDrafts]);

  const acceptProjectMentionTarget = useCallback((label: string) => {
    setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(
      current,
      'project',
      activeProjectSessionId ?? '',
      insertMentionIntoDraft(composerDrafts.project, label),
    ));
    resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]', insertMentionIntoDraft(composerDrafts.project, label));
  }, [activeProjectSessionId, composerDrafts.project, setComposerDrafts]);

  const stopCollaborationOutreach = useCallback(async (conversationId: string, requestId?: string | null) => {
    setDesktopChatError(null);
    const pendingOutreach = pendingCollaborationOutreachRef.current;
    if (pendingOutreach?.conversationId === conversationId && pendingOutreach.requestId === requestId) {
      setPendingCollaborationOutreach(null);
      setIsDesktopChatSending(false);
    }
    try {
      if (isCloudCollaborationConversationId(conversationId) || isCloudGroupAgentConversationId(conversationId)) {
        if (!requestId?.trim()) throw new Error('Unable to stop request');
        if (!cancelCloudAgentRequest) throw new Error('Chat is still loading. Try again in a moment.');
        await cancelCloudAgentRequest(conversationId, requestId);
        return;
      }
      throw new Error('This chat is unavailable. Try again from the chat list.');
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to stop request');
      throw error;
    }
  }, [cancelCloudAgentRequest, setDesktopChatError, setIsDesktopChatSending, setPendingCollaborationOutreach]);

  const handleStopCollaborationAgentRequest = useCallback(async (request: CollaborationAgentRequestControl) => {
    await stopCollaborationOutreach(request.conversationId, request.requestId);
  }, [stopCollaborationOutreach]);

  const handleStopDesktopChatTurn = useCallback(async () => {
    const pendingOutreach = pendingCollaborationOutreachRef.current;
    if (pendingOutreach) {
      try {
        await stopCollaborationOutreach(pendingOutreach.conversationId, pendingOutreach.requestId);
      } catch {
        // stopCollaborationOutreach already surfaced the error in chat state.
      }
      return;
    }

    if (!desktopLiveTurn || desktopLiveTurn.completed) {
      if (isDesktopChatSending) {
        pendingCollaborationCancelRequestedRef.current = true;
        localChatSendInFlightRef.current = null;
        setIsDesktopChatSending(false);
      }
      return;
    }

    const stoppedSessionId = desktopLiveTurn.sessionId;
    const stoppedTurnId = desktopLiveTurn.id;
    userCancelledTurnIdsRef.current.add(stoppedTurnId);
    setDesktopChatError(null);
    localChatSendInFlightRef.current = null;
    setIsDesktopChatSending(false);
    setDesktopLiveTurnsBySession((current) => {
      if (!current[stoppedSessionId]) return current;
      const { [stoppedSessionId]: _removed, ...rest } = current;
      return rest;
    });

    try {
      await cancelDesktopChatTurn(stoppedTurnId);
      void refreshDesktopChat(stoppedSessionId).catch(() => {});
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to stop chat turn');
    }
  }, [desktopLiveTurn, isDesktopChatSending, refreshDesktopChat, setDesktopChatError, setDesktopLiveTurnsBySession, setIsDesktopChatSending, stopCollaborationOutreach]);

  return {
    handleSendChatMessage,
    handleRetryChatMessage,
    handleSendProjectMessage,
    handleStopDesktopChatTurn,
    handleStopCollaborationAgentRequest,
    acceptChatSlashCommand: appendChatDraft,
    acceptProjectSlashCommand: appendProjectDraft,
    acceptChatMentionTarget,
    acceptProjectMentionTarget,
  };
}
