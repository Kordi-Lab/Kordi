import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { DesktopBridgeState, DesktopChatState, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import {
  createDesktopChatSession,
  markDesktopBridgeConversationRead,
  renameDesktopChatSession,
} from '@/lib/desktop';

type AttachmentItem = { id: string; name: string; path: string; kind: 'image' | 'file' };

type UseDesktopSessionControllerArgs = {
  isNativeShell: boolean;
  activeConversationIsBridge: boolean;
  desktopChatState: DesktopChatState | null;
  desktopSessionRenameDraft: string;
  selectProjectSession: (projectId: string, sessionId: string) => void;
  refreshDesktopChat: (activeSessionId?: string) => Promise<unknown>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  setActiveConvId: Dispatch<SetStateAction<string>>;
  setPendingUserChatMessage: Dispatch<SetStateAction<{ text: string; time: string } | null>>;
  setChatComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  setDesktopLiveTurn: Dispatch<SetStateAction<DesktopChatTurnSnapshot | null>>;
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
  desktopChatState,
  desktopSessionRenameDraft,
  selectProjectSession,
  refreshDesktopChat,
  shouldAutoFollowChatRef,
  setActiveConvId,
  setPendingUserChatMessage,
  setChatComposerAttachments,
  setDesktopLiveTurn,
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
    setDesktopLiveTurn((current) => (current?.sessionId === sessionId ? current : null));
    if (!isNativeShell) return;

    if (sessionId.startsWith('bridge:')) {
      try {
        const nextState = await markDesktopBridgeConversationRead(sessionId);
        setDesktopBridgeState(nextState);
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
  }, [isNativeShell, refreshDesktopChat, setActiveConvId, setChatComposerAttachments, setDesktopBridgeState, setDesktopChatError, setDesktopLiveTurn, setPendingUserChatMessage, shouldAutoFollowChatRef]);

  const handleCreateChatSession = useCallback(async () => {
    if (!isNativeShell) return;

    try {
      shouldAutoFollowChatRef.current = true;
      setDesktopChatError(null);
      setPendingUserChatMessage(null);
      setDesktopLiveTurn(null);
      const nextState = await createDesktopChatSession();
      setDesktopChatState(nextState);
      setActiveConvId(nextState.activeSessionId);
      setComposerDrafts((current) => ({ ...current, chat: '' }));
      setChatComposerAttachments([]);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to create chat session');
    }
  }, [isNativeShell, setActiveConvId, setChatComposerAttachments, setComposerDrafts, setDesktopChatError, setDesktopChatState, setDesktopLiveTurn, setPendingUserChatMessage, shouldAutoFollowChatRef]);

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

    if (!name) {
      setDesktopSessionRenameDraft(baselineName);
      setIsEditingDesktopSessionTitle(false);
      return;
    }

    if (name === baselineName) {
      setIsEditingDesktopSessionTitle(false);
      return;
    }

    try {
      setDesktopChatError(null);
      const nextState = await renameDesktopChatSession(desktopChatState.activeSessionId, name);
      setDesktopChatState(nextState);
      setDesktopSessionRenameDraft(nextState.activeSession.title);
      setIsEditingDesktopSessionTitle(false);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to rename session');
    }
  }, [activeConversationIsBridge, desktopChatState, desktopSessionRenameDraft, isNativeShell, setDesktopChatError, setDesktopChatState, setDesktopSessionRenameDraft, setIsEditingDesktopSessionTitle]);

  return {
    handleSelectChatSession,
    handleCreateChatSession,
    handleSelectProjectSession,
    handleRenameDesktopSession,
  };
}
