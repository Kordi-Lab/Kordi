import { useEffect, useMemo } from 'react';
import type { MutableRefObject } from 'react';

import { contactRequests, settingsSections } from '@/kordi-app/data';
import type { SettingsSection, SettingsSectionId } from '@/kordi-app/data/settings';
import type {
  DesktopBridgeHost,
  DesktopChatTurnSnapshot,
  DetailTab,
  EditFilePreview,
  Message,
  NavId,
  ProjectSession,
} from '@/kordi-app/types';
import { extractSessionArtifacts } from '@/features/chat/artifacts';

type UseKordiDesktopActivityArgs = {
  activeContactRequestId: string;
  activeSettingsSectionId: SettingsSectionId;
  activeBridgeHost: DesktopBridgeHost | null;
  activeNav: NavId;
  activeConvId: string;
  activeConv: { id: string; messages: Message[] };
  activeProjectSessionId: string;
  activeProjectSession: ProjectSession;
  activeConversationIsBridge: boolean;
  isDesktopBridgeSending: boolean;
  desktopLiveTurnsBySession: Record<string, DesktopChatTurnSnapshot | null | undefined>;
  chatConversations: Array<{ unread?: number | null }>;
  setVisibleLocalSessionId: (sessionId: string | null) => void;
  setActiveSourcePreview: (value: EditFilePreview | null) => void;
  setActiveArtifactId: (value: string | null) => void;
  setActiveDetailTab: (tab: DetailTab) => void;
  isDetailPanelCollapsed: boolean;
  lastSeenArtifactByContextRef: MutableRefObject<Record<string, string | null>>;
};

export function useKordiDesktopActivity({
  activeContactRequestId,
  activeSettingsSectionId,
  activeBridgeHost,
  activeNav,
  activeConvId,
  activeConv,
  activeProjectSessionId,
  activeProjectSession,
  activeConversationIsBridge,
  isDesktopBridgeSending,
  desktopLiveTurnsBySession,
  chatConversations,
  setVisibleLocalSessionId,
  setActiveSourcePreview,
  setActiveArtifactId,
  setActiveDetailTab,
  isDetailPanelCollapsed,
  lastSeenArtifactByContextRef,
}: UseKordiDesktopActivityArgs) {
  const activeContactRequest = contactRequests.find((request) => request.id === activeContactRequestId) ?? contactRequests[0];
  const activeSettingsSection = settingsSections.find((section) => section.id === activeSettingsSectionId) ?? settingsSections[0] as SettingsSection;
  const activeProjectBridgeHost = activeBridgeHost;
  const activeChatLiveTurn = activeConversationIsBridge ? null : (desktopLiveTurnsBySession[activeConv.id] ?? null);
  const activeProjectLiveTurn = activeProjectSession.id ? (desktopLiveTurnsBySession[activeProjectSession.id] ?? null) : null;
  const activeDesktopLiveTurn = activeNav === 'projects' ? activeProjectLiveTurn : activeChatLiveTurn;
  const isDesktopChatSending = activeNav === 'projects'
    ? Boolean(activeProjectLiveTurn && !activeProjectLiveTurn.completed)
    : activeNav === 'chats' && activeConversationIsBridge
      ? isDesktopBridgeSending
      : Boolean(activeChatLiveTurn && !activeChatLiveTurn.completed);

  const activeChatArtifacts = useMemo(
    () => activeConversationIsBridge ? [] : extractSessionArtifacts(activeConv.messages, activeChatLiveTurn),
    [activeChatLiveTurn, activeConv.messages, activeConversationIsBridge],
  );
  const activeProjectArtifacts = useMemo(
    () => extractSessionArtifacts(activeProjectSession.messages, activeProjectLiveTurn),
    [activeProjectLiveTurn, activeProjectSession.messages],
  );
  const activeArtifacts = activeNav === 'projects' ? activeProjectArtifacts : activeChatArtifacts;
  const artifactContextKey = activeNav === 'projects' ? `projects:${activeProjectSession.id}` : `chats:${activeConv.id}`;
  const totalUnreadMessages = useMemo(
    () => chatConversations.reduce((sum, conversation) => sum + Math.max(0, conversation.unread ?? 0), 0),
    [chatConversations],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = totalUnreadMessages > 0 ? `(${totalUnreadMessages}) Kordi` : 'Kordi';
  }, [totalUnreadMessages]);

  useEffect(() => {
    const visibleLocalSessionId = activeNav === 'projects'
      ? (activeProjectSessionId || null)
      : activeNav === 'chats' && !activeConvId.startsWith('bridge:')
        ? activeConvId
        : null;
    setVisibleLocalSessionId(visibleLocalSessionId);
  }, [activeConvId, activeNav, activeProjectSessionId, setVisibleLocalSessionId]);

  useEffect(() => {
    if ((activeNav !== 'chats' && activeNav !== 'projects') || (activeNav === 'chats' && activeConversationIsBridge)) {
      return;
    }

    const latestArtifact = activeArtifacts[0] ?? null;
    const latestArtifactToken = latestArtifact
      ? `${latestArtifact.id}:${latestArtifact.timeLabel ?? ''}:${latestArtifact.live ? 'live' : 'ready'}`
      : null;
    const previousArtifactToken = lastSeenArtifactByContextRef.current[artifactContextKey];
    lastSeenArtifactByContextRef.current[artifactContextKey] = latestArtifactToken;

    if (
      !latestArtifact?.id
      || previousArtifactToken === undefined
      || previousArtifactToken === latestArtifactToken
      || isDetailPanelCollapsed
    ) {
      return;
    }

    setActiveSourcePreview(null);
    setActiveArtifactId(latestArtifact.id);
    setActiveDetailTab('artifacts');
  }, [
    activeArtifacts,
    activeConversationIsBridge,
    activeNav,
    artifactContextKey,
    isDetailPanelCollapsed,
    lastSeenArtifactByContextRef,
    setActiveArtifactId,
    setActiveDetailTab,
    setActiveSourcePreview,
  ]);

  return {
    activeContactRequest,
    activeSettingsSection,
    activeProjectBridgeHost,
    activeChatLiveTurn,
    activeProjectLiveTurn,
    activeDesktopLiveTurn,
    isDesktopChatSending,
    activeChatArtifacts,
    activeProjectArtifacts,
  };
}
