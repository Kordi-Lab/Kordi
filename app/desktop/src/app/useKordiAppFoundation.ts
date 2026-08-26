import {
  useMemo,
  useRef,
  useState,
} from 'react';

import { useAppLayoutState } from '@/app/useAppLayoutState';
import { useActiveConversationReadPresentation } from '@/app/useActiveConversationReadPresentation';
import { useAcceptedCloudGroupNavigation } from '@/app/useAcceptedCloudGroupNavigation';
import { projects } from '@/kordi-app/data';
import { useKordiAuthNavigationState } from '@/app/useKordiAuthNavigationState';
import {
  useKordiCanonicalPageHydration,
  useKordiCanonicalSessionStore,
} from '@/app/useKordiCanonicalSessionStore';
import { useKordiCloudAgentActions } from '@/app/useKordiCloudAgentActions';
import { useKordiDefaultCloudAgentRuntimeRoute } from '@/app/useKordiDefaultCloudAgentRuntimeRoute';
import { useCloudAgentRuntimeRouteSync } from '@/app/useCloudAgentRuntimeRouteSync';
import { useClearChatQuote } from '@/app/useClearChatQuote';
import { assignLocalAvatarSeeds, type LocalAvatarSeeds } from '@/app/foundationHelpers';
import { useUnsupportedCollaborationAction } from '@/app/useUnsupportedCollaborationAction';
import {
  isNativeDesktopShell,
} from '@/app/useKordiAppModelHelpers';
import { useKordiLocalUiState } from '@/app/useKordiLocalUiState';
import { useKordiProfileAvatarState } from '@/app/useKordiProfileAvatarState';
import {
  type ParticipantSpaceDraft,
} from '@/app/useKordiParticipantSpaceContinuation';
import { useDesktopAuthState } from '@/features/auth/useDesktopAuthState';
import { buildProjectRoutingGroups } from '@/features/canonical/sessionResolver';
import { useDesktopChatState } from '@/features/chat/useDesktopChatState';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { useComposerViewModel } from '@/features/chat/useComposerViewModel';
import { useDesktopTranscriptAdapter } from '@/features/chat/useDesktopTranscriptAdapter';
import {
  useCloudSession,
  type UseCloudSessionResult,
} from '@/features/cloud/useCloudSession';
import { useCloudCollaborationState } from '@/features/cloud/useCloudCollaborationState';
import { useCloudPresence } from '@/features/cloud/useCloudPresence';
import type { ComposerScope } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type { CloudAccountSettingsTabId } from '@/pages/CloudAccountSettingsDialog';
import { useWorkspaceController } from '@/app/useWorkspaceController';
import { useRefreshCompletedCanonicalSession } from '@/app/useRefreshCompletedCanonicalSession';
export function useKordiAppFoundation({
  cloudSessionOverride,
}: {
  cloudSessionOverride?: UseCloudSessionResult;
} = {}) {
  const isNativeShell = isNativeDesktopShell();
  const liveCloudSession = useCloudSession({ enabled: cloudSessionOverride === undefined });
  const cloudSession = cloudSessionOverride ?? liveCloudSession;
  const cloudPresence = useCloudPresence(cloudSession.account);
  const [cloudAccountDialogTab, setCloudAccountDialogTab] =
    useState<CloudAccountSettingsTabId | null>(null);
  const [cloudAgentRuntimeRoutesBySessionId, setCloudAgentRuntimeRoutesBySessionId] =
    useState<Record<string, DesktopChatMessageRoute>>({});
  // The cloud login gate is owned by KordiAppRoot. By the time this hook is
  // reached the user is past it, so we deliberately don't carry a duplicate
  // cloudSessionStatus / showCloudLoginGate down through the shell.
  const composerControlsRef = useRef<HTMLDivElement | null>(null);
  const chatAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const chatTranscriptScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoFollowChatRef = useRef(true);
  const lastSeenArtifactByContextRef = useRef<Record<string, string | null>>({});
  const {
    store: canonicalStore,
    state: canonicalSessionState,
    setState: setCanonicalSessionState,
    initialRefreshSettled: canonicalInitialRefreshSettled,
    initialRefreshError: canonicalInitialRefreshError,
    resetInitialRefresh: resetCanonicalInitialRefresh,
    hydrateSessionPage: hydrateCanonicalSessionPage,
    loadSessionHistory: loadCanonicalSessionHistory,
    loadOlderSessionMessages: loadOlderCanonicalSessionMessages,
    refreshState: refreshCanonicalState,
  } = useKordiCanonicalSessionStore({
    accountId: cloudSession.account?.accountId ?? null,
    isNativeShell,
  });
  const [locallyHiddenSessionIds, setLocallyHiddenSessionIds] =
    useState<Set<string>>(() => new Set());
  const localAvatarSeedsRef = useRef<LocalAvatarSeeds>({});
  const pendingParticipantSpaceCreateRef = useRef<Map<string, string>>(new Map());
  const participantSpaceDraftByKeyRef =
    useRef<Map<string, ParticipantSpaceDraft>>(new Map());
  const participantSpaceDraftBySessionIdRef =
    useRef<Map<string, ParticipantSpaceDraft>>(new Map());
  const participantSpaceDraftMaterializeRef =
    useRef<Map<string, Promise<void>>>(new Map());
  const [participantSpaceDrafts, setParticipantSpaceDrafts] =
    useState<ParticipantSpaceDraft[]>([]);

  const localUi = useKordiLocalUiState();
  const {
    contactsUi,
    agentsUi,
    projectsUi,
    settingsUi,
    sessionUi,
    composerUi,
    chatsUi,
  } = localUi;

  const {
    desktopAuthState,
    isDesktopAuthLoading,
    desktopAuthError,
    clearDesktopAuthError,
    activeLoginProviderId,
    setActiveLoginProviderId,
    selectAuthProvider,
    refreshDesktopAuth,
    handleLogoutProvider,
    handleSelectAuthChoice,
    handleRemoveAuthProfile,
  } = useDesktopAuthState({
    isNativeShell,
  });

  const { mapDesktopMessages } = useDesktopTranscriptAdapter({ localAvatarSeedsRef });

  const refreshCompletedCanonicalSession = useRefreshCompletedCanonicalSession(
    refreshCanonicalState,
    hydrateCanonicalSessionPage,
  );

  const {
    desktopChatState,
    setDesktopChatState,
    isDesktopChatLoading,
    desktopChatError,
    setDesktopChatError,
    isDesktopChatSending: isDesktopCollaborationSending,
    setIsDesktopChatSending: setIsDesktopCollaborationSending,
    desktopLiveTurnsBySession,
    setDesktopLiveTurnsBySession,
    pendingUserChatMessage,
    setPendingUserChatMessage,
    queuedDesktopMessagesBySession,
    setQueuedDesktopMessagesBySession,
    cachedChatSessionMessages,
    cachedProjectSessionMessages,
    cachedDesktopSessionSourceMessages,
    hydratedDesktopSessionIds,
    localSessionUnreadCounts,
    isDesktopSessionTranscriptCached,
    preloadDesktopSessionTranscript,
    setVisibleLocalSessionId,
    refreshDesktopChat,
    watchDesktopLiveTurn,
  } = useDesktopChatState({
    isNativeShell,
    mapDesktopMessages,
    refreshCanonicalSession: refreshCompletedCanonicalSession,
  });
  const projectRoutingGroups = useMemo(
    () => buildProjectRoutingGroups(desktopChatState?.projects, canonicalSessionState),
    [canonicalSessionState, desktopChatState?.projects],
  );

  const {
    activeNav,
    setActiveNav,
    activeConvId,
    setActiveConvId,
    activeProjectId,
    activeProjectSessionId,
    projectSelectedSessionIds,
    activeDetailTab,
    setActiveDetailTab,
    selectProject,
    selectProjectSession,
  } = useWorkspaceController({
    initialProjects: isNativeShell ? [] : projects,
    projectRoutingGroups,
    isNativeShell,
  });

  const { canMarkRead, setIsTranscriptAtLatest } = useActiveConversationReadPresentation({ activeNav, activeConversationId: activeConvId });
  const {
    visibleSettingsSections,
    visibleActiveSettingsSectionId,
    openCloudAccountAuthentication,
    inlineAuthDialog,
    openAuthSettings,
    openLoginFlow,
    handleCloseInlineAuthDialog,
    dismissAuthGate,
    showAuthGate,
  } = useKordiAuthNavigationState({
    isNativeShell,
    activeNav,
    activeSettingsSectionId: settingsUi.activeSettingsSectionId,
    desktopAuthState,
    isDesktopAuthLoading,
    setActiveNav,
    setActiveSettingsSectionId: settingsUi.setActiveSettingsSectionId,
    setActiveLoginProviderId,
    clearDesktopAuthError,
    setCloudAccountDialogTab,
  });

  // The chat draft key must match the value passed as `activeConvId` to
  // useComposerController. Both sides fall back to the local draft id when the
  // native workspace is still hydrating an active conversation.
  const chatDraftSessionId = activeConvId || LOCAL_DRAFT_CHAT_CONVERSATION_ID;
  const activeChatQuote = composerUi.chatQuoteBySessionId[chatDraftSessionId] ?? null;
  const setChatQuoteBySessionId = composerUi.setChatQuoteBySessionId;
  const onClearChatQuote = useClearChatQuote(
    chatDraftSessionId,
    setChatQuoteBySessionId,
  );
  const composerDraftsView = useMemo<Record<ComposerScope, string>>(() => ({
    chat: composerUi.composerDrafts.chat[chatDraftSessionId]?.text ?? '',
    project:
      composerUi.composerDrafts.project[activeProjectSessionId]?.text ?? '',
  }), [composerUi.composerDrafts, chatDraftSessionId, activeProjectSessionId]);

  const {
    chatModelOptions,
    composerProviderOptions,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    composerAuthByScope,
    chatSlashQuery,
    projectSlashQuery,
    filteredChatSlashCommands,
    filteredProjectSlashCommands,
  } = useComposerViewModel({
    isNativeShell,
    desktopAuthState,
    desktopChatState,
    composerSelections: composerUi.composerSelections,
    composerDrafts: composerDraftsView,
  });

  const defaultCloudAgentRuntimeRoute = useKordiDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId,
    chatModelOptions,
    authOptions: composerAuthByScope.optionsByScope.chat,
    desktopAuthState,
    isNativeShell,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    selectedModel: composerUi.composerSelections.chat.model,
    selectedThinking: composerUi.composerSelections.chat.thinking,
  });

  const {
    settingsContentRef,
    setIsSessionPanelCollapsed,
    isDetailPanelCollapsed,
    setIsDetailPanelCollapsed,
    windowSize,
    sessionRailWidth,
    detailRailWidth,
    settingsRailWidth,
    authSettingsLayoutWidth,
    isLayoutResizing,
    showSessionRail,
    showRightDetailRail,
    showChatDetailRail,
    collapseChatSessions,
    isSingleWorkspacePage,
    leftWorkspaceWidth,
    startWindowResize,
    startPanelResize,
  } = useAppLayoutState({
    activeNav,
    isNativeShell,
  });

  const {
    cloudAgentRuntimeRouteMessages,
    setCloudCollaborationState,
    mergedCollaborationState: desktopCollaborationState,
    prepareCloudForwardAttachments,
    sendCloudCollaborationMessage,
    updateCloudCollaborationSessionTitle,
    sendCloudGroupControl,
    setCloudMessageReaction,
    recordCloudSessionFork,
    updateCloudSessionPin,
    hideCloudSession,
    deleteCloudSession,
    cancelCloudAgentRequest,
    refreshCloudMessages,
    refreshCloudAgents,
    createCloudAgentDefinition,
    updateCloudAgentDefinition,
    archiveCloudAgentDefinition,
    refreshSharedCloudAgents,
    sharedCloudAgents,
    cloudAgentDefinitionsById,
    refreshCloudContacts,
    cloudContacts,
    cloudSessionActivity,
    initialContactsSettled,
    initialMessagesSettled,
    cachedMessagesReady,
    cloudHiddenSessionIds,
    cloudDeletedSessionIds,
    cloudSessionPinsById,
    cloudLegacyGroupSessionTitlesById,
  } = useCloudCollaborationState({
    account: cloudSession.account,
    activeConversationId: activeConvId,
    canMarkActiveConversationRead: canMarkRead,
    canonicalSessionState,
    setCanonicalSessionState,
    localTurnsBySessionId: desktopLiveTurnsBySession,
    cloudAgentRuntimeRoutesBySessionId,
    defaultCloudAgentRuntimeRoute,
    defaultCloudAgentRuntimeReady:
      !isDesktopAuthLoading && Boolean(defaultCloudAgentRuntimeRoute),
    desktopAuthState,
  });

  const {
    inheritCloudAgentRuntimeRoute,
    publishCloudAgentRuntimeRouteChange,
    resolveChatRuntimeRoute,
  } = useCloudAgentRuntimeRouteSync({
    accountId: cloudSession.account?.accountId,
    activeConversationId: activeConvId,
    activeLoginProviderId,
    canonicalSessionState,
    chatModelOptions,
    cloudAgentRuntimeRouteMessages,
    composerAuthByScope,
    composerUi,
    defaultCloudAgentRuntimeRoute,
    desktopAuthState,
    isNativeShell,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    routesBySessionId: cloudAgentRuntimeRoutesBySessionId,
    sendCloudCollaborationMessage,
    setRoutesBySessionId: setCloudAgentRuntimeRoutesBySessionId,
    updateCloudCollaborationSessionTitle,
  });

  useAcceptedCloudGroupNavigation({
    refreshCloudMessages,
    setActiveConversationId: setActiveConvId,
    setActiveNavigation: setActiveNav,
    setDesktopChatError,
  });

  // The desktop collaboration read model is derived only from hosted Cloud data.
  const isCollaborationSyncing = false;
  const lastCollaborationSyncAt = null;

  const unsupportedLegacyCollaborationAction = useUnsupportedCollaborationAction(
    setDesktopChatError,
  );

  const {
    localProfileAvatarSeed,
    localProfileDisplayName,
    localProfileImageUrl,
    localAgentAvatarSeed,
    localAgentDisplayName,
  } = useKordiProfileAvatarState({
    account: cloudSession.account,
    canonicalState: canonicalSessionState,
    collaborationState: desktopCollaborationState,
  });
  const syncLocalAvatarSeeds = (seeds: LocalAvatarSeeds) =>
    assignLocalAvatarSeeds(localAvatarSeedsRef, seeds);
  useKordiCanonicalPageHydration({
    activeConversationId: activeConvId,
    activeProjectSessionId,
    collaborationState: desktopCollaborationState,
    hydrateSessionPage: hydrateCanonicalSessionPage,
    isNativeShell,
    store: canonicalStore,
  });

  const {
    archiveCloudAgent: handleArchiveCloudAgent,
    createCloudAgent: handleCreateCloudAgent,
    updateCloudAgent: handleUpdateCloudAgent,
  } = useKordiCloudAgentActions({
    archiveCloudAgentDefinition,
    createCloudAgentDefinition,
    refreshCloudAgents,
    setActiveAgentId: agentsUi.setActiveAgentId,
    updateCloudAgentDefinition,
  });

  return {
    environment: {
      isNativeShell, cloudSession, cloudPresence,
      cloudAccountDialogTab, setCloudAccountDialogTab,
    },
    refs: {
      composerControlsRef, chatAttachmentInputRef, chatTranscriptScrollRef,
      shouldAutoFollowChatRef, lastSeenArtifactByContextRef,
      setChatTranscriptAtLatest: setIsTranscriptAtLatest,
      syncLocalAvatarSeeds,
    },
    canonical: {
      canonicalStore, canonicalSessionState, setCanonicalSessionState,
      canonicalInitialRefreshSettled, canonicalInitialRefreshError,
      resetCanonicalInitialRefresh, hydrateCanonicalSessionPage,
      loadCanonicalSessionHistory,
      loadOlderCanonicalSessionMessages, refreshCanonicalState,
    },
    participants: {
      locallyHiddenSessionIds, setLocallyHiddenSessionIds,
      pendingParticipantSpaceCreateRef, participantSpaceDraftByKeyRef,
      participantSpaceDraftBySessionIdRef, participantSpaceDraftMaterializeRef,
      participantSpaceDrafts, setParticipantSpaceDrafts,
    },
    ui: {
      contactsUi, agentsUi, projectsUi, settingsUi,
      sessionUi, composerUi, chatsUi,
    },
    auth: {
      desktopAuthState, isDesktopAuthLoading, desktopAuthError,
      activeLoginProviderId, selectAuthProvider, refreshDesktopAuth,
      handleLogoutProvider, handleSelectAuthChoice, handleRemoveAuthProfile,
    },
    chat: {
      desktopChatState, setDesktopChatState, isDesktopChatLoading,
      desktopChatError, setDesktopChatError,
      isDesktopCollaborationSending, setIsDesktopCollaborationSending,
      desktopLiveTurnsBySession, setDesktopLiveTurnsBySession,
      pendingUserChatMessage, setPendingUserChatMessage,
      queuedDesktopMessagesBySession, setQueuedDesktopMessagesBySession,
      cachedChatSessionMessages, cachedProjectSessionMessages,
      cachedDesktopSessionSourceMessages,
      hydratedDesktopSessionIds,
      localSessionUnreadCounts, isDesktopSessionTranscriptCached,
      preloadDesktopSessionTranscript, setVisibleLocalSessionId,
      refreshDesktopChat, watchDesktopLiveTurn, mapDesktopMessages,
    },
    navigation: {
      activeNav, setActiveNav, activeConvId, setActiveConvId,
      activeProjectId, activeProjectSessionId, projectSelectedSessionIds,
      activeDetailTab, setActiveDetailTab, selectProject, selectProjectSession,
    },
    authNavigation: {
      visibleSettingsSections, visibleActiveSettingsSectionId,
      openCloudAccountAuthentication, inlineAuthDialog,
      openAuthSettings, openLoginFlow, handleCloseInlineAuthDialog,
      dismissAuthGate, showAuthGate,
    },
    composer: {
      chatDraftSessionId, activeChatQuote, onClearChatQuote,
      composerDraftsView, chatModelOptions, composerProviderOptions,
      defaultCloudAgentRuntimeRoute,
      preferredModelValueForProvider, resolveComposerProviderId,
      composerAuthByScope, chatSlashQuery, projectSlashQuery,
      filteredChatSlashCommands, filteredProjectSlashCommands,
    },
    layout: {
      settingsContentRef, setIsSessionPanelCollapsed,
      isDetailPanelCollapsed, setIsDetailPanelCollapsed,
      windowSize, sessionRailWidth, detailRailWidth, settingsRailWidth,
      authSettingsLayoutWidth, isLayoutResizing, showSessionRail,
      showRightDetailRail, showChatDetailRail, collapseChatSessions,
      isSingleWorkspacePage, leftWorkspaceWidth,
      startWindowResize, startPanelResize,
    },
    cloud: {
      setCloudCollaborationState, desktopCollaborationState,
      prepareCloudForwardAttachments, sendCloudCollaborationMessage,
      sendCloudGroupControl, setCloudMessageReaction, recordCloudSessionFork, updateCloudSessionPin,
      hideCloudSession, deleteCloudSession, cancelCloudAgentRequest,
      refreshCloudMessages, refreshSharedCloudAgents, sharedCloudAgents,
      cloudAgentDefinitionsById, refreshCloudContacts, cloudContacts,
      cloudSessionActivity, initialContactsSettled, initialMessagesSettled,
      cachedMessagesReady, cloudHiddenSessionIds, cloudDeletedSessionIds,
      cloudSessionPinsById,
      cloudLegacyGroupSessionTitlesById,
      isCollaborationSyncing, lastCollaborationSyncAt,
      unsupportedLegacyCollaborationAction,
      setCloudAgentRuntimeRoutesBySessionId,
      resolveChatRuntimeRoute,
      inheritCloudAgentRuntimeRoute,
      publishCloudAgentRuntimeRouteChange,
    },
    profile: {
      localProfileAvatarSeed, localProfileDisplayName, localProfileImageUrl,
      localAgentAvatarSeed, localAgentDisplayName,
    },
    cloudAgentActions: {
      handleArchiveCloudAgent, handleCreateCloudAgent, handleUpdateCloudAgent,
    },
  };
}

export type KordiAppFoundation = ReturnType<typeof useKordiAppFoundation>;
