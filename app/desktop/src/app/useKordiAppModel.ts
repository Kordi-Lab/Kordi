import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authStateHasChatReadyProvider, authStateSatisfiesStartupGate, buildAuthDisplayProviders, normalizeSelectedProviderId } from '@/kordi-app/auth/model';
import {
  contactRequests as demoContactRequests,
  normalizeNavIdForCloud,
  normalizeSettingsSectionIdForCloud,
  projects,
  settingsSections,
} from '@/kordi-app/data';
import { assembleKordiShellSlots } from '@/app/assembleKordiShellSlots';
import { useAppLayoutState } from '@/app/useAppLayoutState';
import { useKordiDesktopActivity } from '@/app/useKordiDesktopActivity';
import { useKordiLocalUiState } from '@/app/useKordiLocalUiState';
import { useKordiShellArgs } from '@/app/useKordiShellArgs';
import { useKordiShellViewModel } from '@/app/useKordiShellViewModel';
import { useKordiUiEffects } from '@/app/useKordiUiEffects';
import { useWorkspaceViewModels } from '@/app/useWorkspaceViewModels';
import { useWorkspaceController } from '@/app/useWorkspaceController';
import type { CloudAccountSettingsTabId } from '@/pages/CloudAccountSettingsDialog';
import { useDesktopAuthState } from '@/features/auth/useDesktopAuthState';
import { useDesktopAuthUiState } from '@/features/auth/useDesktopAuthUiState';
import { resolveCloudLocalProfileAvatar } from '@/features/cloud/avatar';
import { cloudAgentDefinitionToAgent } from '@/features/cloud/cloudAgents';
import type { CreateCloudAgentInput, UpdateCloudAgentInput } from '@/features/cloud/cloudAgentsClient';
import {
  type CloudGroupParticipant,
  cloudGroupParticipantsForCollaborationSession,
  cloudGroupSelfParticipant,
  cloudGroupTargetAccountIds,
} from '@/features/cloud/cloudGroupMessages';
import { CLOUD_INITIAL_SYNC_TIMEOUT_MS, canonicalStateHasCloudLocalBackup, cloudInitialSyncStatus } from '@/features/cloud/initialSync';
import { useCloudSession, type UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { useCloudCollaborationState } from '@/features/cloud/useCloudCollaborationState';
import { useCloudPresence } from '@/features/cloud/useCloudPresence';
import { cloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentRuntime';
import { cloudCollaborationConversationId, isCloudCollaborationHostId } from '@/features/cloud/cloudCollaborationState';
import { CLOUD_HOST_SENTINEL } from '@/features/cloud/useCloudContacts';
import {
  buildProjectRoutingGroups,
} from '@/features/canonical/sessionResolver';
import { useDesktopChatState } from '@/features/chat/useDesktopChatState';
import { useComposerController } from '@/features/chat/useComposerController';
import { useComposerViewModel } from '@/features/chat/useComposerViewModel';
import { mentionScopeConversationForActiveConversation } from '@/features/chat/messageActions/mentions';
import {
  buildChatCreatePeopleContactLookup,
  buildChatGroupCollaborationUpdateParticipants,
  buildChatGroupCollaborationUpdateTargets,
  existingBlankSessionIdForParticipantSpace,
} from '@/features/chat/chatCreateFlows';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { updateScopeDraft } from '@/features/chat/composerDrafts';
import { CHAT_COMPOSER_TEXTAREA_SELECTOR, focusComposerTextareaForNativeInput } from '@/features/chat/composerController.shared';
import { sendChatMessageWithImmediateQuoteClear } from '@/features/chat/composerQuoteClear';
import { removeQueuedDesktopMessageById } from '@/features/chat/queuedDesktopMessages';
import { useDesktopSessionController } from '@/features/chat/useDesktopSessionController';
import { useDesktopTranscriptAdapter } from '@/features/chat/useDesktopTranscriptAdapter';
import { buildCollaborationMentionTargetsByScope, mentionableCloudAgentSummaries, sharedCloudAgentOwnerIdsForMentionScope } from '@/app/useKordiAppModelCollaborationMentions';
import { setLocalAgentAvatarSeed, setLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { collaborationContactRequestsForContactsPage } from '@/app/viewModels/helpers';
import type { Agent, CanonicalSessionState, ComposerScope, DesktopCollaborationProject, DesktopChatState } from '@/kordi-app/types';
import type { DesktopChatContextMessage, DesktopChatMessageRoute } from '@/lib/desktop';
import {
  createDesktopChatSession,
  openOrCreateCanonicalSessionFast,
  updateCanonicalSessionMetadata,
} from '@/lib/desktop';

import {
  activeGroupAdminIds,
  canonicalAvatarSeed,
  canonicalGroupParticipantsForSession,
  canonicalIdentityDisplayName,
  canonicalLocalAgentAvatarSeed,
  canonicalProfileImageUrl,
  currentMentionQuery,
  filterMentionTargets,
  groupRenameMetadata,
  isNativeDesktopShell,
  metadataGroupSpaceId,
  metadataString,
  participantSpaceCreateKey,
  sessionMetadataRecord,
  uniqueStrings,
} from '@/app/useKordiAppModelHelpers';
import { useKordiMessageActions } from '@/app/useKordiMessageActions';
import {
  useKordiCanonicalPageHydration,
  useKordiCanonicalSessionStore,
} from '@/app/useKordiCanonicalSessionStore';
import {
  appendCanonicalRenameNotice,
  useKordiChatSessionActions,
} from '@/app/useKordiChatSessionActions';
import { useKordiProjectActions } from '@/app/useKordiProjectActions';
import { useKordiChatStartActions } from '@/app/useKordiChatStartActions';
import {
  mergeOpenCanonicalSessionResult,
} from '@/app/canonicalSessionStateMutations';
import { useKordiGroupCreation } from '@/app/useKordiGroupCreation';
import { useKordiGroupMemberInvites } from '@/app/useKordiGroupMemberInvites';
import { useKordiGroupMemberRoles } from '@/app/useKordiGroupMemberRoles';
import {
  type ParticipantSpaceDraft,
  useKordiParticipantSpaceContinuation,
} from '@/app/useKordiParticipantSpaceContinuation';

export function useKordiAppModel({
  cloudSessionOverride,
}: {
  cloudSessionOverride?: UseCloudSessionResult;
} = {}) {
  const isNativeShell = isNativeDesktopShell();
  const liveCloudSession = useCloudSession({ enabled: cloudSessionOverride === undefined });
  const cloudSession = cloudSessionOverride ?? liveCloudSession;
  const cloudPresence = useCloudPresence(cloudSession.account);
  const [cloudAccountDialogTab, setCloudAccountDialogTab] = useState<CloudAccountSettingsTabId | null>(null);
  const [cloudAgentRuntimeRoutesBySessionId, setCloudAgentRuntimeRoutesBySessionId] = useState<Record<string, DesktopChatMessageRoute>>({});
  // The cloud login gate is owned by KordiAppRoot. By the time this hook is
  // reached the user is past it, so we deliberately don't carry a duplicate
  // cloudSessionStatus / showCloudLoginGate down through the shell.
  const composerControlsRef = useRef<HTMLDivElement | null>(null);
  const chatAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const chatTranscriptScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoFollowChatRef = useRef(true);
  const lastSeenArtifactByContextRef = useRef<Record<string, string | null>>({});
  const lastAutoAuthProviderSwitchRef = useRef<string | null>(null);
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
  const [cloudInitialSyncStartedAt, setCloudInitialSyncStartedAt] = useState(() => Date.now());
  const [cloudInitialSyncNow, setCloudInitialSyncNow] = useState(() => Date.now());
  const completedCloudInitialSyncAccountRef = useRef<string | null>(null);

  useEffect(() => {
    const now = Date.now();
    setCloudInitialSyncStartedAt(now);
    setCloudInitialSyncNow(now);
  }, [cloudSession.account?.accountId]);
  const [locallyHiddenSessionIds, setLocallyHiddenSessionIds] = useState<Set<string>>(() => new Set());
  const localAvatarSeedsRef = useRef<{ human?: string | null; humanDisplayName?: string | null; humanProfileImageUrl?: string | null; agent?: string | null; agentDisplayName?: string | null }>({});
  const pendingParticipantSpaceCreateRef = useRef<Map<string, string>>(new Map());
  const participantSpaceDraftByKeyRef = useRef<Map<string, ParticipantSpaceDraft>>(new Map());
  const participantSpaceDraftBySessionIdRef = useRef<Map<string, ParticipantSpaceDraft>>(new Map());
  const participantSpaceDraftMaterializeRef = useRef<Map<string, Promise<void>>>(new Map());
  const [participantSpaceDrafts, setParticipantSpaceDrafts] = useState<ParticipantSpaceDraft[]>([]);

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
    localSessionUnreadCounts,
    setVisibleLocalSessionId,
    refreshDesktopChat,
    watchDesktopLiveTurn,
  } = useDesktopChatState({
    isNativeShell,
    mapDesktopMessages,
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

  const visibleSettingsSections = settingsSections;
  const visibleActiveSettingsSectionId = normalizeSettingsSectionIdForCloud(settingsUi.activeSettingsSectionId);

  useEffect(() => {
    const nextActiveNav = normalizeNavIdForCloud(activeNav);
    if (nextActiveNav !== activeNav) setActiveNav(nextActiveNav);
  }, [activeNav, setActiveNav]);

  useEffect(() => {
    if (visibleActiveSettingsSectionId !== settingsUi.activeSettingsSectionId) {
      settingsUi.setActiveSettingsSectionId(visibleActiveSettingsSectionId);
    }
  }, [settingsUi.activeSettingsSectionId, settingsUi.setActiveSettingsSectionId, visibleActiveSettingsSectionId]);

  const startupGateSatisfied = useMemo(
    () => authStateSatisfiesStartupGate(desktopAuthState),
    [desktopAuthState],
  );

  const openCloudAccountAuthentication = useCallback(() => {
    setCloudAccountDialogTab('auth');
    clearDesktopAuthError();
  }, [clearDesktopAuthError]);

  const {
    inlineAuthDialog,
    openAuthSettings,
    openLoginFlow,
    handleCloseInlineAuthDialog,
    dismissAuthGate,
    showAuthGate,
  } = useDesktopAuthUiState({
    isNativeShell,
    activeNav,
    activeSettingsSectionId: visibleActiveSettingsSectionId,
    desktopAuthState,
    isDesktopAuthLoading,
    startupGateSatisfied,
    setActiveNav,
    setActiveSettingsSectionId: settingsUi.setActiveSettingsSectionId,
    setActiveLoginProviderId,
    clearDesktopAuthError,
    openAuthSurface: openCloudAccountAuthentication,
  });

  // The chat draft key must match the value passed as `activeConvId` to
  // useComposerController below (see the wiring at the useComposerController
  // call site). Both sides fall back to LOCAL_DRAFT_CHAT_CONVERSATION_ID when
  // the raw activeConvId state is empty — otherwise reads land at chat['']
  // (undefined) while writes land at chat[<resolved id>], every keystroke is
  // dropped silently, and the composer looks unresponsive until the user
  // switches sessions and back. activeConvId is initialized to '' on native
  // shell (useWorkspaceController.ts) and can also be transiently empty
  // after certain session-rename flows.
  const chatDraftSessionId = activeConvId || LOCAL_DRAFT_CHAT_CONVERSATION_ID;
  const activeChatQuote = composerUi.chatQuoteBySessionId[chatDraftSessionId] ?? null;
  const onClearChatQuote = useCallback(() => {
    composerUi.setChatQuoteBySessionId((current) => ({ ...current, [chatDraftSessionId]: null }));
  }, [chatDraftSessionId, composerUi.setChatQuoteBySessionId]);
  const composerDraftsView = useMemo<Record<ComposerScope, string>>(() => ({
    chat:    composerUi.composerDrafts.chat[chatDraftSessionId]?.text          ?? '',
    project: composerUi.composerDrafts.project[activeProjectSessionId]?.text   ?? '',
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

  const defaultCloudAgentRuntimeRoute = useMemo<DesktopChatMessageRoute | null>(() => {
    if (!isNativeShell) return null;
    const authProviders = buildAuthDisplayProviders(desktopAuthState);
    const chatModel = composerUi.composerSelections.chat.model?.trim() || '';
    const selectedProviderId = chatModel ? resolveComposerProviderId('chat', chatModel) : null;
    const normalizedSelectedProviderId = normalizeSelectedProviderId(selectedProviderId) ?? selectedProviderId;
    const selectedProvider = normalizedSelectedProviderId
      ? authProviders.find((provider) => provider.id === normalizedSelectedProviderId)
      : null;
    const selectedModelIsAvailable = chatModelOptions.some((option) => option.value === chatModel);

    let routeModel: string | null = selectedProvider?.configured && selectedModelIsAvailable ? chatModel : null;
    let routeProviderId: string | null = selectedProvider?.configured ? selectedProviderId : null;

    if (!routeModel) {
      const normalizedActiveProviderId = normalizeSelectedProviderId(activeLoginProviderId);
      const fallbackProvider = authProviders.find((provider) => provider.configured && provider.id === normalizedActiveProviderId)
        ?? authProviders.find((provider) => provider.configured && provider.methods.some((method) => method.options.some((option) => option.active)))
        ?? authProviders.find((provider) => provider.configured)
        ?? null;
      routeProviderId = fallbackProvider?.id ?? null;
      routeModel = routeProviderId ? preferredModelValueForProvider(routeProviderId) : null;
    }

    if (!routeModel) return null;

    const modelProviderId = routeProviderId ?? routeModel.split('/')[0] ?? null;
    const normalizedModelProviderId = normalizeSelectedProviderId(modelProviderId) ?? modelProviderId;
    const authOption = composerAuthByScope.optionsByScope.chat.find((option) => (
      (normalizeSelectedProviderId(option.providerId) ?? option.providerId) === normalizedModelProviderId
      && option.active
    )) ?? composerAuthByScope.optionsByScope.chat.find((option) => (
      (normalizeSelectedProviderId(option.providerId) ?? option.providerId) === normalizedModelProviderId
    )) ?? null;

    return {
      model: routeModel,
      authProvider: authOption?.providerId ?? routeProviderId,
      authChoice: authOption?.value ?? null,
      thinking: composerUi.composerSelections.chat.thinking ?? null,
    };
  }, [
    activeLoginProviderId,
    chatModelOptions,
    composerAuthByScope.optionsByScope.chat,
    composerUi.composerSelections.chat.model,
    composerUi.composerSelections.chat.thinking,
    desktopAuthState,
    isNativeShell,
    preferredModelValueForProvider,
    resolveComposerProviderId,
  ]);

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
    setCloudCollaborationState,
    mergedCollaborationState: desktopCollaborationState,
    prepareCloudForwardAttachments,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
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
    cloudSelfAgentSyncStatusBySessionId,
  } = useCloudCollaborationState({
    account: cloudSession.account,
    activeConversationId: activeConvId,
    canonicalSessionState,
    setCanonicalSessionState,
    cloudAgentRuntimeRoutesBySessionId,
    defaultCloudAgentRuntimeRoute,
  });

  // The desktop collaboration read model is derived only from hosted Cloud data.
  const setDesktopCollaborationState = setCloudCollaborationState;
  const isCollaborationSyncing = false;
  const lastCollaborationSyncAt = null;

  const unsupportedLegacyCollaborationAction = useCallback(async (..._args: unknown[]) => {
    const message = 'This connection action is unavailable.';
    setDesktopChatError(message);
    throw new Error(message);
  }, [setDesktopChatError]);

  const avatarCollaborationHost = desktopCollaborationState?.hosts.find((host) => host.id === desktopCollaborationState.activeHostId)
    ?? desktopCollaborationState?.hosts[0]
    ?? null;
  const avatarCollaborationHostAgentId = avatarCollaborationHost?.activeAgentId ?? null;
  const avatarCollaborationAgent = avatarCollaborationHost?.agents.find((agent) => agent.id === avatarCollaborationHostAgentId)
    ?? avatarCollaborationHost?.agents.find((agent) => agent.isActive)
    ?? avatarCollaborationHost?.agents.find((agent) => agent.isDefault)
    ?? avatarCollaborationHost?.agents[0]
    ?? null;
  const canonicalLocalProfileAvatarSeed = canonicalAvatarSeed(canonicalSessionState, canonicalSessionState?.profile.humanIdentityId)
    || avatarCollaborationHost?.humanId?.trim()
    || canonicalSessionState?.profile.id?.trim()
    || null;
  const canonicalLocalProfileImageUrl = canonicalProfileImageUrl(canonicalSessionState, canonicalSessionState?.profile.humanIdentityId)
    || avatarCollaborationHost?.profileImageUrl?.trim()
    || null;
  const cloudLocalProfileAvatar = resolveCloudLocalProfileAvatar({
    accountId: cloudSession.account?.accountId,
    avatarUrl: cloudSession.account?.avatarUrl,
    canonicalAvatarSeed: canonicalLocalProfileAvatarSeed,
    canonicalProfileImageUrl: canonicalLocalProfileImageUrl,
  });
  const localProfileAvatarSeed = cloudLocalProfileAvatar?.seed ?? canonicalLocalProfileAvatarSeed;
  const localProfileImageUrl = cloudLocalProfileAvatar?.imageUrl ?? canonicalLocalProfileImageUrl;
  const localProfileDisplayName = cloudSession.account?.displayName?.trim()
    || canonicalIdentityDisplayName(canonicalSessionState, canonicalSessionState?.profile.humanIdentityId)?.trim()
    || avatarCollaborationHost?.ownerName?.trim()
    || null;
  const localAgentIdentity = canonicalSessionState?.identities.find((identity) => (
    identity.kind === 'agent'
    && identity.id === canonicalSessionState.profile.activeAgentIdentityId
  )) ?? canonicalSessionState?.identities.find((identity) => (
    identity.kind === 'agent'
    && identity.source === 'local'
    && identity.ownerIdentityId === canonicalSessionState.profile.humanIdentityId
  ));
  const localAgentDisplayName = localAgentIdentity?.displayName?.trim()
    || avatarCollaborationAgent?.label?.trim()
    || avatarCollaborationHost?.displayName?.trim()
    || null;
  const localAgentAvatarSeed = canonicalLocalAgentAvatarSeed(canonicalSessionState)
    || avatarCollaborationAgent?.id?.trim()
    || avatarCollaborationHost?.activeAgentId?.trim()
    || avatarCollaborationAgent?.nodeId?.trim()
    || avatarCollaborationHost?.nodeId?.trim()
    || null;
  localAvatarSeedsRef.current.human = localProfileAvatarSeed;
  localAvatarSeedsRef.current.humanDisplayName = localProfileDisplayName;
  localAvatarSeedsRef.current.humanProfileImageUrl = localProfileImageUrl;
  localAvatarSeedsRef.current.agent = localAgentAvatarSeed;
  localAvatarSeedsRef.current.agentDisplayName = localAgentDisplayName;

  useKordiCanonicalPageHydration({
    activeConversationId: activeConvId,
    activeProjectSessionId,
    collaborationState: desktopCollaborationState,
    hydrateSessionPage: hydrateCanonicalSessionPage,
    isNativeShell,
    store: canonicalStore,
  });

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setCloudInitialSyncNow(Date.now());
    }, CLOUD_INITIAL_SYNC_TIMEOUT_MS + 25);
    return () => window.clearTimeout(timeoutId);
  }, [cloudInitialSyncStartedAt]);

  const retryCloudInitialSync = useCallback(() => {
    resetCanonicalInitialRefresh();
    const now = Date.now();
    setCloudInitialSyncStartedAt(now);
    setCloudInitialSyncNow(now);
    void refreshCanonicalState();
    void refreshCloudContacts();
    void refreshCloudMessages();
  }, [
    refreshCanonicalState,
    refreshCloudMessages,
    refreshCloudContacts,
    resetCanonicalInitialRefresh,
  ]);

  const handleCreateCloudAgent = useCallback(async (input: CreateCloudAgentInput) => {
    const definition = await createCloudAgentDefinition(input);
    await refreshCloudAgents().catch(() => undefined);
    const agent = cloudAgentDefinitionToAgent(definition);
    agentsUi.setActiveAgentId(agent.id);
    return agent;
  }, [agentsUi, createCloudAgentDefinition, refreshCloudAgents]);

  const handleUpdateCloudAgent = useCallback(async (agent: Agent, input: UpdateCloudAgentInput) => {
    if (!agent.cloudAgentId) throw new Error('Only Cloud Agents can be updated here.');
    const definition = await updateCloudAgentDefinition(agent.cloudAgentId, input);
    await refreshCloudAgents().catch(() => undefined);
    const nextAgent = cloudAgentDefinitionToAgent(definition);
    agentsUi.setActiveAgentId(nextAgent.id);
    return nextAgent;
  }, [agentsUi, refreshCloudAgents, updateCloudAgentDefinition]);

  const handleArchiveCloudAgent = useCallback(async (agent: Agent) => {
    if (!agent.cloudAgentId) throw new Error('Only private Cloud Agents can be deleted here.');
    await archiveCloudAgentDefinition(agent.cloudAgentId);
    await refreshCloudAgents().catch(() => undefined);
    agentsUi.setActiveAgentId((current) => (current === agent.id ? 'desktop:local-agent' : current));
  }, [agentsUi, archiveCloudAgentDefinition, refreshCloudAgents]);

  const combinedHiddenSessionIds = useMemo(() => new Set([
    ...locallyHiddenSessionIds,
    ...cloudHiddenSessionIds,
    ...cloudDeletedSessionIds,
  ]), [cloudDeletedSessionIds, cloudHiddenSessionIds, locallyHiddenSessionIds]);
  const transientChatConversations = useMemo(
    () => participantSpaceDrafts.map((draft) => draft.conversation),
    [participantSpaceDrafts],
  );

  const {
    chatConversations,
    filteredConversations,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    activeConv,
    activeConversationUsesCollaboration,
    activeLastMessage,
    activeConvHasSubtitle,
    displayedContacts,
    addableContacts,
    displayedAgents,
    groupedContacts,
    filteredGroupedContacts,
    activeContact,
    activeAgent,
    runtimeProjects,
    filteredProjects,
    activeProject,
    activeProjectSession,
    activeProjectLastMessage,
    activeCollaborationHost,
    activeCollaborationConversation,
    activeCollaborationConversationHost,
    activeCollaborationAwaitingReply,
  } = useWorkspaceViewModels({
    isNativeShell,
    isDesktopChatLoading,
    desktopChatState,
    desktopCollaborationState,
    canonicalSessionState,
    canonicalSessionSummaries: canonicalStore.catalog?.summaries,
    canonicalHydrationBySessionId: canonicalStore.hydrationBySessionId,
    hiddenSessionIds: combinedHiddenSessionIds,
    projectWorkspaces: projectsUi.projectWorkspaces,
    projectSelectedSessionIds,
    activeNav,
    activeConvId,
    activeProjectId,
    activeProjectSessionId,
    chatSearch: chatsUi.chatSearch,
    projectSearch: projectsUi.projectSearch,
    contactSearch: contactsUi.contactSearch,
    activeContactId: contactsUi.activeContactId,
    activeAgentId: agentsUi.activeAgentId,
    cachedChatSessionMessages,
    cachedProjectSessionMessages,
    localSessionUnreadCounts,
    desktopLiveTurnsBySession,
    mapDesktopMessages,
    cloudSessionActivity,
    cloudAgentDefinitionsById,
    cloudPresence: cloudPresence.snapshot,
    cloudUnreadReady: initialMessagesSettled,
    transientChatConversations,
  });

  const {
    activeMessageSelection,
    selectedMessageIds,
    selectedMessageCount,
    onReplyMessage,
    onForwardMessage,
    onSelectMessage,
    isMessageSelectable,
    onToggleSelectedMessage,
    onSelectionDragStart,
    onSelectionDragEnter,
    onSelectionDragEnd,
    onCancelMessageSelection,
    onCopySelectedMessages,
    onForwardSelectedMessages,
    messageForwardDialog,
  } = useKordiMessageActions({
    activeConversation: activeConv,
    conversations: chatConversations,
    draftSessionId: chatDraftSessionId,
    isNativeShell,
    transcriptScrollRef: chatTranscriptScrollRef,
    setActiveConversationId: setActiveConvId,
    setDesktopChatError,
    setChatQuoteBySessionId: composerUi.setChatQuoteBySessionId,
    canonicalState: canonicalSessionState,
    setCanonicalState: setCanonicalSessionState,
    account: cloudSession.account,
    collaborationState: desktopCollaborationState,
    cloudTransport: {
      prepareCloudForwardAttachments,
      sendCloudCollaborationMessage,
      sendCloudGroupControl,
    },
  });

  const activeConvMentionScope = useMemo(
    () => mentionScopeConversationForActiveConversation(activeConv, chatConversations),
    [activeConv, chatConversations],
  );

  const sharedCloudAgentOwnerIds = useMemo(() => sharedCloudAgentOwnerIdsForMentionScope(
    activeConvMentionScope,
    cloudSession.account?.accountId,
  ), [activeConvMentionScope, cloudSession.account?.accountId]);

  useEffect(() => {
    void refreshSharedCloudAgents(sharedCloudAgentOwnerIds).catch(() => undefined);
  }, [refreshSharedCloudAgents, sharedCloudAgentOwnerIds]);

  const mentionableCloudAgents = useMemo(() => mentionableCloudAgentSummaries({
    sharedCloudAgents,
    ownedCloudAgentsById: cloudAgentDefinitionsById,
    ownerDisplayName: cloudSession.account?.displayName?.trim()
      || cloudSession.account?.primaryEmail?.trim()
      || null,
  }), [cloudAgentDefinitionsById, cloudSession.account?.displayName, cloudSession.account?.primaryEmail, sharedCloudAgents]);

  const resolveSharedCloudAgentsForMention = useCallback(async () => {
    const refreshed = await refreshSharedCloudAgents(sharedCloudAgentOwnerIds).catch(() => []);
    return mentionableCloudAgentSummaries({
      sharedCloudAgents: [...sharedCloudAgents, ...refreshed],
      ownedCloudAgentsById: cloudAgentDefinitionsById,
      ownerDisplayName: cloudSession.account?.displayName?.trim()
        || cloudSession.account?.primaryEmail?.trim()
        || null,
    });
  }, [cloudAgentDefinitionsById, cloudSession.account?.displayName, cloudSession.account?.primaryEmail, refreshSharedCloudAgents, sharedCloudAgentOwnerIds, sharedCloudAgents]);

  const collaborationMentionTargetsByScope = useMemo(() => buildCollaborationMentionTargetsByScope({
    isNativeShell,
    desktopCollaborationState,
    desktopChatState,
    activeConvMentionScope,
    conversations: chatConversations,
    sharedCloudAgents: mentionableCloudAgents,
  }), [activeConvMentionScope, chatConversations, desktopCollaborationState, desktopChatState, isNativeShell, mentionableCloudAgents]);

  const chatMentionQuery = useMemo(() => currentMentionQuery(composerDraftsView.chat), [composerDraftsView.chat]);
  const projectMentionQuery = useMemo(() => currentMentionQuery(composerDraftsView.project), [composerDraftsView.project]);
  const filteredChatMentionTargets = useMemo(() => filterMentionTargets(collaborationMentionTargetsByScope.chat, chatMentionQuery), [collaborationMentionTargetsByScope.chat, chatMentionQuery]);
  const filteredProjectMentionTargets = useMemo(() => filterMentionTargets(collaborationMentionTargetsByScope.project, projectMentionQuery), [collaborationMentionTargetsByScope.project, projectMentionQuery]);

  useEffect(() => {
    for (const [spaceKey, sessionId] of pendingParticipantSpaceCreateRef.current) {
      const space = participantSpaces.find((candidate) => participantSpaceCreateKey(candidate) === spaceKey);
      const pendingSessionIsVisible = space?.sessions.some((session) => session.id === sessionId || session.canonicalSessionId === sessionId);
      if (!space || existingBlankSessionIdForParticipantSpace(space) || pendingSessionIsVisible) {
        pendingParticipantSpaceCreateRef.current.delete(spaceKey);
      }
    }
  }, [participantSpaces]);

  useEffect(() => {
    if (!cloudLocalProfileAvatar?.shouldPersistSeed) return;
    setLocalProfileAvatarSeed(localProfileAvatarSeed);
  }, [cloudLocalProfileAvatar?.shouldPersistSeed, localProfileAvatarSeed]);

  useEffect(() => {
    setLocalAgentAvatarSeed(localAgentAvatarSeed);
  }, [localAgentAvatarSeed]);

  const collaborationContactRequests = useMemo(
    () => collaborationContactRequestsForContactsPage(activeCollaborationHost),
    [activeCollaborationHost],
  );
  const contactRequests = isNativeShell ? collaborationContactRequests : demoContactRequests;

  const {
    activeContactRequest,
    activeSettingsSection,
    activeDesktopLiveTurn,
    isDesktopChatSending,
    activeChatArtifacts,
    activeProjectArtifacts,
  } = useKordiDesktopActivity({
    activeContactRequestId: contactsUi.activeContactRequestId,
    activeSettingsSectionId: visibleActiveSettingsSectionId,
    settingsSections: visibleSettingsSections,
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
    setVisibleLocalSessionId,
    setActiveSourcePreview: settingsUi.setActiveSourcePreview,
    setActiveArtifactId: settingsUi.setActiveArtifactId,
    setActiveDetailTab,
    isDetailPanelCollapsed,
    lastSeenArtifactByContextRef,
    cloudSessionActivity,
  });

  const cloudAwareDisplayedContacts = cloudSession.account ? cloudContacts : displayedContacts;
  const activeTranscriptLastMessage = activeNav === 'projects'
    ? activeProjectLastMessage
    : activeLastMessage;

  useKordiUiEffects({
    isNativeShell,
    desktopChatState,
    desktopAuthState,
    refreshDesktopChat,
    activeNav,
    activeConvId,
    activeProjectId,
    activeProjectSessionId,
    setActiveConvId,
    displayedContacts: cloudAwareDisplayedContacts,
    activeContactId: contactsUi.activeContactId,
    setActiveContactId: contactsUi.setActiveContactId,
    setActiveContactGroup: contactsUi.setActiveContactGroup,
    displayedAgents,
    activeAgentId: agentsUi.activeAgentId,
    setActiveAgentId: agentsUi.setActiveAgentId,
    setActiveSourcePreview: settingsUi.setActiveSourcePreview,
    setActiveArtifactId: settingsUi.setActiveArtifactId,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
    setChatComposerAttachments: composerUi.setChatComposerAttachments,
    openComposerSelector: composerUi.openComposerSelector,
    composerControlsRef,
    themeMode: settingsUi.resolvedThemeMode,
    activeConversationUsesCollaboration,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    setComposerSelections: composerUi.setComposerSelections,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
    activeConvMessagesLength: activeConv.messages.length,
    activeLastMessageTime: activeLastMessage?.time,
    activeTranscriptLastMessageIsOwn: Boolean(
      activeTranscriptLastMessage
      && (activeTranscriptLastMessage.isOwnMessage ?? activeTranscriptLastMessage.role === 'user')
    ),
    activeProjectSessionIdValue: activeProjectSession.id,
    activeProjectSessionMessagesLength: activeProjectSession.messages.length,
    activeProjectLastMessageTime: activeProjectLastMessage?.time,
    pendingUserChatMessageText: pendingUserChatMessage?.text,
    desktopLiveTurn: activeDesktopLiveTurn,
    setChatSlashMenuIndex: composerUi.setChatSlashMenuIndex,
    chatSlashQuery,
    filteredChatSlashCommandsLength: filteredChatSlashCommands.length,
    projectSlashQuery,
    filteredProjectSlashCommandsLength: filteredProjectSlashCommands.length,
  });

  const getStatusBadgeClass = (value: string) => {
    const normalized = value.toLowerCase();

    if (normalized.includes('owned')) return 'app-badge-owned';
    if (normalized.includes('pending') || normalized.includes('approval')) return 'app-badge-attention';
    return 'app-badge-neutral';
  };

  const handleOpenCollaborationConversation = useCallback(async (
    hostId: string,
    peerNodeId: string,
    _peerDisplayName?: string | null,
    _peerOwnerName?: string | null,
    peerRuntime?: string | null,
    _project?: DesktopCollaborationProject | null,
  ) => {
    if (hostId !== CLOUD_HOST_SENTINEL) {
      await unsupportedLegacyCollaborationAction();
      return;
    }
    setActiveNav('chats');
    setActiveConvId(cloudCollaborationConversationId(peerNodeId, peerRuntime ?? 'person'));
    setDesktopChatError(null);
  }, [unsupportedLegacyCollaborationAction, setActiveConvId, setActiveNav, setDesktopChatError]);

  const handleStartCollaborationPersonSession = useCallback(async (target: {
    hostId: string;
    nodeId: string;
    displayName?: string | null;
    ownerName?: string | null;
    humanId?: string | null;
  }) => {
    if (target.hostId !== CLOUD_HOST_SENTINEL) {
      await unsupportedLegacyCollaborationAction();
      return;
    }
    setActiveNav('chats');
    setActiveConvId(cloudCollaborationConversationId(target.nodeId, 'person'));
    setDesktopChatError(null);
  }, [unsupportedLegacyCollaborationAction, setActiveConvId, setActiveNav, setDesktopChatError]);

  const handleAddCollaborationContact = unsupportedLegacyCollaborationAction;
  const handleRemoveCollaborationContact = unsupportedLegacyCollaborationAction;
  const handleApproveCollaborationContactRequest = unsupportedLegacyCollaborationAction;
  const handleRejectCollaborationContactRequest = unsupportedLegacyCollaborationAction;
  const handleUpdateCollaborationAgentModelRouting = unsupportedLegacyCollaborationAction;
  const handleUpdateLocalAgentModelRouting = unsupportedLegacyCollaborationAction;


  const handleUpdateCollaborationAgentModelRoutingForActiveSession = useCallback(async (
    hostId: string,
    agentId: string,
    defaultModel?: string | null,
    fallbackModel?: string | null,
    thinking?: string | null,
    defaultAuthProvider?: string | null,
    defaultAuthChoice?: string | null,
    fallbackAuthProvider?: string | null,
    fallbackAuthChoice?: string | null,
    targetSessionIdOverride?: string | null,
  ) => {
    if (isCloudCollaborationHostId(hostId)) {
      const routeTargetSessionId = targetSessionIdOverride?.trim() || activeConv.canonicalSessionId || activeConv.id || activeConvId;
      const runtimeSessionId = cloudAgentRuntimeSessionId(
        cloudSession.account?.accountId,
        routeTargetSessionId,
      );
      if (!runtimeSessionId) {
        setDesktopChatError('Account is still loading. Try again in a moment.');
        return;
      }
      setCloudAgentRuntimeRoutesBySessionId((current) => ({
        ...current,
        [runtimeSessionId]: {
          model: defaultModel ?? null,
          authProvider: defaultAuthProvider ?? null,
          authChoice: defaultAuthChoice ?? null,
          thinking: thinking ?? null,
        },
      }));
      setDesktopChatError(null);
      return;
    }

    await handleUpdateCollaborationAgentModelRouting(
      hostId,
      agentId,
      defaultModel,
      fallbackModel,
      thinking,
      defaultAuthProvider,
      defaultAuthChoice,
      fallbackAuthProvider,
      fallbackAuthChoice,
    );
  }, [
    activeConv.canonicalSessionId,
    activeConv.id,
    activeConvId,
    cloudSession.account?.accountId,
    handleUpdateCollaborationAgentModelRouting,
    setDesktopChatError,
  ]);

  const syncCloudGroupFork = useCallback(async (result: { forkedSessionId: string; sourceSessionId: string; sourceMessageId: string }) => {
    if (!cloudSession.account) return;
    await refreshCanonicalState();
    const state = await loadCanonicalSessionHistory(result.forkedSessionId);
    if (!state) return;
    const forkSession = state.sessions.find((session) => session.id === result.forkedSessionId);
    if (!forkSession) return;
    const forkMetadata = forkSession.metadata && typeof forkSession.metadata === 'object' && !Array.isArray(forkSession.metadata)
      ? (forkSession.metadata as Record<string, unknown>).fork
      : null;
    const forkRecord = forkMetadata && typeof forkMetadata === 'object' && !Array.isArray(forkMetadata)
      ? forkMetadata as Record<string, unknown>
      : null;
    const parentSessionId = typeof forkRecord?.forkedFromSessionId === 'string' && forkRecord.forkedFromSessionId.trim()
      ? forkRecord.forkedFromSessionId.trim()
      : result.sourceSessionId;
    const parentMessageId = typeof forkRecord?.forkedFromMessageId === 'string' && forkRecord.forkedFromMessageId.trim()
      ? forkRecord.forkedFromMessageId.trim()
      : result.sourceMessageId;

    await recordCloudSessionFork({
      sourceSessionId: parentSessionId,
      forkSessionId: result.forkedSessionId,
      parentMessageId,
    }).catch((error) => {
      if (error && typeof error === 'object' && 'status' in error && (error as { status?: number }).status === 409) return;
      // Best effort: the local fork remains usable if Cloud lineage is not yet
      // available. Group forks still fall back to the explicit Cloud control
      // below for peers; private self-agent forks use this row for relogin sync.
      console.warn('[cloud-fork] failed to record cloud fork lineage', error);
    });

    if (forkSession.kind !== 'group') return;
    const participants = canonicalGroupParticipantsForSession(state, result.forkedSessionId)
      .filter((participant) => participant.kind === 'human');
    const cloudParticipants: CloudGroupParticipant[] = participants.flatMap((participant) => {
      const accountId = participant.humanId?.trim() || participant.sourceIdentityId?.trim() || '';
      if (!accountId) return [];
      return [{
        accountId,
        displayName: participant.name?.trim() || accountId,
        avatarUrl: participant.profileImageUrl ?? null,
        role: participant.role ?? 'person',
      }];
    });
    if (!cloudParticipants.some((participant) => participant.accountId === cloudSession.account?.accountId)) {
      cloudParticipants.push(cloudGroupSelfParticipant(cloudSession.account, 'self'));
    }
    const targetAccountIds = [...new Set(cloudParticipants.map((participant) => participant.accountId).filter((accountId) => accountId && accountId !== cloudSession.account?.accountId))];
    if (targetAccountIds.length === 0) return;

    const fork = {
      forkSessionId: result.forkedSessionId,
      parentSessionId,
      parentMessageId,
      createdAtMs: forkSession.createdAtMs,
    };
    await sendCloudGroupControl({
      targetAccountIds,
      kind: 'session-fork',
      groupId: result.forkedSessionId,
      groupSpaceId: result.forkedSessionId,
      groupTitle: forkSession.title,
      participants: cloudParticipants,
      fork,
    });

    const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
    const accountIdForIdentity = (identityId: string) => {
      const identity = identityById.get(identityId);
      if (!identity) return cloudSession.account?.accountId ?? '';
      if (identity.kind === 'human') return identity.humanId?.trim() || identity.sourceIdentityId?.trim() || cloudSession.account?.accountId || '';
      if (identity.humanId?.trim()) return identity.humanId.trim();
      if (identity.id.startsWith('agent:cloud:')) return identity.id.slice('agent:cloud:'.length);
      const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : null;
      return owner?.humanId?.trim() || owner?.sourceIdentityId?.trim() || cloudSession.account?.accountId || '';
    };
    const snapshotMessages = state.messages
      .filter((message) => message.sessionId === result.forkedSessionId && message.sourceTransport === 'canonical-fork-snapshot')
      .sort((left, right) => left.sequenceNum - right.sequenceNum || left.createdAtMs - right.createdAtMs);
    for (const message of snapshotMessages) {
      const identity = identityById.get(message.senderIdentityId);
      const senderIsAgent = message.messageKind === 'agent-turn' || identity?.kind === 'agent' || message.senderRole.includes('agent');
      const content = message.content && typeof message.content === 'object' && !Array.isArray(message.content) ? message.content as Record<string, unknown> : {};
      const deliveryState = typeof content.deliveryState === 'string' && content.deliveryState.trim()
        ? content.deliveryState.trim()
        : message.status;
      await sendCloudGroupControl({
        targetAccountIds,
        kind: 'group-message',
        groupId: result.forkedSessionId,
        groupSpaceId: result.forkedSessionId,
        groupTitle: forkSession.title,
        participants: cloudParticipants,
        fork,
        message: {
          id: message.id,
          senderAccountId: accountIdForIdentity(message.senderIdentityId),
          text: message.contentText,
          createdAtMs: message.createdAtMs,
          senderKind: senderIsAgent ? 'agent' : 'human',
          senderDisplayName: identity?.displayName ?? null,
          deliveryState,
          replyToMessageId: message.parentMessageId ?? null,
          requestId: typeof content.requestId === 'string' ? content.requestId : null,
          forkSnapshot: true,
        },
      });
    }
  }, [cloudSession.account, loadCanonicalSessionHistory, recordCloudSessionFork, refreshCanonicalState, sendCloudGroupControl]);

  const {
    handleSelectChatSession,
    handleCreateChatSession,
    handleSelectProjectSession,
    handleRenameDesktopSession,
    handleForkChatMessage,
  } = useDesktopSessionController({
    isNativeShell,
    activeConversationUsesCollaboration,
    activeConvId,
    desktopChatState,
    desktopSessionRenameDraft: sessionUi.desktopSessionRenameDraft,
    selectProjectSession,
    refreshDesktopChat,
    shouldAutoFollowChatRef,
    setActiveConvId,
    setPendingUserChatMessage,
    setChatComposerAttachments: composerUi.setChatComposerAttachments,
    setDesktopChatError,
    setDesktopChatState,
    setComposerDrafts: composerUi.setComposerDrafts,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    onForkCreated: syncCloudGroupFork,
  });

  const {
    toggleComposerSelector,
    selectComposerValue,
    selectComposerAuthChoice,
    selectComposerProviderChoice,
    updateComposerDraft,
    saveDesktopAttachments,
    saveDesktopAttachmentPaths,
    removeChatComposerAttachment,
    setChatComposerText,
    setProjectComposerText,
    acceptChatSlashCommand,
    acceptProjectSlashCommand,
    acceptChatMentionTarget,
    acceptProjectMentionTarget,
    handleSendChatMessage,
    handleRetryChatMessage,
    handleSendProjectMessage,
    handleStopDesktopChatTurn,
    handleStopCollaborationAgentRequest,
  } = useComposerController({
    isNativeShell,
    activeConversationUsesCollaboration,
    chatConversations,
    // Pass the SAME chatDraftSessionId the reader uses (see composerDraftsView
    // above). Passing `activeConv.id` here while reading under raw activeConvId
    // was the bug — read/write keys diverged when raw activeConvId was empty
    // (its initial state on native shell) and activeConv fell back via
    // chatConversations[0] in useWorkspaceViewModels, so keystrokes landed at
    // chat[chatConversations[0].id] while the textarea read chat[''] = ''.
    activeConvId: chatDraftSessionId,
    activeConvCanonicalSessionId: activeConv.canonicalSessionId,
    activeConvMessages: activeConv.messages,
    activeConvCollaborationTarget: activeConv.collaborationTarget,
    activeConvMentionScope,
    sharedCloudAgents: mentionableCloudAgents,
    resolveSharedCloudAgentsForMention,
    activeProjectId,
    activeProjectSessionId,
    activeProjectRoot: activeProject.root,
    selectProjectSession,
    desktopChatState,
    desktopCollaborationState,
    canonicalSessionState,
    hasAnyDesktopAuth: authStateHasChatReadyProvider(desktopAuthState, chatModelOptions),
    canonicalHumanIdentityId: canonicalSessionState?.profile.humanIdentityId,
    setCanonicalSessionState,
    desktopLiveTurn: activeDesktopLiveTurn,
    composerSelections: composerUi.composerSelections,
    setComposerSelections: composerUi.setComposerSelections,
    composerDrafts: composerDraftsView,
    setComposerDrafts: composerUi.setComposerDrafts,
    activeChatQuote,
    setProjectWorkspaces: projectsUi.setProjectWorkspaces,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
    chatComposerAttachments: composerUi.chatComposerAttachments,
    setChatComposerAttachments: composerUi.setChatComposerAttachments,
    chatModelOptions,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    handleSelectAuthChoice,
    refreshDesktopAuth,
    refreshDesktopChat,
    handleCreateChatSession,
    handleRenameDesktopSession,
    setActiveNav,
    setActiveSettingsSectionId: settingsUi.setActiveSettingsSectionId,
    setActiveDetailTab,
    setIsDetailPanelCollapsed,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    setDesktopChatState,
    setDesktopChatError,
    isDesktopChatSending: isDesktopCollaborationSending,
    setIsDesktopChatSending: setIsDesktopCollaborationSending,
    setPendingUserChatMessage,
    queuedDesktopMessagesBySession,
    setQueuedDesktopMessagesBySession,
    setDesktopLiveTurnsBySession,
    setDesktopCollaborationState,
    setCloudCollaborationState,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
    cancelCloudAgentRequest,
    watchDesktopLiveTurn,
    shouldAutoFollowChatRef,
    setActiveConvId,
  });

  const handleEditQueuedMessage = useCallback((sessionId: string, queuedMessageId: string) => {
    const queuedMessage = (queuedDesktopMessagesBySession[sessionId] ?? [])
      .find((message) => message.id === queuedMessageId);
    if (!queuedMessage) return;

    composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'chat', queuedMessage.sessionId, queuedMessage.text));
    setQueuedDesktopMessagesBySession((current) => removeQueuedDesktopMessageById(current, sessionId, queuedMessageId));
    focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, isNativeShell);
  }, [composerUi.setComposerDrafts, isNativeShell, queuedDesktopMessagesBySession, setQueuedDesktopMessagesBySession]);

  const handleCancelQueuedMessage = useCallback((sessionId: string, queuedMessageId: string) => {
    setQueuedDesktopMessagesBySession((current) => removeQueuedDesktopMessageById(current, sessionId, queuedMessageId));
  }, [setQueuedDesktopMessagesBySession]);

  useEffect(() => {
    if (!isNativeShell || !desktopAuthState || !desktopChatState?.activeSessionId) return;

    const configuredProviders = buildAuthDisplayProviders(desktopAuthState)
      .filter((provider) => provider.configured);

    if (configuredProviders.length === 0) {
      lastAutoAuthProviderSwitchRef.current = null;
      return;
    }

    const normalizedCurrentProvider =
      normalizeSelectedProviderId(desktopChatState.activeSession.provider) ?? desktopChatState.activeSession.provider;
    const currentProviderIsConfigured = configuredProviders.some((provider) => provider.id === normalizedCurrentProvider);
    const currentProviderHasRuntimeModels = desktopChatState.modelOptions.some((option) => (
      (normalizeSelectedProviderId(option.provider) ?? option.provider) === normalizedCurrentProvider
    ));

    if (currentProviderIsConfigured || currentProviderHasRuntimeModels) {
      lastAutoAuthProviderSwitchRef.current = null;
      return;
    }

    const normalizedActiveLoginProviderId = normalizeSelectedProviderId(activeLoginProviderId);
    const preferredConfiguredProvider =
      configuredProviders.find((provider) => provider.id === normalizedActiveLoginProviderId)
      ?? configuredProviders.find((provider) => provider.methods.some((method) => method.options.some((option) => option.active)))
      ?? configuredProviders[0];

    if (!preferredConfiguredProvider) return;

    const nextModelValue = preferredModelValueForProvider(preferredConfiguredProvider.id);
    if (!nextModelValue) return;

    const signature = [
      desktopChatState.activeSessionId,
      normalizedCurrentProvider,
      preferredConfiguredProvider.id,
      nextModelValue,
    ].join(':');

    if (lastAutoAuthProviderSwitchRef.current === signature) return;
    lastAutoAuthProviderSwitchRef.current = signature;

    const scope = desktopChatState.activeSessionId === activeProjectSessionId ? 'project' : 'chat';
    void selectComposerValue(scope, 'provider', preferredConfiguredProvider.id);
  }, [
    activeLoginProviderId,
    activeProjectSessionId,
    desktopAuthState,
    desktopChatState?.activeSession.provider,
    desktopChatState?.activeSessionId,
    desktopChatState?.modelOptions,
    isNativeShell,
    preferredModelValueForProvider,
    selectComposerValue,
  ]);

  const activeQueuedDesktopMessages = queuedDesktopMessagesBySession[activeConv.id] ?? ('queuedMessages' in activeConv ? activeConv.queuedMessages : undefined) ?? [];

  const {
    renameSession: handleRenameChatSession,
    archiveSession: handleArchiveChatSession,
    deleteSession: handleDeleteChatSession,
  } = useKordiChatSessionActions({
    account: cloudSession.account,
    activeConversationId: activeConvId,
    canonicalState: canonicalSessionState,
    desktopState: desktopChatState,
    isNativeShell,
    deleteCloudSession,
    hideCloudSession,
    refreshCanonicalState,
    refreshDesktopChat,
    sendCloudGroupControl,
    setActiveConversationId: setActiveConvId,
    setCanonicalState: setCanonicalSessionState,
    setComposerDrafts: composerUi.setComposerDrafts,
    setDesktopError: setDesktopChatError,
    setDesktopState: setDesktopChatState,
    setLocallyHiddenSessionIds,
  });

  const {
    moveSessionToProject: handleMoveChatSessionToProject,
    createProjectFromFolder: handleCreateProjectFromFolder,
    createProject: handleCreateProject,
    createProjectSession: handleCreateProjectSession,
  } = useKordiProjectActions({
    activeProject,
    desktopState: desktopChatState,
    isNativeShell,
    refreshCanonicalState,
    refreshDesktopChat,
    selectProject,
    selectProjectSession,
    setActiveNav,
    setComposerAttachments: composerUi.setChatComposerAttachments,
    setComposerDrafts: composerUi.setComposerDrafts,
    setDesktopError: setDesktopChatError,
    setDesktopState: setDesktopChatState,
    setExpandedProjectIds: projectsUi.setExpandedProjectIds,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
  });

  const peopleContactById = useMemo(
    () => buildChatCreatePeopleContactLookup(displayedContacts),
    [displayedContacts],
  );

  const {
    selectNewSession: selectNewChatSession,
    startChatWithPerson: handleStartChatWithPerson,
    startChatWithAgent: handleStartChatWithAgent,
  } = useKordiChatStartActions({
    canonicalState: canonicalSessionState,
    conversations: chatConversations,
    isNativeShell,
    createOwnedAgentSession: handleCreateChatSession,
    startCollaborationPersonSession:
      handleStartCollaborationPersonSession,
    setActiveConversationId: setActiveConvId,
    setActiveNav,
    setCanonicalState: setCanonicalSessionState,
    setComposerAttachments: composerUi.setChatComposerAttachments,
    setComposerDrafts: composerUi.setComposerDrafts,
    setDesktopError: setDesktopChatError,
    setOpenComposerSelector: composerUi.setOpenComposerSelector,
  });

  const handleCreateChatGroup = useKordiGroupCreation({
    account: cloudSession.account,
    canonicalState: canonicalSessionState,
    contactById: peopleContactById,
    isNativeShell,
    sendCloudGroupControl,
    selectNewSession: selectNewChatSession,
    setCanonicalState: setCanonicalSessionState,
    setDesktopError: setDesktopChatError,
  });

  const handleCreateChatSessionInParticipantSpace =
    useKordiParticipantSpaceContinuation({
      canonicalState: canonicalSessionState,
      createOwnedAgentSession: handleCreateChatSession,
      draftByKeyRef: participantSpaceDraftByKeyRef,
      draftBySessionIdRef: participantSpaceDraftBySessionIdRef,
      isNativeShell,
      pendingCreateRef: pendingParticipantSpaceCreateRef,
      selectNewSession: selectNewChatSession,
      setActiveConversationId: setActiveConvId,
      setActiveNav,
      setCanonicalState: setCanonicalSessionState,
      setDesktopError: setDesktopChatError,
      setDrafts: setParticipantSpaceDrafts,
    });

  const handleRenameChatGroup = useCallback(async (sessionIds: string[], name: string) => {
    if (!isNativeShell) return;
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
    const title = name.trim();
    if (!title) throw new Error('Group name is required.');
    setDesktopChatError(null);

    if (!canonicalSessionState) throw new Error('Local profile identity is not ready yet.');
    const actorIdentityId = canonicalSessionState.profile.humanIdentityId?.trim();
    if (!actorIdentityId) throw new Error('Local profile identity is not ready yet.');

    const fallbackGroupSpaceId = groupSessionIds[0];
    let nextState = canonicalSessionState;
    const renamedGroupIds = new Map<string, string>();
    for (const sessionId of groupSessionIds) {
      const currentMetadata = sessionMetadataRecord(nextState, sessionId);
      const groupId = metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId;
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: actorIdentityId,
        metadata: groupRenameMetadata(currentMetadata, title, groupId),
      });
      renamedGroupIds.set(groupId, sessionId);
    }
    for (const sessionId of groupSessionIds) {
      nextState = await appendCanonicalRenameNotice(
        nextState,
        sessionId,
        title,
        'group',
        actorIdentityId,
      );
    }
    setCanonicalSessionState(nextState);

    try {
      for (const [groupId, sourceSessionId] of renamedGroupIds) {
        const participants = canonicalGroupParticipantsForSession(nextState, sourceSessionId);
        const targets = buildChatGroupCollaborationUpdateTargets({ actorIdentityId, participants });
        if (targets.length === 0) continue;
        const updateParticipants = buildChatGroupCollaborationUpdateParticipants({
          participants,
          adminIdentityIds: activeGroupAdminIds(nextState, sourceSessionId),
        });
        const cloudTargetAccountIds = cloudGroupTargetAccountIds(targets);
        if (cloudTargetAccountIds.length > 0 && cloudSession.account) {
          await sendCloudGroupControl({
            targetAccountIds: cloudTargetAccountIds,
            kind: 'group-title-update',
            groupId,
            groupSpaceId: groupId,
            groupTitle: title,
            participants: cloudGroupParticipantsForCollaborationSession(cloudSession.account, updateParticipants),
          });
        }
      }
    } catch (error) {
      setDesktopChatError(`Group renamed, but hosted sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [
    canonicalSessionState,
    cloudSession.account,
    isNativeShell,
    sendCloudGroupControl,
    setDesktopChatError,
  ]);

  const handleAddChatGroupMembers = useKordiGroupMemberInvites({
    account: cloudSession.account,
    canonicalState: canonicalSessionState,
    contactById: peopleContactById,
    isNativeShell,
    sendCloudGroupControl,
    setCanonicalState: setCanonicalSessionState,
    setDesktopError: setDesktopChatError,
  });

  const {
    removeGroupMember: handleRemoveChatGroupMember,
    setGroupAdmin: handleSetChatGroupAdmin,
  } = useKordiGroupMemberRoles({
    account: cloudSession.account,
    canonicalState: canonicalSessionState,
    isNativeShell,
    sendCloudGroupControl,
    setCanonicalState: setCanonicalSessionState,
    setDesktopError: setDesktopChatError,
  });

  const materializeParticipantSpaceDraft = useCallback(async (sessionId: string) => {
    const draft = participantSpaceDraftBySessionIdRef.current.get(sessionId);
    if (!draft) return;

    const pending = participantSpaceDraftMaterializeRef.current.get(sessionId);
    if (pending) {
      await pending;
      return;
    }

    const materialize = (async () => {
      const currentState = canonicalSessionState;
      const localIdentityId = currentState?.profile.humanIdentityId?.trim();
      if (!currentState || !localIdentityId) {
        throw new Error('Local profile identity is not ready yet.');
      }
      const groupCreatorIdentityId = draft.conversation.canonicalCreatedByIdentityId?.trim()
        || metadataString(draft.conversation.metadata && typeof draft.conversation.metadata === 'object' && !Array.isArray(draft.conversation.metadata)
          ? draft.conversation.metadata as Record<string, unknown>
          : {}, 'groupCreatorIdentityId')
        || localIdentityId;

      const existingSession = currentState.sessions.find((session) => session.id === sessionId);
      let nextState = currentState;
      if (!existingSession) {
        const openResult = await openOrCreateCanonicalSessionFast({
          id: sessionId,
          kind: 'group',
          title: 'New session',
          status: 'active',
          createdByIdentityId: groupCreatorIdentityId,
          primaryIdentityId: null,
          relationshipIdentityId: null,
          participantIdentityIds: draft.participantIdentityIds,
          metadata: draft.conversation.metadata,
        });
        nextState = mergeOpenCanonicalSessionResult(currentState, openResult);
        setCanonicalSessionState(nextState);
      }

      participantSpaceDraftBySessionIdRef.current.delete(sessionId);
      const currentByKey = participantSpaceDraftByKeyRef.current.get(draft.createKey);
      if (currentByKey?.sessionId === sessionId) {
        participantSpaceDraftByKeyRef.current.delete(draft.createKey);
      }
      setParticipantSpaceDrafts((current) => current.filter((candidate) => candidate.sessionId !== sessionId));
    })();

    participantSpaceDraftMaterializeRef.current.set(sessionId, materialize);
    try {
      await materialize;
    } finally {
      participantSpaceDraftMaterializeRef.current.delete(sessionId);
    }
  }, [canonicalSessionState]);

  const handleSendChatMessageAfterMaterializingDraft = useCallback(async (
    draftOverride?: string,
    targetSessionId?: string,
    contextMessages?: DesktopChatContextMessage[],
  ) => {
    const hasSendableContent = (draftOverride ?? composerDraftsView.chat).trim().length > 0
      || composerUi.chatComposerAttachments.length > 0;
    const candidateSessionId = targetSessionId || activeConvId;
    if (hasSendableContent && participantSpaceDraftBySessionIdRef.current.has(candidateSessionId)) {
      try {
        await materializeParticipantSpaceDraft(candidateSessionId);
      } catch (error) {
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to start group session');
        return;
      }
    }
    await handleSendChatMessage(draftOverride, targetSessionId, contextMessages);
  }, [activeConvId, composerDraftsView.chat, composerUi.chatComposerAttachments.length, handleSendChatMessage, materializeParticipantSpaceDraft, setDesktopChatError]);

  const handleSendChatMessageWithQuoteClear = useCallback((
    draftOverride?: string,
    targetSessionId?: string,
    contextMessages?: DesktopChatContextMessage[],
  ) => sendChatMessageWithImmediateQuoteClear({
    draftOverride,
    targetSessionId,
    contextMessages,
    currentDraft: composerDraftsView.chat,
    attachmentCount: composerUi.chatComposerAttachments.length,
    activeChatQuote,
    send: handleSendChatMessageAfterMaterializingDraft,
    clearQuote: onClearChatQuote,
  }), [activeChatQuote, composerDraftsView.chat, composerUi.chatComposerAttachments.length, handleSendChatMessageAfterMaterializingDraft, onClearChatQuote]);

  const {
    rootThemeClass,
    lastCollaborationSyncAtLabel,
    onProjectTranscriptScroll,
    onChatTranscriptScroll,
    activeRuntimeSessionId,
    activeRuntimeContextStatus,
    activeRuntimeCacheText,
    activeSessionProject,
    chatModelOptionsForShell,
    wrappedSelectComposerValue,
    wrappedSelectComposerAuthChoice,
    wrappedSelectComposerProviderChoice,
    wrappedStopDesktopChatTurn,
    wrappedSendProjectMessage,
    wrappedSendChatMessage,
    wrappedRetryChatMessage,
  } = useKordiShellViewModel({
    themeMode: settingsUi.resolvedThemeMode,
    lastCollaborationSyncAt,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
    desktopChatState,
    activeConv,
    activeConversationUsesCollaboration,
    chatModelOptions,
    selectComposerValue,
    selectComposerAuthChoice,
    selectComposerProviderChoice,
    handleStopDesktopChatTurn,
    handleSendProjectMessage,
    handleSendChatMessage: handleSendChatMessageWithQuoteClear,
    handleRetryChatMessage,
  });
  const setChatComposerTextForSession = useCallback((sessionId: string, value: string) => {
    composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'chat', sessionId, value));
  }, [composerUi.setComposerDrafts]);

  const handleCreateSideAgentSession = useCallback(async () => {
    if (!isNativeShell) return null;
    try {
      setDesktopChatError(null);
      const previousActiveSessionId = desktopChatState?.activeSessionId ?? null;
      const nextState = await createDesktopChatSession();
      const sessionId = nextState.activeSessionId?.trim() || null;
      setDesktopChatState(previousActiveSessionId
        ? { ...nextState, activeSessionId: previousActiveSessionId }
        : nextState);
      if (sessionId) {
        composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'chat', sessionId, ''));
      }
      return sessionId;
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to create agent session');
      return null;
    }
  }, [composerUi.setComposerDrafts, desktopChatState?.activeSessionId, isNativeShell, setDesktopChatError, setDesktopChatState]);

  const shellArgs = useKordiShellArgs({
    isNativeShell,
    desktopChatState,
    refreshDesktopChat,
    cloudSelfAgentSyncStatusBySessionId,
    cloudSessionPinsById,
    onUpdateCloudSessionPin: updateCloudSessionPin,
    windowWidth: windowSize.width,
    activeNav,
    setActiveNav,
    cloudSession,
    activeConvId,
    setActiveConvId,
    activeProjectId,
    activeProjectSessionId,
    activeSettingsSectionId: visibleActiveSettingsSectionId,
    cloudAccountDialogTab,
    setCloudAccountDialogTab,
    openCloudAccountAuthentication,
    isSingleWorkspacePage,
    collapseChatSessions,
    showSessionRail,
    sessionRailWidth,
    detailRailWidth,
    onDetailResizeMouseDown: startPanelResize('detail'),
    chatConversations,
    isDesktopChatLoading,
    desktopChatError,
    filteredConversations,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    handleCreateChatSession,
    handleCreateSideAgentSession,
    handleSelectChatSession,
    handleStartChatWithPerson,
    handleStartChatWithAgent,
    handleCreateChatGroup,
    handleCreateChatSessionInParticipantSpace,
    handleRenameChatGroup,
    handleRenameChatSession,
    handleAddChatGroupMembers,
    handleRemoveChatGroupMember,
    handleSetChatGroupAdmin,
    handleArchiveChatSession,
    handleDeleteChatSession,
    handleMoveChatSessionToProject,
    handleCreateProjectFromFolder,
    handleCreateProject,
    handleCreateProjectSession,
    chatSearch: chatsUi.chatSearch,
    setChatSearch: chatsUi.setChatSearch,
    runtimeProjects,
    projectSearch: projectsUi.projectSearch,
    setProjectSearch: projectsUi.setProjectSearch,
    filteredProjects,
    projectSelectedSessionIds,
    selectProject,
    expandedProjectIds: projectsUi.expandedProjectIds,
    setExpandedProjectIds: projectsUi.setExpandedProjectIds,
    groupedContacts,
    displayedContacts,
    addableContacts,
    setActiveContactGroup: contactsUi.setActiveContactGroup,
    setActiveContactId: contactsUi.setActiveContactId,
    displayedAgents,
    handleCreateCloudAgent,
    handleUpdateCloudAgent,
    handleArchiveCloudAgent,
    activeCollaborationHost,
    localProfileAvatarSeed,
    localProfileDisplayName,
    localProfileImageUrl,
    handleSelectProjectSession,
    filteredGroupedContacts,
    isContactRequestsOpen: contactsUi.isContactRequestsOpen,
    setIsContactRequestsOpen: contactsUi.setIsContactRequestsOpen,
    contactRequests: contactRequests,
    activeContactRequestId: contactsUi.activeContactRequestId,
    setActiveContactRequestId: contactsUi.setActiveContactRequestId,
    setContactOverlayMode: contactsUi.setContactOverlayMode,
    contactSearch: contactsUi.contactSearch,
    setContactSearch: contactsUi.setContactSearch,
    expandedContactGroups: contactsUi.expandedContactGroups,
    setExpandedContactGroups: contactsUi.setExpandedContactGroups,
    activeContactId: contactsUi.activeContactId,
    contactOverlayMode: contactsUi.contactOverlayMode,
    activeContact,
    activeContactRequest,
    getStatusBadgeClass,
    handleAddCollaborationContact,
    handleOpenCollaborationConversation,
    handleRemoveCollaborationContact,
    handleStartCollaborationPersonSession,
    handleApproveCollaborationContactRequest,
    handleRejectCollaborationContactRequest,
    handleUpdateCollaborationAgentModelRouting: handleUpdateCollaborationAgentModelRoutingForActiveSession,
    handleUpdateLocalAgentModelRouting,
    activeAgentId: agentsUi.activeAgentId,
    setActiveAgentId: agentsUi.setActiveAgentId,
    activeAgent,
    isAgentOverlayOpen: agentsUi.isAgentOverlayOpen,
    setIsAgentOverlayOpen: agentsUi.setIsAgentOverlayOpen,
    desktopCollaborationState,
    settingsRailWidth,
    settingsContentRef,
    setActiveSettingsSectionId: settingsUi.setActiveSettingsSectionId,
    settingsSections: visibleSettingsSections,
    activeSettingsSection,
    authSettingsLayoutWidth,
    desktopAuthState,
    isDesktopAuthLoading,
    desktopAuthError,
    activeLoginProviderId,
    selectAuthProvider,
    openAuthSettings,
    openLoginFlow,
    refreshDesktopAuth,
    handleSelectAuthChoice,
    handleRemoveAuthProfile,
    handleLogoutProvider,
    themeMode: settingsUi.themeMode,
    setThemeMode: settingsUi.setThemeMode,
    showRightDetailRail,
    isDetailPanelCollapsed,
    setIsDetailPanelCollapsed,
    setIsSessionPanelCollapsed,
    activeProject,
    activeProjectSession,
    desktopSessionRenameDraft: sessionUi.desktopSessionRenameDraft,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    isEditingDesktopSessionTitle: sessionUi.isEditingDesktopSessionTitle,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    handleRenameDesktopSession,
    chatTranscriptScrollRef,
    canonicalHasOlderBySessionId: canonicalStore.hasOlderBySessionId,
    loadOlderCanonicalSessionMessages,
    onProjectTranscriptScroll,
    onChatTranscriptScroll,
    activeSourcePreview: settingsUi.activeSourcePreview,
    setActiveSourcePreview: settingsUi.setActiveSourcePreview,
    activeArtifactId: settingsUi.activeArtifactId,
    setActiveArtifactId: settingsUi.setActiveArtifactId,
    activeChatArtifacts,
    activeProjectArtifacts,
    desktopLiveTurn: activeDesktopLiveTurn,
    filteredProjectSlashCommands,
    filteredChatSlashCommands,
    filteredProjectMentionTargets,
    filteredChatMentionTargets,
    chatSlashMenuIndex: composerUi.chatSlashMenuIndex,
    setChatSlashMenuIndex: composerUi.setChatSlashMenuIndex,
    acceptProjectSlashCommand,
    acceptChatSlashCommand,
    acceptProjectMentionTarget,
    acceptChatMentionTarget,
    chatAttachmentInputRef,
    chatComposerAttachments: composerUi.chatComposerAttachments,
    saveDesktopAttachments,
    saveDesktopAttachmentPaths,
    removeChatComposerAttachment,
    projectComposerText: composerDraftsView.project,
    chatComposerText: composerDraftsView.chat,
    updateProjectComposerDraft: (value, target) => updateComposerDraft('project', value, target),
    updateChatComposerDraft: (value, target) => updateComposerDraft('chat', value, target),
    setProjectComposerText,
    setChatComposerText,
    setChatComposerTextForSession,
    activeChatQuote,
    onClearChatQuote,
    onReplyMessage,
    onForwardMessage,
    onSelectMessage,
    messageSelectionMode: Boolean(activeMessageSelection),
    selectedMessageCount,
    selectedMessageIds,
    isMessageSelectable,
    onToggleSelectedMessage,
    onSelectionDragStart,
    onSelectionDragEnter,
    onSelectionDragEnd,
    onCancelMessageSelection,
    onCopySelectedMessages,
    onForwardSelectedMessages,
    composerControlsRef,
    activeRuntimeSessionId,
    activeRuntimeContextStatus,
    activeRuntimeCacheText,
    composerSelectionProject: composerUi.composerSelections.project,
    composerSelectionChat: composerUi.composerSelections.chat,
    openComposerSelector: composerUi.openComposerSelector,
    toggleComposerSelector,
    selectComposerValue: wrappedSelectComposerValue,
    composerAuthLabelProject: composerAuthByScope.labelByScope.project,
    composerAuthLabelChat: composerAuthByScope.labelByScope.chat,
    composerAuthOptionsProject: composerAuthByScope.optionsByScope.project,
    composerAuthOptionsChat: composerAuthByScope.optionsByScope.chat,
    selectComposerAuthChoice: wrappedSelectComposerAuthChoice,
    selectComposerProviderChoice: wrappedSelectComposerProviderChoice,
    composerProviderOptions,
    chatModelOptions: chatModelOptionsForShell,
    isDesktopChatSending,
    handleStopDesktopChatTurn: wrappedStopDesktopChatTurn,
    handleStopCollaborationAgentRequest,
    handleSendProjectMessage: wrappedSendProjectMessage,
    handleSendChatMessage: wrappedSendChatMessage,
    handleRetryChatMessage: wrappedRetryChatMessage,
    handleForkChatMessage,
    showChatDetailRail,
    activeDetailTab,
    setActiveDetailTab,
    activeProjectLastMessage,
    activeConv,
    activeConvHasSubtitle,
    activeLastMessage,
    activeConversationUsesCollaboration,
    activeCollaborationConversationHost,
    activeCollaborationConversation,
    activeCollaborationAwaitingReply,
    isCollaborationSyncing,
    lastCollaborationSyncAtLabel,
    activeSessionProject,
    activeQueuedDesktopMessages,
    queuedDesktopMessagesBySession,
    handleEditQueuedMessage,
    handleCancelQueuedMessage,
    showAuthGate,
    dismissAuthGate,
    inlineAuthDialog,
    handleCloseInlineAuthDialog,
    startWindowResize,
  });

  const shellSlots = assembleKordiShellSlots(shellArgs);
  const cloudInitialSync = useMemo(() => {
    const accountKey = cloudSession.account?.accountId ?? '__pending__';
    const rawStatus = cloudInitialSyncStatus({
      isCloudEdition: true,
      accountReady: Boolean(cloudSession.account),
      canonicalSettled: canonicalInitialRefreshSettled,
      canonicalReady: !canonicalInitialRefreshError,
      contactsSettled: initialContactsSettled,
      messagesSettled: initialMessagesSettled,
      desktopChatSettled: !isDesktopChatLoading,
      localBackupReady: cachedMessagesReady || canonicalStateHasCloudLocalBackup(canonicalSessionState, cloudSession.account?.accountId),
      startedAtMs: cloudInitialSyncStartedAt,
      nowMs: cloudInitialSyncNow,
    });
    if (rawStatus === 'ready') completedCloudInitialSyncAccountRef.current = accountKey;
    const status = completedCloudInitialSyncAccountRef.current === accountKey ? 'ready' : rawStatus;
    return { status, onRetry: retryCloudInitialSync };
  }, [
    canonicalInitialRefreshError,
    canonicalInitialRefreshSettled,
    cloudInitialSyncNow,
    cloudInitialSyncStartedAt,
    canonicalSessionState,
    cloudSession.account,
    cachedMessagesReady,
    initialContactsSettled,
    initialMessagesSettled,
    isDesktopChatLoading,
    retryCloudInitialSync,
  ]);

  return {
    rootThemeClass,
    isNativeShell,
    isLayoutResizing,
    windowSize,
    leftWorkspaceWidth,
    isSingleWorkspacePage,
    showSessionRail,
    collapseChatSessions,
    showRightDetailRail: activeNav === 'chats' ? false : showRightDetailRail,
    isDetailPanelCollapsed,
    detailRailWidth,
    onSessionResizeMouseDown: startPanelResize('session'),
    onDetailResizeMouseDown: startPanelResize('detail'),
    sidebar: shellSlots.sidebar,
    mainContent: shellSlots.mainContent,
    rightDetailRail: shellSlots.rightDetailRail,
    authGate: shellSlots.authGate,
    inlineAuthDialog: shellSlots.inlineAuthDialog,
    messageForwardDialog,
    windowResizeHandles: shellSlots.windowResizeHandles,
    cloudInitialSync,
  };
}
