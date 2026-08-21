import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { isLegacyCanonicalCollaborationSessionId, isCanonicalCloudSessionId } from '@/features/canonical/sessionResolver';
import type { DesktopChatState } from '@/kordi-app/types';
import { startSessionClickToFirstMessage } from '@/features/performance/chatPerformance';
import {
  createDesktopChatSession,
  forkDesktopChatSessionFromMessage,
  prepareDesktopChatDraftSession,
  renameDesktopChatSession,
} from '@/lib/desktop';

import { updateScopeDraft, type ComposerDraftState } from './composerDrafts';
import {
  LOCAL_DRAFT_CHAT_CONVERSATION_ID,
  isLocalDraftChatConversationId,
  isProjectDraftSessionId,
} from './draftSessions';
import { selectDesktopSessionAndPreloadTranscript } from './desktopSessionSelection';

type AttachmentItem = { id: string; name: string; path: string; kind: 'image' | 'file' };

function draftDesktopChatState(current: DesktopChatState | null): DesktopChatState | null {
  if (!current) return current;
  return {
    ...current,
    activeSessionId: LOCAL_DRAFT_CHAT_CONVERSATION_ID,
    activeSession: {
      ...current.activeSession,
      id: LOCAL_DRAFT_CHAT_CONVERSATION_ID,
      title: 'New chat',
      subtitle: '',
      updatedAtLabel: 'Draft',
      updatedAtMs: 0,
      messageCount: 0,
      draft: true,
      cacheMonitorText: null,
      project: null,
      messages: [],
    },
  };
}

