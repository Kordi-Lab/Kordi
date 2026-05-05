import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';

import { settingsSections } from '@/kordi-app/data';
import type { SettingsSection, SettingsSectionId } from '@/kordi-app/data/settings';
import type {
  ContactRequest,
  DesktopBridgeHost,
  DesktopChatTurnSnapshot,
  DetailTab,
  EditFilePreview,
  Message,
  NavId,
  ProjectSession,
} from '@/kordi-app/types';
import { extractSessionArtifacts } from '@/features/chat/artifacts';
import { isLocalDraftChatConversationId, isProjectDraftSessionId } from '@/features/chat/draftSessions';

function liveTurnArtifactSignature(turn?: DesktopChatTurnSnapshot | null) {
  if (!turn) return '';
  return [
    turn.id,
    turn.sessionId,
    turn.completed ? 'completed' : 'running',
    ...turn.tools.map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      tool.arguments,
      tool.isError ? 'error' : 'ok',
    ].join('\u0000')),
  ].join('\u0001');
}

function useArtifactLiveTurn(turn?: DesktopChatTurnSnapshot | null) {
  const signature = liveTurnArtifactSignature(turn);
  const stableTurnRef = useRef<{ signature: string; turn: DesktopChatTurnSnapshot | null }>({
    signature,
    turn: turn ?? null,
  });

  if (stableTurnRef.current.signature !== signature) {
    stableTurnRef.current = { signature, turn: turn ?? null };
  }

  return stableTurnRef.current.turn;
}

export function visibleLocalSessionIdForActivity({
  activeNav,
  activeChatSessionId,
  activeChatCanonicalSessionId,
  activeProjectSessionId,
}: {
  activeNav: NavId;
  activeChatSessionId: string;
  activeChatCanonicalSessionId?: string | null;
  activeProjectSessionId: string;
}) {
  if (activeNav === 'projects') {
    return isProjectDraftSessionId(activeProjectSessionId) ? null : activeProjectSessionId || null;
  }
  if (activeNav !== 'chats') return null;
  const canonicalSessionId = activeChatCanonicalSessionId?.trim();
  const visibleSessionId = canonicalSessionId || activeChatSessionId.trim();
  if (!visibleSessionId) return null;
  if (!canonicalSessionId && activeChatSessionId.startsWith('bridge:')) return null;
  if (isLocalDraftChatConversationId(visibleSessionId)) return null;
  return visibleSessionId;
}

type UseKordiDesktopActivityArgs = {
  activeContactRequestId: string;
  activeSettingsSectionId: SettingsSectionId;
  contactRequests: ContactRequest[];
  activeBridgeHost: DesktopBridgeHost | null;
  activeNav: NavId;
  activeConvId: string;
  activeConv: { id: string; canonicalSessionId?: string; messages: Message[] };
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
  contactRequests,
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
  const activeChatLiveTurn = desktopLiveTurnsBySession[activeConv.id] ?? null;
  const activeProjectLiveTurn = activeProjectSession.id ? (desktopLiveTurnsBySession[activeProjectSession.id] ?? null) : null;
  const activeDesktopLiveTurn = activeNav === 'projects' ? activeProjectLiveTurn : activeChatLiveTurn;
  const activeChatArtifactLiveTurn = useArtifactLiveTurn(activeChatLiveTurn);
  const activeProjectArtifactLiveTurn = useArtifactLiveTurn(activeProjectLiveTurn);
  const isDesktopChatSending = activeNav === 'projects'
    ? Boolean(activeProjectLiveTurn && !activeProjectLiveTurn.completed)
    : activeNav === 'chats' && activeConversationIsBridge
      ? isDesktopBridgeSending || Boolean(activeChatLiveTurn && !activeChatLiveTurn.completed)
      : Boolean(activeChatLiveTurn && !activeChatLiveTurn.completed);

  const activeChatArtifacts = useMemo(
    () => activeConversationIsBridge ? [] : extractSessionArtifacts(activeConv.messages, activeChatArtifactLiveTurn),
    [activeChatArtifactLiveTurn, activeConv.messages, activeConversationIsBridge],
  );
  const activeProjectArtifacts = useMemo(
    () => extractSessionArtifacts(activeProjectSession.messages, activeProjectArtifactLiveTurn),
    [activeProjectArtifactLiveTurn, activeProjectSession.messages],
  );
  const activeArtifacts = activeNav === 'projects' ? activeProjectArtifacts : activeChatArtifacts;
  const artifactContextKey = activeNav === 'projects' ? `projects:${activeProjectSession.id}` : `chats:${activeConv.id}`;
  const totalUnreadMessages = useMemo(
    () => chatConversations.reduce((sum, conversation) => sum + Math.max(0, conversation.unread ?? 0), 0),
    [chatConversations],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const baseTitle = import.meta.env.VITE_KORDI_WINDOW_TITLE?.trim() || 'Kordi';
    document.title = totalUnreadMessages > 0 ? `(${totalUnreadMessages}) ${baseTitle}` : baseTitle;
  }, [totalUnreadMessages]);

  useEffect(() => {
    setVisibleLocalSessionId(visibleLocalSessionIdForActivity({
      activeNav,
      activeChatSessionId: activeConv.id,
      activeChatCanonicalSessionId: activeConv.canonicalSessionId,
      activeProjectSessionId,
    }));
  }, [activeConv.canonicalSessionId, activeConv.id, activeNav, activeProjectSessionId, setVisibleLocalSessionId]);

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
