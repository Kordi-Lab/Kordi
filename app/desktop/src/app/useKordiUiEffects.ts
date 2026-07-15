import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { isLocalDraftChatConversationId, isProjectDraftSessionId } from '@/features/chat/draftSessions';
import { isCloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentMessages';
import type { ComposerScope, ContactClass, DesktopAuthState, DesktopChatState, DesktopChatTurnSnapshot, EditFilePreview, ResolvedThemeMode } from '@/kordi-app/types';

type UseKordiUiEffectsArgs = {
  isNativeShell: boolean;
  desktopChatState: DesktopChatState | null;
  desktopAuthState: DesktopAuthState | null;
  refreshDesktopChat: (activeSessionId?: string) => Promise<unknown>;
  activeNav: 'chats' | 'contacts' | 'projects' | 'agents' | 'bridge' | 'settings';
  activeConvId: string;
  activeProjectId: string;
  activeProjectSessionId: string;
  setActiveConvId: Dispatch<SetStateAction<string>>;
  displayedContacts: Array<{ id: string; classType: ContactClass }>;
  activeContactId: string;
  setActiveContactId: Dispatch<SetStateAction<string>>;
  setActiveContactGroup: Dispatch<SetStateAction<ContactClass>>;
  displayedAgents: Array<{ id: string }>;
  activeAgentId: string;
  setActiveAgentId: Dispatch<SetStateAction<string>>;
  setActiveSourcePreview: Dispatch<SetStateAction<EditFilePreview | null>>;
  setActiveArtifactId: Dispatch<SetStateAction<string | null>>;
  setOpenComposerSelector: Dispatch<SetStateAction<{ scope: ComposerScope; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null>>;
  setChatComposerAttachments: Dispatch<SetStateAction<Array<{ id: string; name: string; path: string; kind: 'image' | 'file' }>>>;
  openComposerSelector: { scope: ComposerScope; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null;
  composerControlsRef: MutableRefObject<HTMLDivElement | null>;
  themeMode: ResolvedThemeMode;
  activeConversationIsBridge: boolean;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  setComposerSelections: Dispatch<SetStateAction<Record<ComposerScope, { mode: string; model: string; thinking: string }>>>;
  chatTranscriptScrollRef: MutableRefObject<HTMLDivElement | null>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  activeConvMessagesLength: number;
  activeLastMessageTime?: string;
  activeTranscriptLastMessageIsOwn: boolean;
  activeProjectSessionIdValue: string;
  activeProjectSessionMessagesLength: number;
  activeProjectLastMessageTime?: string;
  pendingUserChatMessageText?: string | null;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  setChatSlashMenuIndex: Dispatch<SetStateAction<number>>;
  chatSlashQuery: string | null;
  filteredChatSlashCommandsLength: number;
  projectSlashQuery: string | null;
  filteredProjectSlashCommandsLength: number;
};

export function composerSelectorEventIsInsideControls(
  target: EventTarget | null,
  composerControls: HTMLDivElement | null,
) {
  if (!(target instanceof Node)) return false;
  if (composerControls?.contains(target)) return true;

  const targetElement = target instanceof Element ? target : target.parentElement;
  return Boolean(targetElement?.closest('.app-composer-model-menu-layer'));
}

export function shouldFollowTranscriptUpdate({
  followRequested,
  latestMessageIsOwn,
  previousDistanceFromBottom,
  currentDistanceFromBottom,
}: {
  followRequested: boolean;
  latestMessageIsOwn: boolean;
  previousDistanceFromBottom: number;
  currentDistanceFromBottom: number;
}) {
  return followRequested && (
    latestMessageIsOwn
    || previousDistanceFromBottom < 180
    || currentDistanceFromBottom < 240
  );
}

export function useKordiUiEffects({
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
  setActiveArtifactId,
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
  activeConvMessagesLength,
  activeLastMessageTime,
  activeTranscriptLastMessageIsOwn,
  activeProjectSessionIdValue,
  activeProjectSessionMessagesLength,
  activeProjectLastMessageTime,
  pendingUserChatMessageText,
  desktopLiveTurn,
  setChatSlashMenuIndex,
  chatSlashQuery,
  filteredChatSlashCommandsLength,
  projectSlashQuery,
  filteredProjectSlashCommandsLength,
}: UseKordiUiEffectsArgs) {
  const transcriptScrollMetricsRef = useRef<{ scrollHeight: number; scrollTop: number; clientHeight: number } | null>(null);

  useEffect(() => {
    if (!isNativeShell || !desktopChatState?.activeSessionId) return;
    if (isCloudAgentRuntimeSessionId(desktopChatState.activeSessionId)) return;
    setActiveConvId((current) => (!current || current === 'my-agent' ? desktopChatState.activeSessionId : current));
  }, [desktopChatState?.activeSessionId, isNativeShell, setActiveConvId]);

  useEffect(() => {
    if (!isNativeShell || !isCloudAgentRuntimeSessionId(activeConvId)) return;
    setActiveConvId('draft:local-chat');
  }, [activeConvId, isNativeShell, setActiveConvId]);

  useEffect(() => {
    if (displayedContacts.length === 0) return;
    if (displayedContacts.some((contact) => contact.id === activeContactId)) return;
    setActiveContactId(displayedContacts[0].id);
    setActiveContactGroup(displayedContacts[0].classType);
  }, [activeContactId, displayedContacts, setActiveContactGroup, setActiveContactId]);

  useEffect(() => {
    if (displayedAgents.length === 0) return;
    if (displayedAgents.some((agent) => agent.id === activeAgentId)) return;
    setActiveAgentId(displayedAgents[0].id);
  }, [activeAgentId, displayedAgents, setActiveAgentId]);

  useEffect(() => {
    setActiveSourcePreview(null);
    setActiveArtifactId(null);
    setOpenComposerSelector(null);
    setChatComposerAttachments([]);
  }, [activeNav, activeConvId, activeProjectId, activeProjectSessionId, setActiveArtifactId, setActiveSourcePreview, setChatComposerAttachments, setOpenComposerSelector]);

  useEffect(() => {
    if (!openComposerSelector) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (composerSelectorEventIsInsideControls(event.target, composerControlsRef.current)) return;
      setOpenComposerSelector(null);
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [composerControlsRef, openComposerSelector, setOpenComposerSelector]);

  useEffect(() => {
    document.body.classList.toggle('theme-light', themeMode === 'light');
    document.body.classList.toggle('theme-dark', themeMode === 'dark');
    document.documentElement.style.colorScheme = themeMode;

    return () => {
      document.body.classList.remove('theme-light', 'theme-dark');
      document.documentElement.style.colorScheme = 'dark';
    };
  }, [themeMode]);

  useEffect(() => {
    if (!isNativeShell || !desktopChatState?.activeSession) return;

    const matchingModelValue =
      desktopChatState.modelOptions.find(
        (option) =>
          option.provider === desktopChatState.activeSession.provider
          && option.label === desktopChatState.activeSession.model,
      )?.value ?? `${desktopChatState.activeSession.provider}/${desktopChatState.activeSession.model}`;

    if (!activeConversationIsBridge) {
      setDesktopSessionRenameDraft(desktopChatState.activeSession.title);
      setIsEditingDesktopSessionTitle(false);
    }
    const shouldSyncChatSelection = !isLocalDraftChatConversationId(activeConvId)
      || isLocalDraftChatConversationId(desktopChatState.activeSessionId);
    setComposerSelections((current) => ({
      ...current,
      chat: shouldSyncChatSelection
        ? {
            ...current.chat,
            model: matchingModelValue,
            thinking: desktopChatState.activeSession.thinking,
          }
        : current.chat,
      project: {
        ...current.project,
        model: desktopChatState.activeSessionId === activeProjectSessionId ? matchingModelValue : current.project.model,
        thinking: desktopChatState.activeSessionId === activeProjectSessionId ? desktopChatState.activeSession.thinking : current.project.thinking,
      },
    }));
  }, [
    activeConversationIsBridge,
    activeConvId,
    activeProjectSessionId,
    desktopChatState?.activeSession,
    desktopChatState?.activeSessionId,
    desktopChatState?.modelOptions,
    isNativeShell,
    setComposerSelections,
    setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle,
  ]);

  useLayoutEffect(() => {
    if (activeNav !== 'chats' && activeNav !== 'projects') return;

    shouldAutoFollowChatRef.current = true;
    transcriptScrollMetricsRef.current = null;

    const container = chatTranscriptScrollRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [activeConvId, activeNav, activeProjectSessionId, chatTranscriptScrollRef, shouldAutoFollowChatRef]);

  useLayoutEffect(() => {
    if (activeNav !== 'chats' && activeNav !== 'projects') return;

    const container = chatTranscriptScrollRef.current;
    if (!container) return;

    const previousMetrics = transcriptScrollMetricsRef.current;
    const previousDistanceFromBottom = previousMetrics
      ? previousMetrics.scrollHeight - previousMetrics.scrollTop - previousMetrics.clientHeight
      : 0;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (container.scrollTop > maxScrollTop) {
      container.scrollTop = maxScrollTop;
    }

    const currentDistanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottomNow = currentDistanceFromBottom < 240;
    const shouldFollow = shouldFollowTranscriptUpdate({
      followRequested: shouldAutoFollowChatRef.current,
      latestMessageIsOwn: activeTranscriptLastMessageIsOwn,
      previousDistanceFromBottom,
      currentDistanceFromBottom,
    });

    if (shouldFollow) {
      container.scrollTop = container.scrollHeight;
    } else if (shouldAutoFollowChatRef.current && !isNearBottomNow) {
      shouldAutoFollowChatRef.current = false;
    }

    transcriptScrollMetricsRef.current = {
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
    };
  }, [
    activeNav,
    activeConvId,
    activeConvMessagesLength,
    activeLastMessageTime,
    activeTranscriptLastMessageIsOwn,
    activeProjectSessionIdValue,
    activeProjectSessionMessagesLength,
    activeProjectLastMessageTime,
    pendingUserChatMessageText,
    desktopLiveTurn?.status,
    desktopLiveTurn?.assistantText,
    desktopLiveTurn?.thinkingText,
    desktopLiveTurn?.tools.length,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
  ]);

  useEffect(() => {
    setChatSlashMenuIndex(0);
  }, [activeNav, chatSlashQuery, filteredChatSlashCommandsLength, projectSlashQuery, filteredProjectSlashCommandsLength, setChatSlashMenuIndex]);

  useEffect(() => {
    if (!isNativeShell || !desktopAuthState) return;

    if (activeNav === 'projects' && isProjectDraftSessionId(activeProjectSessionId)) return;

    const sessionId = activeNav === 'projects'
      ? (activeProjectSessionId || desktopChatState?.activeSessionId)
      : desktopChatState?.activeSessionId;

    void refreshDesktopChat(sessionId);
  }, [
    activeNav,
    activeProjectSessionId,
    desktopAuthState,
    desktopChatState?.activeSessionId,
    isNativeShell,
    refreshDesktopChat,
  ]);
}
