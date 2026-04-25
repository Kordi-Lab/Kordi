import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { mergeDesktopBridgeState } from '@/features/bridge/useBridgeState';
import { isCanonicalBridgeSessionId } from '@/features/canonical/sessionResolver';
import type { DesktopBridgeState, DesktopChatState } from '@/kordi-app/types';
import {
  createDesktopChatSession,
  markDesktopBridgeConversationRead,
  renameDesktopChatSession,
} from '@/lib/desktop';

import {
  LOCAL_DRAFT_CHAT_CONVERSATION_ID,
  isLocalDraftChatConversationId,
} from './draftSessions';

type AttachmentItem = { id: string; name: string; path: string; kind: 'image' | 'file' };

type UseDesktopSessionControllerArgs = {
  isNativeShell: boolean;
  activeConversationIsBridge: boolean;
  activeConvId: string;
  desktopChatState: DesktopChatState | null;
  desktopSessionRenameDraft: string;
  selectProjectSession: (projectId: string, sessionId: string) => void;
  refreshDesktopChat: (activeSessionId?: string) => Promise<unknown>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  setActiveConvId: Dispatch<SetStateAction<string>>;
  setPendingUserChatMessage: Dispatch<SetStateAction<{ text: string; time: string } | null>>;
  setChatComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  setDesktopBridgeState: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  setDesktopChatState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setComposerDrafts: Dispatch<SetStateAction<Record<'chat' | 'project', string>>>;
  setOpenComposerSelector: Dispatch<SetStateAction<{ scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null>>;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
};

export function useDesktopSessionController({
  isNativeShell,
  activeConversationIsBridge,
  activeConvId,
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
}: UseDesktopSessionControllerArgs) {
  const handleSelectChatSession = useCallback(async (sessionId: string) => {
    shouldAutoFollowChatRef.current = true;
    setActiveConvId(sessionId);
    setPendingUserChatMessage(null);
    setChatComposerAttachments([]);
    if (!isNativeShell) return;

    if (isLocalDraftChatConversationId(sessionId) || isCanonicalBridgeSessionId(sessionId)) {
      setDesktopChatError(null);
      return;
    }

    if (sessionId.startsWith('bridge:')) {
      try {
        const nextState = await markDesktopBridgeConversationRead(sessionId);
        setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
        setDesktopChatError(null);
      } catch (error) {
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to open bridge chat');
      }
      return;
    }

    try {
      setDesktopChatError(null);
      await refreshDesktopChat(sessionId);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to open chat session');
    }
  }, [isNativeShell, refreshDesktopChat, setActiveConvId, setChatComposerAttachments, setDesktopBridgeState, setDesktopChatError, setPendingUserChatMessage, shouldAutoFollowChatRef]);

  const handleCreateChatSession = useCallback(async () => {
    if (!isNativeShell) return;

    shouldAutoFollowChatRef.current = true;
    setDesktopChatError(null);
    setPendingUserChatMessage(null);
    setActiveConvId(LOCAL_DRAFT_CHAT_CONVERSATION_ID);
    setComposerDrafts((current) => ({ ...current, chat: '' }));
    setChatComposerAttachments([]);
  }, [isNativeShell, setActiveConvId, setChatComposerAttachments, setComposerDrafts, setDesktopChatError, setPendingUserChatMessage, shouldAutoFollowChatRef]);

  const handleSelectProjectSession = useCallback(async (projectId: string, sessionId: string) => {
    shouldAutoFollowChatRef.current = true;
    selectProjectSession(projectId, sessionId);
    setChatComposerAttachments([]);
    setOpenComposerSelector(null);
    if (!isNativeShell) return;

    try {
      setDesktopChatError(null);
      await refreshDesktopChat(sessionId);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to open project session');
    }
  }, [isNativeShell, refreshDesktopChat, selectProjectSession, setChatComposerAttachments, setDesktopChatError, setOpenComposerSelector, shouldAutoFollowChatRef]);

  const handleRenameDesktopSession = useCallback(async (fallbackName?: string) => {
    if (!isNativeShell || activeConversationIsBridge || !desktopChatState?.activeSessionId) return;
    const name = desktopSessionRenameDraft.trim();
    const baselineName = fallbackName ?? desktopChatState.activeSession.title;
    const isTransientDraft = isLocalDraftChatConversationId(activeConvId)
      || isLocalDraftChatConversationId(desktopChatState.activeSessionId);

    if (!name) {
      setDesktopSessionRenameDraft(baselineName);
      setIsEditingDesktopSessionTitle(false);
      return;
    }

    if (!isTransientDraft && name === baselineName) {
      setIsEditingDesktopSessionTitle(false);
      return;
    }

    try {
      setDesktopChatError(null);
      const sessionState = isTransientDraft
        ? await createDesktopChatSession()
        : desktopChatState;
      const targetSessionId = sessionState.activeSessionId;
      const nextState = await renameDesktopChatSession(targetSessionId, name);
      setDesktopChatState(nextState);
      setActiveConvId(nextState.activeSessionId);
      setDesktopSessionRenameDraft(nextState.activeSession.title);
      setIsEditingDesktopSessionTitle(false);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to rename session');
    }
  }, [activeConvId, activeConversationIsBridge, desktopChatState, desktopSessionRenameDraft, isNativeShell, setActiveConvId, setDesktopChatError, setDesktopChatState, setDesktopSessionRenameDraft, setIsEditingDesktopSessionTitle]);

  return {
    handleSelectChatSession,
    handleCreateChatSession,
    handleSelectProjectSession,
    handleRenameDesktopSession,
  };
}
