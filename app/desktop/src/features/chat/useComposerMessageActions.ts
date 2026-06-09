import { useCallback, useEffect, useRef, useState } from 'react';

import { isCloudBridgeConversationId } from '@/features/cloud/cloudBridgeState';
import { isCloudGroupAgentConversationId } from '@/features/cloud/cloudGroupMessages';
import type { BridgeAgentRequestControl, ComposerScope } from '@/kordi-app/types';
import { cancelDesktopChatTurn } from '@/lib/desktop';

import { CHAT_COMPOSER_TEXTAREA_SELECTOR, resizeComposerTextarea } from './composerController.shared';
import type { UseComposerControllerArgs } from './composerController.types';
import { updateScopeDraft, type ComposerDraftState } from './composerDrafts';
import {
  appendDesktopSystemMessageToState,
  insertMentionIntoDraft,
  runLocalSlashCommand,
  type LocalChatSendInFlight,
  type PendingBridgeOutreach,
  useChatMessageActions,
  useProjectMessageActions,
} from './messageActions';


type UseComposerMessageActionsArgs = Pick<
  UseComposerControllerArgs,
  | 'isNativeShell'
  | 'activeConversationIsBridge'
  | 'chatConversations'
  | 'activeConvId'
  | 'activeConvCanonicalSessionId'
  | 'activeConvMessages'
  | 'activeConvBridgeTarget'
  | 'activeConvMentionScope'
  | 'activeProjectId'
  | 'activeProjectSessionId'
  | 'activeProjectRoot'
  | 'selectProjectSession'
  | 'desktopChatState'
  | 'desktopBridgeState'
  | 'canonicalSessionState'
  | 'hasAnyDesktopAuth'
  | 'canonicalHumanIdentityId'
  | 'setCanonicalSessionState'
  | 'desktopLiveTurn'
  | 'composerSelections'
  | 'composerDrafts'
  | 'setComposerDrafts'
  | 'activeChatQuote'
  | 'setProjectWorkspaces'
  | 'setOpenComposerSelector'
  | 'chatComposerAttachments'
  | 'setChatComposerAttachments'
  | 'chatModelOptions'
  | 'refreshDesktopAuth'
  | 'refreshDesktopChat'
  | 'handleCreateChatSession'
  | 'handleRenameDesktopSession'
  | 'setActiveNav'
  | 'setActiveSettingsSectionId'
  | 'setActiveDetailTab'
  | 'setIsDetailPanelCollapsed'
  | 'setDesktopSessionRenameDraft'
  | 'setIsEditingDesktopSessionTitle'
  | 'setDesktopChatState'
  | 'setDesktopChatError'
  | 'isDesktopChatSending'
  | 'setIsDesktopChatSending'
  | 'setPendingUserChatMessage'
  | 'queuedDesktopMessagesBySession'
  | 'setQueuedDesktopMessagesBySession'
  | 'setDesktopLiveTurnsBySession'
  | 'setCloudBridgeState'
  | 'sendCloudBridgeMessage'
  | 'sendCloudGroupControl'
  | 'cancelCloudBridgeAgentRequest'
  | 'watchDesktopLiveTurn'
  | 'shouldAutoFollowChatRef'
  | 'setActiveConvId'
> & {
  attachmentSummaryText: (text: string) => string;
  selectComposerValue: (scope: ComposerScope, type: 'model', value: string) => Promise<void>;
  appendProjectDraft: (value: string) => void;
  appendChatDraft: (value: string) => void;
};

