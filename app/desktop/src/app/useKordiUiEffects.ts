import { useEffect, useLayoutEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ComposerScope, ContactClass, DesktopAuthState, DesktopChatState, DesktopChatTurnSnapshot, EditFilePreview, ThemeMode } from '@/kordi-app/types';

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
  themeMode: ThemeMode;
  activeConversationIsBridge: boolean;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  setComposerSelections: Dispatch<SetStateAction<Record<ComposerScope, { mode: string; model: string; thinking: string }>>>;
  chatTranscriptScrollRef: MutableRefObject<HTMLDivElement | null>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  activeConvMessagesLength: number;
  activeLastMessageTime?: string;
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
  useEffect(() => {
    if (!isNativeShell || !desktopChatState?.activeSessionId) return;
    setActiveConvId((current) => (current === 'my-agent' ? desktopChatState.activeSessionId : current));
  }, [desktopChatState?.activeSessionId, isNativeShell, setActiveConvId]);

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
      if (composerControlsRef.current?.contains(event.target as Node)) return;
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
      )?.value ?? desktopChatState.activeSession.model;

    if (!activeConversationIsBridge) {
      setDesktopSessionRenameDraft(desktopChatState.activeSession.title);
      setIsEditingDesktopSessionTitle(false);
    }
    setComposerSelections((current) => ({
      ...current,
      chat: {
        ...current.chat,
        model: matchingModelValue,
        thinking: desktopChatState.activeSession.thinking,
      },
      project: {
        ...current.project,
        model: desktopChatState.activeSessionId === activeProjectSessionId ? matchingModelValue : current.project.model,
        thinking: desktopChatState.activeSessionId === activeProjectSessionId ? desktopChatState.activeSession.thinking : current.project.thinking,
      },
    }));
  }, [
    activeConversationIsBridge,
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
    if ((activeNav !== 'chats' && activeNav !== 'projects') || !shouldAutoFollowChatRef.current) return;

    const container = chatTranscriptScrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [
    activeNav,
    activeConvId,
    activeConvMessagesLength,
    activeLastMessageTime,
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

    const sessionId = activeNav === 'projects'
      ? (activeProjectSessionId ?? desktopChatState?.activeSessionId)
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
