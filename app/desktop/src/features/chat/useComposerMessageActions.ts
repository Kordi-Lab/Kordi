import { useCallback, useEffect, useRef, useState } from 'react';

import { mergeDesktopBridgeState } from '@/features/bridge/useBridgeState';
import type { BridgeAgentRequestControl, ComposerScope } from '@/kordi-app/types';
import {
  cancelDesktopBridgeOutreach,
  cancelDesktopChatTurn,
} from '@/lib/desktop';

import { resizeComposerTextarea } from './composerController.shared';
import type { UseComposerControllerArgs } from './composerController.types';
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
  | 'canonicalHumanIdentityId'
  | 'setCanonicalSessionState'
  | 'desktopLiveTurn'
  | 'composerSelections'
  | 'composerDrafts'
  | 'setComposerDrafts'
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
  | 'setDesktopLiveTurnsBySession'
  | 'setDesktopBridgeState'
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
  canonicalHumanIdentityId,
  setCanonicalSessionState,
  desktopLiveTurn,
  composerSelections,
  composerDrafts,
  setComposerDrafts,
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
  setDesktopLiveTurnsBySession,
  setDesktopBridgeState,
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
    attachmentSummaryText,
    canonicalHumanIdentityId,
    chatComposerAttachments,
    composerSelections,
    composerDrafts,
    desktopBridgeState,
    desktopChatState,
    desktopLiveTurn,
    handleLocalSlashCommand,
    isDesktopChatSending,
    isNativeShell,
    pendingBridgeCancelRequestedRef,
    localChatSendInFlightRef,
    refreshDesktopChat,
    setActiveConvId,
    setCanonicalSessionState,
    setChatComposerAttachments,
    setComposerDrafts,
    setDesktopBridgeState,
    setDesktopChatError,
    setDesktopChatState,
    setDesktopLiveTurnsBySession,
    setIsDesktopChatSending,
    setOpenComposerSelector,
    setPendingBridgeOutreach,
    setPendingUserChatMessage,
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
    setDesktopBridgeState,
    setDesktopChatError,
    setDesktopChatState,
    setIsDesktopChatSending,
    setProjectWorkspaces,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
  });

  const acceptChatMentionTarget = useCallback((label: string) => {
    setComposerDrafts((current) => ({ ...current, chat: insertMentionIntoDraft(current.chat, label) }));
    resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]', insertMentionIntoDraft(composerDrafts.chat, label));
  }, [composerDrafts.chat, setComposerDrafts]);

  const acceptProjectMentionTarget = useCallback((label: string) => {
    setComposerDrafts((current) => ({ ...current, project: insertMentionIntoDraft(current.project, label) }));
    resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]', insertMentionIntoDraft(composerDrafts.project, label));
  }, [composerDrafts.project, setComposerDrafts]);

  const stopBridgeOutreach = useCallback(async (conversationId: string, requestId?: string | null) => {
    setDesktopChatError(null);
    const pendingOutreach = pendingBridgeOutreachRef.current;
    if (pendingOutreach?.conversationId === conversationId && pendingOutreach.requestId === requestId) {
      setPendingBridgeOutreach(null);
      setIsDesktopChatSending(false);
    }
    try {
      const nextState = await cancelDesktopBridgeOutreach(conversationId, requestId);
      setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to stop bridge outreach');
      throw error;
    }
  }, [setDesktopBridgeState, setDesktopChatError, setIsDesktopChatSending, setPendingBridgeOutreach]);

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
    setDesktopChatError(null);
    localChatSendInFlightRef.current = null;
    setIsDesktopChatSending(false);
    setDesktopLiveTurnsBySession((current) => {
      if (!current[stoppedSessionId]) return current;
      const { [stoppedSessionId]: _removed, ...rest } = current;
      return rest;
    });

    try {
      await cancelDesktopChatTurn(desktopLiveTurn.id);
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
