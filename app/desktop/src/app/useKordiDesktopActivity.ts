import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';

import type { SettingsSection, SettingsSectionId } from '@/kordi-app/data/settings';
import type {
  Conversation,
  ContactRequest,
  DesktopCollaborationHost,
  DesktopChatTurnSnapshot,
  DetailTab,
  EditFilePreview,
  Message,
  NavId,
  ProjectSession,
  SessionArtifact,
} from '@/kordi-app/types';
import { useDesktopMessageAttention } from '@/features/notifications/useDesktopMessageAttention';
import { extractSessionArtifacts } from '@/features/chat/artifacts';
import { isLocalDraftChatConversationId, isProjectDraftSessionId } from '@/features/chat/draftSessions';
import { EMPTY_CLOUD_SESSION_ACTIVITY, cloudArtifactsForSession, type CloudSessionActivityStore } from '@/features/cloud/cloudSessionActivity';
import { invokeDesktop } from '@/lib/desktop';

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
      tool.artifactPath ?? '',
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

export function activeChatLiveTurnForConversation({
  activeConv,
  desktopLiveTurnsBySession,
}: {
  activeConv: { id: string; canonicalSessionId?: string | null };
  desktopLiveTurnsBySession: Record<string, DesktopChatTurnSnapshot | null | undefined>;
}) {
  const directTurn = desktopLiveTurnsBySession[activeConv.id];
  if (directTurn) return directTurn;
  const canonicalSessionId = activeConv.canonicalSessionId?.trim();
  return canonicalSessionId ? desktopLiveTurnsBySession[canonicalSessionId] ?? null : null;
}

type UseKordiDesktopActivityArgs = {
  activeContactRequestId: string;
  activeSettingsSectionId: SettingsSectionId;
  settingsSections: SettingsSection[];
  contactRequests: ContactRequest[];
  activeNav: NavId;
  activeConvId: string;
  activeConv: { id: string; canonicalSessionId?: string; messages: Message[]; reflectionLessonArtifacts?: SessionArtifact[] };
  activeProjectSessionId: string;
  activeProjectSession: ProjectSession;
  activeConversationUsesCollaboration: boolean;
  isDesktopCollaborationSending: boolean;
  desktopLiveTurnsBySession: Record<string, DesktopChatTurnSnapshot | null | undefined>;
  chatConversations: Conversation[];
  isNativeShell: boolean;
  attentionReady: boolean;
  chatTranscriptScrollRef: MutableRefObject<HTMLElement | null>;
  onOpenNotificationSession: (sessionId: string, messageId: string) => void;
  setVisibleLocalSessionId: (sessionId: string | null) => void;
  setActiveSourcePreview: (value: EditFilePreview | null) => void;
  setActiveArtifactId: (value: string | null) => void;
  setActiveDetailTab: (tab: DetailTab) => void;
  isDetailPanelCollapsed: boolean;
  lastSeenArtifactByContextRef: MutableRefObject<Record<string, string | null>>;
  cloudSessionActivity?: CloudSessionActivityStore;
};

export function useKordiDesktopActivity({
  activeContactRequestId,
  activeSettingsSectionId,
  settingsSections,
  contactRequests,
  activeNav,
  activeConvId,
  activeConv,
  activeProjectSessionId,
  activeProjectSession,
  activeConversationUsesCollaboration,
  isDesktopCollaborationSending,
  desktopLiveTurnsBySession,
  chatConversations,
  isNativeShell,
  attentionReady,
  chatTranscriptScrollRef,
  onOpenNotificationSession,
  setVisibleLocalSessionId,
  setActiveSourcePreview,
  setActiveArtifactId,
  setActiveDetailTab,
  isDetailPanelCollapsed,
  lastSeenArtifactByContextRef,
  cloudSessionActivity = EMPTY_CLOUD_SESSION_ACTIVITY,
}: UseKordiDesktopActivityArgs) {
  const activeContactRequest = contactRequests.find((request) => request.id === activeContactRequestId) ?? contactRequests[0];
  const activeSettingsSection = settingsSections.find((section) => section.id === activeSettingsSectionId) ?? settingsSections[0] as SettingsSection;
  const activeChatLiveTurn = activeChatLiveTurnForConversation({ activeConv, desktopLiveTurnsBySession });
  const activeProjectLiveTurn = activeProjectSession.id ? (desktopLiveTurnsBySession[activeProjectSession.id] ?? null) : null;
  const activeDesktopLiveTurn = activeNav === 'projects' ? activeProjectLiveTurn : activeChatLiveTurn;
  const activeChatArtifactLiveTurn = useArtifactLiveTurn(activeChatLiveTurn);
  const activeProjectArtifactLiveTurn = useArtifactLiveTurn(activeProjectLiveTurn);
  const isDesktopChatSending = activeNav === 'projects'
    ? Boolean(activeProjectLiveTurn && !activeProjectLiveTurn.completed)
    : activeNav === 'chats' && activeConversationUsesCollaboration
      ? isDesktopCollaborationSending || Boolean(activeChatLiveTurn && !activeChatLiveTurn.completed)
      : Boolean(activeChatLiveTurn && !activeChatLiveTurn.completed);

  const activeChatArtifacts = useMemo(() => {
    const cloudArtifacts = cloudArtifactsForSession(cloudSessionActivity, activeConv.canonicalSessionId ?? activeConv.id);
    if (activeConversationUsesCollaboration) return cloudArtifacts;
    return [
      ...cloudArtifacts,
      ...extractSessionArtifacts(activeConv.messages, activeChatArtifactLiveTurn, activeConv.reflectionLessonArtifacts),
    ];
  }, [activeChatArtifactLiveTurn, activeConv.canonicalSessionId, activeConv.id, activeConv.messages, activeConv.reflectionLessonArtifacts, activeConversationUsesCollaboration, cloudSessionActivity]);
  const activeProjectArtifacts = useMemo(
    () => extractSessionArtifacts(activeProjectSession.messages, activeProjectArtifactLiveTurn, activeProjectSession.reflectionLessonArtifacts),
    [activeProjectArtifactLiveTurn, activeProjectSession.messages, activeProjectSession.reflectionLessonArtifacts],
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
    if (!isNativeShell) return;
    void invokeDesktop<void>('desktop_set_menu_bar_unread_count', {
      count: totalUnreadMessages,
    }).catch(() => undefined);
  }, [isNativeShell, totalUnreadMessages]);

  useDesktopMessageAttention({
    isNativeShell,
    attentionReady,
    activeNav,
    activeConversationId: activeConv.id,
    activeCanonicalSessionId: activeConv.canonicalSessionId,
    chatTranscriptScrollRef,
    conversations: chatConversations,
    totalUnreadCount: totalUnreadMessages,
    onOpenSession: onOpenNotificationSession,
  });

  useEffect(() => {
    setVisibleLocalSessionId(visibleLocalSessionIdForActivity({
      activeNav,
      activeChatSessionId: activeConv.id,
      activeChatCanonicalSessionId: activeConv.canonicalSessionId,
      activeProjectSessionId,
    }));
  }, [activeConv.canonicalSessionId, activeConv.id, activeNav, activeProjectSessionId, setVisibleLocalSessionId]);

  useEffect(() => {
    if ((activeNav !== 'chats' && activeNav !== 'projects') || (activeNav === 'chats' && activeConversationUsesCollaboration)) {
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
    activeConversationUsesCollaboration,
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
    activeChatLiveTurn,
    activeProjectLiveTurn,
    activeDesktopLiveTurn,
    isDesktopChatSending,
    activeChatArtifacts,
    activeProjectArtifacts,
  };
}