export function useComposerMessageActions({
  isNativeShell,
  activeConversationIsBridge,
  chatConversations,
  activeConvId,
  activeConvCanonicalSessionId,
  activeConvMessages,
  activeConvBridgeTarget,
  activeConvMentionScope,
  activeProjectId,
  activeProjectSessionId,
  activeProjectRoot,
  selectProjectSession,
  desktopChatState,
  desktopBridgeState,
  canonicalSessionState,
  hasAnyDesktopAuth,
  canonicalHumanIdentityId,
  setCanonicalSessionState,
  desktopLiveTurn,
  composerSelections,
  composerDrafts,
  setComposerDrafts,
  activeChatQuote,
  setProjectWorkspaces,
  setOpenComposerSelector,
  chatComposerAttachments,
  setChatComposerAttachments,
  chatModelOptions,
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
  isDesktopChatSending,
  setIsDesktopChatSending,
  setPendingUserChatMessage,
  queuedDesktopMessagesBySession,
  setQueuedDesktopMessagesBySession,
  setDesktopLiveTurnsBySession,
  setCloudBridgeState,
  sendCloudBridgeMessage,
  sendCloudGroupControl,
  cancelCloudBridgeAgentRequest,
  watchDesktopLiveTurn,
  shouldAutoFollowChatRef,
  setActiveConvId,
  attachmentSummaryText,
  selectComposerValue,
  appendProjectDraft,
  appendChatDraft,
}: UseComposerMessageActionsArgs) {
  const [pendingBridgeOutreach, setPendingBridgeOutreach] = useState<PendingBridgeOutreach | null>(null);
  const pendingBridgeOutreachRef = useRef<PendingBridgeOutreach | null>(null);
  const pendingBridgeCancelRequestedRef = useRef(false);
  const localChatSendInFlightRef = useRef<LocalChatSendInFlight | null>(null);
  const userCancelledTurnIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    pendingBridgeOutreachRef.current = pendingBridgeOutreach;
  }, [pendingBridgeOutreach]);

  useEffect(() => {
    if (!pendingBridgeOutreach) return;
    const conversation = desktopBridgeState?.conversations.find((candidate) => candidate.id === pendingBridgeOutreach.conversationId);
    const status = conversation?.outreach?.status?.trim().toLowerCase();
    if (status && ['completed', 'complete', 'failed', 'cancelled', 'timeout'].includes(status)) {
      setPendingBridgeOutreach(null);
      setIsDesktopChatSending(false);
    }
  }, [desktopBridgeState?.conversations, pendingBridgeOutreach, setIsDesktopChatSending]);

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

  const handleSendChatMessage = useChatMessageActions({
    activeConversationIsBridge,
    activeConvBridgeTarget,
    activeConvCanonicalSessionId,
    activeConvId,
    activeConvMessages,
    activeConvMentionScope,
    chatConversations,
    attachmentSummaryText,
    canonicalSessionState,
    hasAnyDesktopAuth,
    canonicalHumanIdentityId,
    chatComposerAttachments,
    composerSelections,
    composerDrafts,
    activeChatQuote,
    desktopBridgeState,
    desktopChatState,
    desktopLiveTurn,
    handleLocalSlashCommand,
    isDesktopChatSending,
    isNativeShell,
    pendingBridgeCancelRequestedRef,
    localChatSendInFlightRef,
    userCancelledTurnIdsRef,
    refreshDesktopChat,
    setActiveConvId,
    setCanonicalSessionState,
    setChatComposerAttachments,
    setComposerDrafts,
    setCloudBridgeState,
    sendCloudBridgeMessage,
    sendCloudGroupControl,
    setDesktopChatError,
    setDesktopChatState,
    setDesktopLiveTurnsBySession,
    setIsDesktopChatSending,
    setOpenComposerSelector,
    setPendingBridgeOutreach,
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
    desktopBridgeState,
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

  const acceptChatMentionTarget = useCallback((label: string) => {
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

  const stopBridgeOutreach = useCallback(async (conversationId: string, requestId?: string | null) => {
    setDesktopChatError(null);
    const pendingOutreach = pendingBridgeOutreachRef.current;
    if (pendingOutreach?.conversationId === conversationId && pendingOutreach.requestId === requestId) {
      setPendingBridgeOutreach(null);
      setIsDesktopChatSending(false);
    }
    try {
      if (isCloudBridgeConversationId(conversationId) || isCloudGroupAgentConversationId(conversationId)) {
        if (!requestId?.trim()) throw new Error('Unable to stop request');
        if (!cancelCloudBridgeAgentRequest) throw new Error('Chat is still loading. Try again in a moment.');
        await cancelCloudBridgeAgentRequest(conversationId, requestId);
        return;
      }
      throw new Error('This chat is unavailable. Try again from the chat list.');
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to stop request');
      throw error;
    }
  }, [cancelCloudBridgeAgentRequest, setDesktopChatError, setIsDesktopChatSending, setPendingBridgeOutreach]);

  const handleStopBridgeAgentRequest = useCallback(async (request: BridgeAgentRequestControl) => {
    await stopBridgeOutreach(request.conversationId, request.requestId);
  }, [stopBridgeOutreach]);

  const handleStopDesktopChatTurn = useCallback(async () => {
    const pendingOutreach = pendingBridgeOutreachRef.current;
    if (pendingOutreach) {
      try {
        await stopBridgeOutreach(pendingOutreach.conversationId, pendingOutreach.requestId);
      } catch {
        // stopBridgeOutreach already surfaced the error in chat state.
      }
      return;
    }

    if (!desktopLiveTurn || desktopLiveTurn.completed) {
      if (isDesktopChatSending) {
        pendingBridgeCancelRequestedRef.current = true;
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
  }, [desktopLiveTurn, isDesktopChatSending, refreshDesktopChat, setDesktopChatError, setDesktopLiveTurnsBySession, setIsDesktopChatSending, stopBridgeOutreach]);

  return {
    handleSendChatMessage,
    handleSendProjectMessage,
    handleStopDesktopChatTurn,
    handleStopBridgeAgentRequest,
    acceptChatSlashCommand: appendChatDraft,
    acceptProjectSlashCommand: appendProjectDraft,
    acceptChatMentionTarget,
    acceptProjectMentionTarget,
  };
}