type UseDesktopSessionControllerArgs = {
  isNativeShell: boolean;
  activeConversationUsesCollaboration: boolean;
  activeConvId: string;
  desktopChatState: DesktopChatState | null;
  desktopSessionRenameDraft: string;
  selectProjectSession: (projectId: string, sessionId: string) => void;
  refreshDesktopChat: (activeSessionId?: string) => Promise<unknown>;
  hydrateCanonicalSessionPage: (sessionId: string) => Promise<unknown>;
  isDesktopSessionTranscriptCached: (sessionId: string) => boolean;
  preloadDesktopSessionTranscript: (sessionId: string) => Promise<boolean>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  setActiveConvId: Dispatch<SetStateAction<string>>;
  setPendingUserChatMessage: Dispatch<SetStateAction<{ text: string; time: string } | null>>;
  setChatComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  setDesktopChatState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setOpenComposerSelector: Dispatch<SetStateAction<{ scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null>>;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  onForkCreated?: (result: Awaited<ReturnType<typeof forkDesktopChatSessionFromMessage>>) => Promise<void> | void;
  onPrepareChatDraftSession?: () => void;
};

export function useDesktopSessionController({
  isNativeShell,
  activeConversationUsesCollaboration,
  activeConvId,
  desktopChatState,
  desktopSessionRenameDraft,
  selectProjectSession,
  refreshDesktopChat,
  hydrateCanonicalSessionPage,
  isDesktopSessionTranscriptCached,
  preloadDesktopSessionTranscript,
  shouldAutoFollowChatRef,
  setActiveConvId,
  setPendingUserChatMessage,
  setChatComposerAttachments,
  setDesktopChatError,
  setDesktopChatState,
  setComposerDrafts,
  setOpenComposerSelector,
  setDesktopSessionRenameDraft,
  setIsEditingDesktopSessionTitle,
  onForkCreated,
  onPrepareChatDraftSession,
}: UseDesktopSessionControllerArgs) {
  const selectionRequestIdRef = useRef(0);

  const handlePrefetchChatSession = useCallback(async (sessionId: string) => {
    if (!isNativeShell) return true;
    try {
      if (
        isLegacyCanonicalCollaborationSessionId(sessionId)
        || isCanonicalCloudSessionId(sessionId)
      ) {
        await hydrateCanonicalSessionPage(sessionId);
        return true;
      }
      if (isLocalDraftChatConversationId(sessionId) || sessionId.startsWith('bridge:')) return true;
      const isKnownSession = desktopChatState?.activeSession.id === sessionId
        || desktopChatState?.sessions.some((session) => session.id === sessionId);
      const loaded = await preloadDesktopSessionTranscript(sessionId);
      if (loaded && !isKnownSession) await refreshDesktopChat();
      return loaded;
    } catch {
      return false;
    }
  }, [desktopChatState, hydrateCanonicalSessionPage, isNativeShell, preloadDesktopSessionTranscript, refreshDesktopChat]);

  const handleSelectChatSession = useCallback(async (sessionId: string) => {
    const requestId = selectionRequestIdRef.current + 1;
    selectionRequestIdRef.current = requestId;
    startSessionClickToFirstMessage(sessionId);
    shouldAutoFollowChatRef.current = true;
    setPendingUserChatMessage(null);
    setChatComposerAttachments([]);
    if (!isNativeShell) {
      setActiveConvId(sessionId);
      return;
    }

    if (
      isLegacyCanonicalCollaborationSessionId(sessionId)
      || isCanonicalCloudSessionId(sessionId)
    ) {
      setActiveConvId(sessionId);
      setDesktopChatError(null);
      void hydrateCanonicalSessionPage(sessionId).catch((error) => {
        if (selectionRequestIdRef.current !== requestId) return;
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to open chat session');
      });
      return;
    }

    if (
      isLocalDraftChatConversationId(sessionId)
      || sessionId.startsWith('bridge:')
    ) {
      setActiveConvId(sessionId);
      setDesktopChatError(null);
      return;
    }

    setDesktopChatError(null);
    const didCommitSelection = await selectDesktopSessionAndPreloadTranscript({
      sessionId,
      isTranscriptCached: isDesktopSessionTranscriptCached,
      preloadTranscript: preloadDesktopSessionTranscript,
      isSelectionCurrent: () => selectionRequestIdRef.current === requestId,
      selectSession: setActiveConvId,
    });
    if (!didCommitSelection) return;
    try {
      await refreshDesktopChat(sessionId);
    } catch (error) {
      if (selectionRequestIdRef.current !== requestId) return;
      setActiveConvId(sessionId);
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to open chat session');
    }
  }, [hydrateCanonicalSessionPage, isDesktopSessionTranscriptCached, isNativeShell, preloadDesktopSessionTranscript, refreshDesktopChat, setActiveConvId, setChatComposerAttachments, setDesktopChatError, setPendingUserChatMessage, shouldAutoFollowChatRef]);

  const handleCreateChatSession = useCallback(async () => {
    if (!isNativeShell) return;

    shouldAutoFollowChatRef.current = true;
    setDesktopChatError(null);
    setPendingUserChatMessage(null);
    onPrepareChatDraftSession?.();
    setActiveConvId(LOCAL_DRAFT_CHAT_CONVERSATION_ID);
    setDesktopChatState((current) => draftDesktopChatState(current));
    setComposerDrafts((current) => updateScopeDraft(current, 'chat', LOCAL_DRAFT_CHAT_CONVERSATION_ID, ''));
    setChatComposerAttachments([]);
    void prepareDesktopChatDraftSession().catch(() => {});
  }, [isNativeShell, onPrepareChatDraftSession, setActiveConvId, setChatComposerAttachments, setComposerDrafts, setDesktopChatError, setDesktopChatState, setPendingUserChatMessage, shouldAutoFollowChatRef]);

  const handleSelectProjectSession = useCallback(async (projectId: string, sessionId: string) => {
    shouldAutoFollowChatRef.current = true;
    selectProjectSession(projectId, sessionId);
    setChatComposerAttachments([]);
    setOpenComposerSelector(null);
    if (!isNativeShell) return;

    if (isProjectDraftSessionId(sessionId)) {
      setDesktopChatError(null);
      return;
    }

    try {
      setDesktopChatError(null);
      await refreshDesktopChat(sessionId);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to open project session');
    }
  }, [isNativeShell, refreshDesktopChat, selectProjectSession, setChatComposerAttachments, setDesktopChatError, setOpenComposerSelector, shouldAutoFollowChatRef]);

  const handleRenameDesktopSession = useCallback(async (fallbackName?: string) => {
    if (!isNativeShell || activeConversationUsesCollaboration || !desktopChatState?.activeSessionId) return;
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
  }, [activeConvId, activeConversationUsesCollaboration, desktopChatState, desktopSessionRenameDraft, isNativeShell, setActiveConvId, setDesktopChatError, setDesktopChatState, setDesktopSessionRenameDraft, setIsEditingDesktopSessionTitle]);

  const handleForkChatMessage = useCallback(async (sessionId: string, messageEntryId: string) => {
    if (!isNativeShell) return;
    if (!sessionId || !messageEntryId) return;
    shouldAutoFollowChatRef.current = true;
    try {
      setDesktopChatError(null);
      const result = await forkDesktopChatSessionFromMessage(sessionId, messageEntryId);
      if (!result.canonicalOnly) {
        setDesktopChatState(result.state);
      }
      setActiveConvId(result.forkedSessionId);
      setChatComposerAttachments([]);
      setPendingUserChatMessage(null);
      try {
        await onForkCreated?.(result);
      } catch (error) {
        console.warn('[desktop-session-controller] post-fork sync failed', error);
        setDesktopChatError(`Fork created, but Cloud fork sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to fork session');
    }
  }, [
    isNativeShell,
    setActiveConvId,
    setChatComposerAttachments,
    setDesktopChatError,
    setDesktopChatState,
    setPendingUserChatMessage,
    shouldAutoFollowChatRef,
    onForkCreated,
  ]);

  return {
    handlePrefetchChatSession,
    handleSelectChatSession,
    handleCreateChatSession,
    handleSelectProjectSession,
    handleRenameDesktopSession,
    handleForkChatMessage,
  };
}
