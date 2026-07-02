import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { MessageForwardDialog } from '@/pages/MessageForwardDialog';
import { useDesktopAuthState } from '@/features/auth/useDesktopAuthState';
import { useDesktopAuthUiState } from '@/features/auth/useDesktopAuthUiState';
import { resolveCloudLocalProfileAvatar } from '@/features/cloud/avatar';
import { cloudAgentDefinitionToAgent } from '@/features/cloud/cloudAgents';
import type { CreateCloudAgentInput, UpdateCloudAgentInput } from '@/features/cloud/cloudAgentsClient';
import {
  type CloudGroupParticipant,
  cloudGroupIdentityRequest,
  cloudGroupMessageSessionId,
  cloudGroupParticipantsForBridgeSessionParticipants,
  cloudGroupParticipantsForContacts,
  cloudGroupSelfParticipant,
  cloudGroupTargetAccountIds,
} from '@/features/cloud/cloudGroupMessages';
import { CLOUD_INITIAL_SYNC_TIMEOUT_MS, canonicalStateHasCloudLocalBackup, cloudInitialSyncStatus } from '@/features/cloud/initialSync';
import { useCloudSession, type UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { useCloudBridgeState } from '@/features/cloud/useCloudBridgeState';
import { useCloudPresence } from '@/features/cloud/useCloudPresence';
import { cloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentRuntime';
import { cloudBridgeConversationId, isCloudBridgeConversationId, isCloudBridgeHostId } from '@/features/cloud/cloudBridgeState';
import { encodeCloudDirectMessageEnvelope } from '@/features/cloud/cloudDirectMessages';
import { CLOUD_HOST_SENTINEL } from '@/features/cloud/useCloudContacts';
import {
  buildProjectRoutingGroups,
  canonicalProjectGroupIdFromRoot,
  isCanonicalBridgeSessionId,
} from '@/features/canonical/sessionResolver';
import { useDesktopChatState } from '@/features/chat/useDesktopChatState';
import { useComposerController } from '@/features/chat/useComposerController';
import { useComposerViewModel } from '@/features/chat/useComposerViewModel';
import { mentionScopeConversationForActiveConversation } from '@/features/chat/messageActions/mentions';
import {
  bridgeGroupSessionParticipants,
  bridgeGroupSessionSendTargets,
  bridgeGroupSessionSpaceId,
  isBridgeGroupSession,
} from '@/features/chat/messageActions/chatMessages';
import {
  adminIdentityIdsFromMetadata,
  agentCanonicalIdentityRequest,
  buildChatAgentSessionKind,
  buildChatAgentSessionMetadata,
  buildChatCreateGroupBridgeInviteTargets,
  buildChatCreateGroupMetadata,
  buildChatCreatePeopleContactLookup,
  buildChatGroupBridgeUpdateParticipants,
  buildChatGroupBridgeUpdateTargets,
  buildChatCreatePersonOptions,
  buildParticipantSpaceContinuationMetadata,
  chatSessionIdForAgentStart,
  chatSessionIdForParticipantSpaceContinuation,
  chatSessionIdForPersonStart,
  contactCanonicalIdentityRequest,
  existingBlankSessionIdForAgentStart,
  existingSessionIdForPersonStart,
  existingBlankSessionIdForParticipantSpace,
  groupDefaultName,
  isApprovedBridgeContact,
} from '@/features/chat/chatCreateFlows';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID, projectDraftSessionId } from '@/features/chat/draftSessions';
import { updateScopeDraft } from '@/features/chat/composerDrafts';
import { CHAT_COMPOSER_TEXTAREA_SELECTOR, focusComposerTextareaForNativeInput } from '@/features/chat/composerController.shared';
import { sendChatMessageWithImmediateQuoteClear } from '@/features/chat/composerQuoteClear';
import { messageActionSourceFromMessage, type MessageActionSource } from '@/features/chat/messageActionMetadata';
import { formatSelectedMessagesForCopy, setMessageSelectionSource, toggleMessageSelectionSource, type MessageSelectionState } from '@/features/chat/messageSelection';
import { buildForwardDestinations, createForwardedMessageDrafts, orderedForwardSourcesForMessageIds, revealForwardedMessageInDestination, type ForwardDestination } from '@/features/chat/messageForwarding';
import { useDesktopSessionController } from '@/features/chat/useDesktopSessionController';
import { useDesktopTranscriptAdapter } from '@/features/chat/useDesktopTranscriptAdapter';
import { buildBridgeMentionTargetsByScope, mentionableCloudAgentSummaries, sharedCloudAgentOwnerIdsForMentionScope } from '@/app/useKordiAppModelBridgeMentions';
import { setLocalAgentAvatarSeed, setLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { navigateToTranscriptMessageOrScrollBottom, scrollTranscriptToBottom } from '@/kordi-app/components/transcriptReplyAttribution';
import { bridgeContactRequestsForContactsPage } from '@/app/viewModels/helpers';
import type { Agent, CanonicalIdentity, CanonicalSessionState, ComposerScope, Contact, DesktopBridgeInvite, DesktopBridgeProject, DesktopChatState, Message, OpenCanonicalSessionFastResult, ParticipantSpaceViewModel } from '@/kordi-app/types';
import type { DesktopChatContextMessage, DesktopChatMessageRoute } from '@/lib/desktop';
import type { BridgeSettingsDraft, BridgeWizardDraft } from '@/app/kordiShellSlots.types';
import { createSingleFlightState, requestSingleFlightRun } from '@/lib/singleFlight';
import {
  addCanonicalSessionParticipants,
  appendCanonicalMessage,
  archiveDesktopChatSession,
  createDesktopChatSession,
  createDesktopProject,
  createDesktopProjectFromFolder,
  fetchCanonicalSessionState,
  moveDesktopChatSessionToProject,
  openOrCreateCanonicalSessionFast,
  removeCanonicalSessionParticipant,
  renameCanonicalSession,
  renameDesktopChatSession,
  setCanonicalSessionParticipantRole,
  updateCanonicalSessionMetadata,
  upsertCanonicalIdentityFast,
} from '@/lib/desktop';

import {
  activeGroupAdminIds,
  canonicalAvatarSeed,
  canonicalGroupInviteContextForSession,
  canonicalGroupParticipantsForSession,
  canonicalGroupSessionSyncContextForSession,
  canonicalIdentityDisplayName,
  canonicalLocalAgentAvatarSeed,
  canonicalProfileImageUrl,
  currentMentionQuery,
  filterMentionTargets,
  groupRenameMetadata,
  isNativeDesktopShell,
  mergeCanonicalStatePreservingBridgeUiMessages,
  metadataGroupSpaceId,
  metadataString,
  metadataStringArray,
  normalizeMentionSearch,
  normalizeStoredGroupSpaceId,
  participantSpaceCreateKey,
  participantSpaceNonSelfIdentities,
  removeSessionFromCanonicalState,
  removeSessionFromDesktopState,
  sessionMetadataRecord,
  sessionRenameNoticeText,
  shouldUseCloudSessionAction,
  uniqueStrings,
} from '@/app/useKordiAppModelHelpers';

function mergeCanonicalIdentity(state: CanonicalSessionState, identity: CanonicalIdentity): CanonicalSessionState {
  return {
    ...state,
    identities: [
      ...state.identities.filter((current) => current.id !== identity.id),
      identity,
    ],
  };
}

function mergeOpenCanonicalSessionResult(
  state: CanonicalSessionState,
  result: OpenCanonicalSessionFastResult,
): CanonicalSessionState {
  const participantIds = new Set(result.participants.map((participant) => `${participant.sessionId}:${participant.identityId}`));
  return {
    ...state,
    sessions: [
      result.session,
      ...state.sessions.filter((session) => session.id !== result.session.id),
    ],
    participants: [
      ...state.participants.filter((participant) => !participantIds.has(`${participant.sessionId}:${participant.identityId}`)),
      ...result.participants,
    ],
  };
}

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
  const [forwardDialog, setForwardDialog] = useState<{
    sources: MessageActionSource[];
    destinations: ForwardDestination[];
  } | null>(null);
  const [messageSelection, setMessageSelection] = useState<MessageSelectionState | null>(null);
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
  const [canonicalSessionState, setCanonicalSessionState] = useState<CanonicalSessionState | null>(null);
  const [canonicalInitialRefreshSettled, setCanonicalInitialRefreshSettled] = useState(!isNativeShell);
  const [canonicalInitialRefreshError, setCanonicalInitialRefreshError] = useState(false);
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
  const messageSelectionDragRef = useRef<{ conversationId: string; shouldSelect: boolean } | null>(null);
  const canonicalRefreshFlightRef = useRef(createSingleFlightState());
  const pendingParticipantSpaceCreateRef = useRef<Map<string, string>>(new Map());

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
    isDesktopChatSending: isDesktopBridgeSending,
    setIsDesktopChatSending: setIsDesktopBridgeSending,
    desktopLiveTurnsBySession,
    setDesktopLiveTurnsBySession,
    pendingUserChatMessage,
    setPendingUserChatMessage,
    queuedDesktopMessagesBySession,
    setQueuedDesktopMessagesBySession,
    cachedChatSessionMessages,
    cachedProjectSessionMessages,
    localSessionUnreadCounts,
    incrementUnreadForSession,
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
    isSessionPanelCollapsed,
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
    setCloudBridgeState,
    mergedBridgeState: desktopBridgeState,
    sendCloudBridgeMessage,
    sendCloudGroupControl,
    recordCloudSessionFork,
    updateCloudSessionPin,
    hideCloudSession,
    deleteCloudSession,
    cancelCloudBridgeAgentRequest,
    refreshCloudBridgeMessages,
    refreshCloudAgents,
    createCloudAgentDefinition,
    updateCloudAgentDefinition,
    archiveCloudAgentDefinition,
    refreshSharedCloudAgents,
    sharedCloudAgents,
    cloudAgentDefinitionsById,
    refreshCloudContacts,
    cloudSessionActivity,
    refreshCloudSessionActivity,
    publishCloudTaskActivity,
    publishCloudArtifactActivity,
    initialContactsSettled,
    initialMessagesSettled,
    cachedMessagesReady,
    cloudHiddenSessionIds,
    cloudDeletedSessionIds,
    cloudSessionPinsById,
    cloudSelfAgentSyncStatusBySessionId,
  } = useCloudBridgeState({
    account: cloudSession.account,
    activeConversationId: activeConvId,
    canonicalSessionState,
    setCanonicalSessionState,
    cloudAgentRuntimeRoutesBySessionId,
    defaultCloudAgentRuntimeRoute,
  });

  // main-cloud keeps a Bridge-shaped UI adapter for existing components, but the
  // data source is Cloud-native only. Do not merge localhost Bridge state here.
  const setDesktopBridgeState = setCloudBridgeState;
  const [bridgeSettingsDraft, setBridgeSettingsDraft] = useState<BridgeSettingsDraft | null>(null);
  const isDesktopBridgeSaving = false;
  const [desktopBridgeError, setDesktopBridgeError] = useState<string | null>(null);
  const isBridgePolling = false;
  const lastBridgePollAt = null;
  const [bridgeInvite] = useState<DesktopBridgeInvite | null>(null);
  const [isProjectBridgeBusy] = useState(false);
  const [bridgeWizardOpen, setBridgeWizardOpen] = useState(false);
  const [bridgeWizardStep, setBridgeWizardStep] = useState<1 | 2 | 3>(1);
  const [bridgeWizardDraft, setBridgeWizardDraft] = useState<BridgeWizardDraft>({
    mode: 'have-url',
    serverUrl: '',
    displayName: '',
    ownerName: '',
  });

  const removedLocalBridgeAction = useCallback(async (..._args: unknown[]) => {
    const message = 'This connection action is unavailable.';
    setDesktopBridgeError(message);
    throw new Error(message);
  }, []);

  const refreshDesktopBridge = useCallback(async () => {
    await refreshCloudBridgeMessages();
  }, [refreshCloudBridgeMessages]);

  const handleCopyBridgeText = useCallback(async (value: string, successMessage = 'Copied to clipboard') => {
    try {
      await navigator.clipboard.writeText(value);
      setDesktopBridgeError(successMessage);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to copy details');
    }
  }, []);

  const handleSaveBridgeSettings = removedLocalBridgeAction;
  const handleSelectBridgeHost = removedLocalBridgeAction;
  const handleRemoveBridgeHost = removedLocalBridgeAction;
  const handleCreateBridgeDraft = useCallback(() => {
    setBridgeSettingsDraft(null);
  }, []);
  const openBridgeWizard = useCallback(() => {
    setBridgeWizardOpen(false);
    setDesktopBridgeError('This connection action is unavailable.');
  }, []);
  const handleBridgeWizardPrimary = removedLocalBridgeAction;
  const handleOpenBridgeConfigFolder = removedLocalBridgeAction;
  const handleRevealBridgeStorageFile = removedLocalBridgeAction;
  const handleExportBridgeHostsConfig = removedLocalBridgeAction;
  const handleImportBridgeHostsConfig = removedLocalBridgeAction;

  const avatarBridgeHost = desktopBridgeState?.hosts.find((host) => host.id === desktopBridgeState.activeHostId)
    ?? desktopBridgeState?.hosts[0]
    ?? null;
  const avatarBridgeHostAgentId = avatarBridgeHost?.activeAgentId ?? null;
  const avatarBridgeAgent = avatarBridgeHost?.agents.find((agent) => agent.id === avatarBridgeHostAgentId)
    ?? avatarBridgeHost?.agents.find((agent) => agent.isActive)
    ?? avatarBridgeHost?.agents.find((agent) => agent.isDefault)
    ?? avatarBridgeHost?.agents[0]
    ?? null;
  const canonicalLocalProfileAvatarSeed = canonicalAvatarSeed(canonicalSessionState, canonicalSessionState?.profile.humanIdentityId)
    || avatarBridgeHost?.humanId?.trim()
    || canonicalSessionState?.profile.id?.trim()
    || null;
  const canonicalLocalProfileImageUrl = canonicalProfileImageUrl(canonicalSessionState, canonicalSessionState?.profile.humanIdentityId)
    || avatarBridgeHost?.profileImageUrl?.trim()
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
    || avatarBridgeHost?.ownerName?.trim()
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
    || avatarBridgeAgent?.label?.trim()
    || avatarBridgeHost?.displayName?.trim()
    || null;
  const localAgentAvatarSeed = canonicalLocalAgentAvatarSeed(canonicalSessionState)
    || avatarBridgeAgent?.id?.trim()
    || avatarBridgeHost?.activeAgentId?.trim()
    || avatarBridgeAgent?.nodeId?.trim()
    || avatarBridgeHost?.nodeId?.trim()
    || null;
  localAvatarSeedsRef.current.human = localProfileAvatarSeed;
  localAvatarSeedsRef.current.humanDisplayName = localProfileDisplayName;
  localAvatarSeedsRef.current.humanProfileImageUrl = localProfileImageUrl;
  localAvatarSeedsRef.current.agent = localAgentAvatarSeed;
  localAvatarSeedsRef.current.agentDisplayName = localAgentDisplayName;

  const desktopCanonicalRefreshKey = useMemo(
    () => [
      desktopChatState?.activeSessionId ?? '',
      desktopChatState?.activeSession.messages.length ?? 0,
      ...(desktopChatState?.sessions ?? []).map((session) => `${session.id}:${session.messageCount}:${session.updatedAtLabel}`),
      ...(desktopChatState?.projects ?? []).flatMap((project) => [
        `${project.id}:${project.root}:${project.name}:${project.sessions.length}`,
        ...project.sessions.map((session) => `${project.id}:${session.id}:${session.messageCount}:${session.updatedAtLabel}`),
      ]),
    ].join('|'),
    [desktopChatState],
  );

  const bridgeCanonicalRefreshKey = useMemo(
    () => (desktopBridgeState?.conversations ?? []).map((conversation) => `${conversation.id}:${conversation.updatedAtMs}:${conversation.messages.length}`).join('|'),
    [desktopBridgeState?.conversations],
  );

  const refreshCanonicalState = useCallback(async () => {
    if (!isNativeShell) {
      setCanonicalInitialRefreshSettled(true);
      return;
    }
    const flight = canonicalRefreshFlightRef.current;
    const run = requestSingleFlightRun(flight, async () => {
      try {
        const fetchedCanonicalState = await fetchCanonicalSessionState();
        setCanonicalSessionState((current) => mergeCanonicalStatePreservingBridgeUiMessages(fetchedCanonicalState, current));
        setCanonicalInitialRefreshError(false);
      } catch {
        setCanonicalInitialRefreshError(true);
        // Canonical state is additive during migration; legacy UI remains usable if it is unavailable.
      } finally {
        setCanonicalInitialRefreshSettled(true);
      }
    });
    await (run ?? flight.currentPromise ?? Promise.resolve());
  }, [isNativeShell]);

  useEffect(() => {
    void refreshCanonicalState();
  }, [bridgeCanonicalRefreshKey, desktopCanonicalRefreshKey, refreshCanonicalState]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setCloudInitialSyncNow(Date.now());
    }, CLOUD_INITIAL_SYNC_TIMEOUT_MS + 25);
    return () => window.clearTimeout(timeoutId);
  }, [cloudInitialSyncStartedAt]);

  const retryCloudInitialSync = useCallback(() => {
    setCanonicalInitialRefreshSettled(false);
    setCanonicalInitialRefreshError(false);
    const now = Date.now();
    setCloudInitialSyncStartedAt(now);
    setCloudInitialSyncNow(now);
    void refreshCanonicalState();
    void refreshCloudContacts();
    void refreshCloudBridgeMessages();
  }, [refreshCanonicalState, refreshCloudBridgeMessages, refreshCloudContacts]);

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

  const {
    chatConversations,
    filteredConversations,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    activeConv,
    activeConversationIsBridge,
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
    activeBridgeHost,
    activeProjectBridgeProject,
    activeBridgeConversation,
    activeBridgeConversationHost,
    activeBridgePeople,
    activeBridgeAgents,
    activeBridgeAwaitingReply,
  } = useWorkspaceViewModels({
    isNativeShell,
    isDesktopChatLoading,
    desktopChatState,
    desktopBridgeState,
    canonicalSessionState,
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
  });

  const onReplyMessage = useCallback((message: Message) => {
    const source = messageActionSourceFromMessage(message, activeConv.canonicalSessionId ?? activeConv.id ?? chatDraftSessionId);
    if (!source) return;
    composerUi.setChatQuoteBySessionId((current) => ({
      ...current,
      [chatDraftSessionId]: { action: 'quote', source },
    }));
    focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, isNativeShell);
  }, [activeConv.canonicalSessionId, activeConv.id, chatDraftSessionId, composerUi.setChatQuoteBySessionId, isNativeShell]);
  const onForwardMessage = useCallback((message: Message) => {
    const source = messageActionSourceFromMessage(message, activeConv.canonicalSessionId ?? activeConv.id ?? chatDraftSessionId);
    if (!source) return;
    const destinations = buildForwardDestinations(chatConversations, LOCAL_DRAFT_CHAT_CONVERSATION_ID);
    if (!destinations.length) return;
    setForwardDialog({ sources: [source], destinations });
  }, [activeConv.canonicalSessionId, activeConv.id, chatConversations, chatDraftSessionId]);

  const sourceForSelectableMessage = useCallback((message: Message) => (
    messageActionSourceFromMessage(message, activeConv.canonicalSessionId ?? activeConv.id ?? chatDraftSessionId)
  ), [activeConv.canonicalSessionId, activeConv.id, chatDraftSessionId]);

  const isMessageSelectable = useCallback((message: Message) => Boolean(sourceForSelectableMessage(message)), [sourceForSelectableMessage]);

  const onSelectMessage = useCallback((message: Message) => {
    const source = sourceForSelectableMessage(message);
    if (!source) return;
    setMessageSelection({
      conversationId: activeConv.id,
      sourcesByMessageId: new Map([[source.sourceMessageId, source]]),
    });
  }, [activeConv.id, sourceForSelectableMessage]);

  const onToggleSelectedMessage = useCallback((message: Message) => {
    const source = sourceForSelectableMessage(message);
    if (!source) return;
    setMessageSelection((current) => toggleMessageSelectionSource(current, activeConv.id, source));
  }, [activeConv.id, sourceForSelectableMessage]);

  const onCancelMessageSelection = useCallback(() => {
    messageSelectionDragRef.current = null;
    setMessageSelection(null);
  }, []);

  const onSelectionDragStart = useCallback((message: Message, shouldSelect: boolean) => {
    const source = sourceForSelectableMessage(message);
    if (!source) return;
    messageSelectionDragRef.current = { conversationId: activeConv.id, shouldSelect };
    setMessageSelection((current) => setMessageSelectionSource(current, activeConv.id, source, shouldSelect));
  }, [activeConv.id, sourceForSelectableMessage]);

  const onSelectionDragEnter = useCallback((message: Message) => {
    const drag = messageSelectionDragRef.current;
    if (!drag || drag.conversationId !== activeConv.id) return;
    const source = sourceForSelectableMessage(message);
    if (!source) return;
    setMessageSelection((current) => setMessageSelectionSource(current, activeConv.id, source, drag.shouldSelect));
  }, [activeConv.id, sourceForSelectableMessage]);

  const onSelectionDragEnd = useCallback(() => {
    messageSelectionDragRef.current = null;
  }, []);

  const activeMessageSelection = messageSelection?.conversationId === activeConv.id ? messageSelection : null;
  const selectedMessageIds = useMemo(
    () => new Set(activeMessageSelection?.sourcesByMessageId.keys() ?? []),
    [activeMessageSelection?.sourcesByMessageId],
  );
  const selectedMessageCount = selectedMessageIds.size;

  const orderedSelectedMessageSources = useCallback(() => {
    if (!activeMessageSelection || activeMessageSelection.sourcesByMessageId.size === 0) return [];
    const orderedMessageIds = activeConv.messages
      .map((message) => message.id?.trim() || message.entryId?.trim() || '')
      .filter(Boolean);
    return orderedForwardSourcesForMessageIds(orderedMessageIds, activeMessageSelection.sourcesByMessageId);
  }, [activeConv.messages, activeMessageSelection]);

  const onCopySelectedMessages = useCallback(() => {
    const sources = orderedSelectedMessageSources();
    if (sources.length === 0) return;
    const copyText = formatSelectedMessagesForCopy(sources);
    void handleCopyBridgeText(copyText, 'Selected messages copied');
  }, [handleCopyBridgeText, orderedSelectedMessageSources]);

  const onForwardSelectedMessages = useCallback(() => {
    const sources = orderedSelectedMessageSources();
    if (sources.length === 0) return;
    const destinations = buildForwardDestinations(chatConversations, LOCAL_DRAFT_CHAT_CONVERSATION_ID);
    if (!destinations.length) return;
    setForwardDialog({ sources, destinations });
  }, [chatConversations, orderedSelectedMessageSources]);

  useEffect(() => {
    messageSelectionDragRef.current = null;
    setMessageSelection((current) => (current && current.conversationId !== activeConv.id ? null : current));
  }, [activeConv.id]);

  const handleConfirmForwardMessage = useCallback((destination: ForwardDestination, caption: string) => {
    const senderIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    const sources = forwardDialog?.sources ?? [];
    if (!senderIdentityId || sources.length === 0) return;
    const drafts = createForwardedMessageDrafts({ sources, caption });
    const now = Date.now();
    setForwardDialog(null);
    setMessageSelection(null);
    const directCloudConversationId = isCloudBridgeConversationId(destination.conversationId) ? destination.conversationId : null;
    if (directCloudConversationId && sendCloudBridgeMessage) {
      setActiveConvId(directCloudConversationId);
      void (async () => {
        for (const draft of drafts) {
          const body = encodeCloudDirectMessageEnvelope({
            schemaVersion: 1,
            kind: 'message',
            text: draft.text,
            messageAction: draft.messageAction,
          });
          await sendCloudBridgeMessage(directCloudConversationId, body, []);
        }
        revealForwardedMessageInDestination({
          destinationConversationId: directCloudConversationId,
          forwardedMessageId: null,
          setActiveConversationId: setActiveConvId,
          revealMessage: (messageId) => navigateToTranscriptMessageOrScrollBottom(messageId, chatTranscriptScrollRef),
          revealLatest: () => scrollTranscriptToBottom(chatTranscriptScrollRef),
        });
      })().catch((error: unknown) => {
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to forward messages');
      });
      return;
    }
    const destinationConversation = chatConversations.find((conversation) => (
      conversation.id === destination.conversationId
      || conversation.id === destination.id
      || conversation.canonicalSessionId === destination.id
    )) ?? null;
    void (async () => {
      let lastForwardMessageId: string | null = null;
      for (const [index, draft] of drafts.entries()) {
        const source = sources[index];
        if (!source) continue;
        const forwardMessageId = `msg:forward:${destination.id}:${source.sourceMessageId}:${now}:${index}`;
        lastForwardMessageId = forwardMessageId;
        const nextState = await appendCanonicalMessage({
          id: forwardMessageId,
          sessionId: destination.id,
          senderIdentityId,
          senderRole: 'user',
          messageKind: 'text',
          contentText: draft.text,
          content: {
            forwardedFrom: draft.forwardedFrom,
            messageAction: draft.messageAction,
          },
          createdAtMs: now + index,
          parentMessageId: null,
          status: 'sent',
          sourceTransport: 'desktop-forward',
          sourceEventId: `desktop-forward:${destination.id}:${source.sourceMessageId}:${now}:${index}`,
        });
        setCanonicalSessionState(nextState);
        if (destinationConversation && sendCloudGroupControl && cloudSession.account) {
          const groupScope = {
            canonicalSessionId: destination.id,
            participantSpaceId: destinationConversation.participantSpaceId,
            directness: destinationConversation.directness,
            canonicalParticipants: destinationConversation.canonicalParticipants,
          };
          if (isBridgeGroupSession(groupScope)) {
            const activeBridgeHost = desktopBridgeState?.hosts.find((host) => host.id === desktopBridgeState.activeHostId)
              ?? desktopBridgeState?.hosts[0]
              ?? null;
            const selfPublicBridgeName = activeBridgeHost?.ownerName?.trim()
              || activeBridgeHost?.displayName?.trim()
              || null;
            const selfBridgeNodeIds = new Set(
              (desktopBridgeState?.hosts ?? [])
                .map((host) => host.nodeId?.trim())
                .filter((value): value is string => Boolean(value)),
            );
            const targets = bridgeGroupSessionSendTargets(groupScope, null, selfBridgeNodeIds);
            const targetAccountIds = cloudGroupTargetAccountIds(targets);
            if (targetAccountIds.length > 0) {
              const groupSpaceId = bridgeGroupSessionSpaceId(groupScope);
              await sendCloudGroupControl({
                targetAccountIds,
                kind: 'group-message',
                groupId: cloudGroupMessageSessionId({ activeConvCanonicalSessionId: destination.id, activeGroupSessionSpaceId: groupSpaceId }),
                groupSpaceId,
                groupTitle: null,
                bridgeParticipants: bridgeGroupSessionParticipants(groupScope, { selfPublicName: selfPublicBridgeName }),
                message: {
                  id: forwardMessageId,
                  senderAccountId: '',
                  text: draft.text,
                  createdAtMs: now + index,
                  messageAction: draft.messageAction,
                },
              });
            }
          }
        }
      }
      revealForwardedMessageInDestination({
        destinationConversationId: destination.id,
        forwardedMessageId: lastForwardMessageId,
        setActiveConversationId: setActiveConvId,
        revealMessage: (messageId) => navigateToTranscriptMessageOrScrollBottom(messageId, chatTranscriptScrollRef),
        revealLatest: () => scrollTranscriptToBottom(chatTranscriptScrollRef),
      });
    })().catch((error: unknown) => {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to forward messages');
    });
  }, [canonicalSessionState?.profile.humanIdentityId, chatConversations, cloudSession.account, desktopBridgeState?.activeHostId, desktopBridgeState?.hosts, forwardDialog?.sources, sendCloudBridgeMessage, sendCloudGroupControl, setActiveConvId, setCanonicalSessionState, setDesktopChatError]);

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

  const bridgeMentionTargetsByScope = useMemo(() => buildBridgeMentionTargetsByScope({
    isNativeShell,
    desktopBridgeState,
    desktopChatState,
    activeConvMentionScope,
    conversations: chatConversations,
    sharedCloudAgents: mentionableCloudAgents,
  }), [activeConvMentionScope, chatConversations, desktopBridgeState, desktopChatState, isNativeShell, mentionableCloudAgents]);

  const chatMentionQuery = useMemo(() => currentMentionQuery(composerDraftsView.chat), [composerDraftsView.chat]);
  const projectMentionQuery = useMemo(() => currentMentionQuery(composerDraftsView.project), [composerDraftsView.project]);
  const filteredChatMentionTargets = useMemo(() => filterMentionTargets(bridgeMentionTargetsByScope.chat, chatMentionQuery), [bridgeMentionTargetsByScope.chat, chatMentionQuery]);
  const filteredProjectMentionTargets = useMemo(() => filterMentionTargets(bridgeMentionTargetsByScope.project, projectMentionQuery), [bridgeMentionTargetsByScope.project, projectMentionQuery]);

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

  const bridgeContactRequests = useMemo(
    () => bridgeContactRequestsForContactsPage(activeBridgeHost),
    [activeBridgeHost],
  );
  const contactRequests = isNativeShell ? bridgeContactRequests : demoContactRequests;

  const {
    activeContactRequest,
    activeSettingsSection,
    activeProjectBridgeHost,
    activeDesktopLiveTurn,
    isDesktopChatSending,
    activeChatArtifacts,
    activeProjectArtifacts,
  } = useKordiDesktopActivity({
    activeContactRequestId: contactsUi.activeContactRequestId,
    activeSettingsSectionId: visibleActiveSettingsSectionId,
    settingsSections: visibleSettingsSections,
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
    setActiveSourcePreview: settingsUi.setActiveSourcePreview,
    setActiveArtifactId: settingsUi.setActiveArtifactId,
    setActiveDetailTab,
    isDetailPanelCollapsed,
    lastSeenArtifactByContextRef,
    cloudSessionActivity,
  });

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
    displayedContacts,
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
    activeConversationIsBridge,
    setDesktopSessionRenameDraft: sessionUi.setDesktopSessionRenameDraft,
    setIsEditingDesktopSessionTitle: sessionUi.setIsEditingDesktopSessionTitle,
    setComposerSelections: composerUi.setComposerSelections,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
    activeConvMessagesLength: activeConv.messages.length,
    activeLastMessageTime: activeLastMessage?.time,
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

  const handleOpenBridgeConversation = useCallback(async (
    hostId: string,
    peerNodeId: string,
    _peerDisplayName?: string | null,
    _peerOwnerName?: string | null,
    peerRuntime?: string | null,
    _project?: DesktopBridgeProject | null,
  ) => {
    if (hostId !== CLOUD_HOST_SENTINEL) {
      await removedLocalBridgeAction();
      return;
    }
    setActiveNav('chats');
    setActiveConvId(cloudBridgeConversationId(peerNodeId, peerRuntime ?? 'person'));
    setDesktopChatError(null);
  }, [removedLocalBridgeAction, setActiveConvId, setActiveNav, setDesktopChatError]);

  const handleStartBridgePersonSession = useCallback(async (target: {
    hostId: string;
    nodeId: string;
    displayName?: string | null;
    ownerName?: string | null;
    humanId?: string | null;
  }) => {
    if (target.hostId !== CLOUD_HOST_SENTINEL) {
      await removedLocalBridgeAction();
      return;
    }
    setActiveNav('chats');
    setActiveConvId(cloudBridgeConversationId(target.nodeId, 'person'));
    setDesktopChatError(null);
  }, [removedLocalBridgeAction, setActiveConvId, setActiveNav, setDesktopChatError]);

  const handleAddBridgeContact = removedLocalBridgeAction;
  const handleActivateBridgeAgent = removedLocalBridgeAction;
  const handleCreateBridgeAgent = removedLocalBridgeAction;
  const handleCreateProjectBridgeInvite = removedLocalBridgeAction;
  const handleRemoveBridgeContact = removedLocalBridgeAction;
  const handleSetBridgeDiscoveryMode = removedLocalBridgeAction;
  const handleSetBridgeHostPrivacyPolicy = removedLocalBridgeAction;
  const handleSetBridgeAgentReachabilityPolicy = removedLocalBridgeAction;
  const handleApproveBridgeContactRequest = removedLocalBridgeAction;
  const handleRejectBridgeContactRequest = removedLocalBridgeAction;
  const handleSetDefaultBridgeAgent = removedLocalBridgeAction;
  const handleUpdateBridgeAgentModelRouting = removedLocalBridgeAction;
  const handleStartLocalBridgeHost = removedLocalBridgeAction;
  const handleStopLocalBridgeHost = removedLocalBridgeAction;
  const handleUpdateLocalAgentModelRouting = removedLocalBridgeAction;


  const handleUpdateBridgeAgentModelRoutingForActiveSession = useCallback(async (
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
    if (isCloudBridgeHostId(hostId)) {
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

    await handleUpdateBridgeAgentModelRouting(
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
    handleUpdateBridgeAgentModelRouting,
    setDesktopChatError,
  ]);

  const syncCloudGroupFork = useCallback(async (result: { forkedSessionId: string; sourceSessionId: string; sourceMessageId: string }) => {
    if (!cloudSession.account) return;
    const state = await fetchCanonicalSessionState();
    if (!state) return;
    setCanonicalSessionState(state);
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
      // eslint-disable-next-line no-console
      console.warn('[cloud-fork] failed to record cloud fork lineage', error);
    });

    if (forkSession.kind !== 'group') return;
    const participants = canonicalGroupParticipantsForSession(state, result.forkedSessionId)
      .filter((participant) => participant.kind === 'human');
    const cloudParticipants: CloudGroupParticipant[] = participants.flatMap((participant) => {
      const accountId = participant.humanId?.trim() || participant.bridgeNodeId?.trim() || '';
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
      if (identity.kind === 'human') return identity.humanId?.trim() || identity.bridgeNodeId?.trim() || cloudSession.account?.accountId || '';
      if (identity.humanId?.trim()) return identity.humanId.trim();
      if (identity.id.startsWith('agent:cloud:')) return identity.id.slice('agent:cloud:'.length);
      const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : null;
      return owner?.humanId?.trim() || owner?.bridgeNodeId?.trim() || cloudSession.account?.accountId || '';
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
  }, [cloudSession.account, recordCloudSessionFork, sendCloudGroupControl, setCanonicalSessionState]);

  const {
    handleSelectChatSession,
    handleCreateChatSession,
    handleSelectProjectSession,
    handleRenameDesktopSession,
    handleForkChatMessage,
  } = useDesktopSessionController({
    isNativeShell,
    activeConversationIsBridge,
    activeConvId,
    desktopChatState,
    desktopSessionRenameDraft: sessionUi.desktopSessionRenameDraft,
    selectProjectSession,
    refreshDesktopChat,
    shouldAutoFollowChatRef,
    setActiveConvId,
    setPendingUserChatMessage,
    setChatComposerAttachments: composerUi.setChatComposerAttachments,
    setDesktopBridgeState,
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
    handleSendProjectMessage,
    handleStopDesktopChatTurn,
    handleStopBridgeAgentRequest,
  } = useComposerController({
    isNativeShell,
    activeConversationIsBridge,
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
    activeConvBridgeTarget: activeConv.bridgeTarget,
    activeConvMentionScope,
    sharedCloudAgents: mentionableCloudAgents,
    resolveSharedCloudAgentsForMention,
    activeProjectId,
    activeProjectSessionId,
    activeProjectRoot: activeProject.root,
    selectProjectSession,
    desktopChatState,
    desktopBridgeState,
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
    isDesktopChatSending: isDesktopBridgeSending,
    setIsDesktopChatSending: setIsDesktopBridgeSending,
    setPendingUserChatMessage,
    queuedDesktopMessagesBySession,
    setQueuedDesktopMessagesBySession,
    setDesktopLiveTurnsBySession,
    setDesktopBridgeState,
    setCloudBridgeState,
    sendCloudBridgeMessage,
    sendCloudGroupControl,
    cancelCloudBridgeAgentRequest,
    watchDesktopLiveTurn,
    shouldAutoFollowChatRef,
    setActiveConvId,
  });

  const handleSendChatMessageWithQuoteClear = useCallback((draftOverride?: string, targetSessionId?: string, contextMessages?: DesktopChatContextMessage[]) => (
    sendChatMessageWithImmediateQuoteClear({
      draftOverride,
      targetSessionId,
      contextMessages,
      currentDraft: composerDraftsView.chat,
      attachmentCount: composerUi.chatComposerAttachments.length,
      activeChatQuote,
      send: handleSendChatMessage,
      clearQuote: onClearChatQuote,
    })
  ), [activeChatQuote, composerDraftsView.chat, composerUi.chatComposerAttachments.length, handleSendChatMessage, onClearChatQuote]);

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

  const optimisticallyRemoveChatSession = useCallback((sessionId: string) => {
    const fallbackSessionId = desktopChatState?.sessions.find((session) => session.id !== sessionId)?.id
      ?? LOCAL_DRAFT_CHAT_CONVERSATION_ID;
    setLocallyHiddenSessionIds((current) => new Set(current).add(sessionId));
    setDesktopChatState((current) => removeSessionFromDesktopState(current, sessionId));
    setCanonicalSessionState((current) => removeSessionFromCanonicalState(current, sessionId));
    composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'chat', sessionId, ''));
    if (activeConvId === sessionId || desktopChatState?.activeSessionId === sessionId) {
      setActiveConvId(fallbackSessionId);
    }
  }, [activeConvId, composerUi.setComposerDrafts, desktopChatState?.activeSessionId, desktopChatState?.sessions, setActiveConvId, setDesktopChatState]);

  const appendRenameNotice = useCallback(async (
    state: CanonicalSessionState,
    sessionId: string,
    title: string,
    scope: 'group' | 'session',
    actorIdentityId: string,
  ) => {
    const actorName = canonicalIdentityDisplayName(state, actorIdentityId);
    const now = Date.now();
    return appendCanonicalMessage({
      sessionId,
      senderIdentityId: actorIdentityId,
      senderRole: 'system',
      messageKind: 'status',
      contentText: sessionRenameNoticeText(actorName, title, scope),
      content: {
        kind: 'session-title-update',
        scope,
        title,
        actorDisplayName: actorName,
      },
      createdAtMs: now,
      status: 'complete',
      sourceTransport: 'desktop-local-session-update',
      sourceEventId: `desktop-local-session-update:${sessionId}:${scope}:${now}`,
    });
  }, []);

  const syncGroupSessionTitleRename = useCallback(async (
    state: CanonicalSessionState,
    sessionId: string,
    title: string,
    actorIdentityId: string,
  ) => {
    const participants = canonicalGroupParticipantsForSession(state, sessionId);
    const targets = buildChatGroupBridgeUpdateTargets({ actorIdentityId, participants });
    if (targets.length === 0) return;
    const updateParticipants = buildChatGroupBridgeUpdateParticipants({
      participants,
      adminIdentityIds: activeGroupAdminIds(state, sessionId),
    });
    const currentMetadata = sessionMetadataRecord(state, sessionId);
    const parentGroupSpaceId = metadataGroupSpaceId(currentMetadata) || sessionId;
    const cloudTargetAccountIds = cloudGroupTargetAccountIds(targets);
    if (cloudTargetAccountIds.length > 0 && cloudSession.account) {
      await sendCloudGroupControl({
        targetAccountIds: cloudTargetAccountIds,
        kind: 'session-title-update',
        groupId: sessionId,
        groupSpaceId: parentGroupSpaceId,
        groupTitle: title,
        participants: cloudGroupParticipantsForBridgeSessionParticipants(cloudSession.account, updateParticipants),
      });
    }
  }, [cloudSession.account, sendCloudGroupControl]);

  const handleRenameChatSession = useCallback(async (sessionId: string, title: string) => {
    if (!isNativeShell || !sessionId.trim()) return;
    const nextTitle = title.trim();
    if (!nextTitle) return;
    const actorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim() || undefined;
    const isDesktopRuntimeSession = (desktopChatState?.sessions ?? []).some((session) => session.id === sessionId);
    try {
      setDesktopChatError(null);
      let nextCanonical = await renameCanonicalSession({
        sessionId,
        title: nextTitle,
        requestedByIdentityId: actorIdentityId,
      });
      const renamedSession = nextCanonical.sessions.find((session) => session.id === sessionId);
      if (actorIdentityId && renamedSession?.kind === 'group') {
        nextCanonical = await appendRenameNotice(nextCanonical, sessionId, nextTitle, 'session', actorIdentityId);
      }
      setCanonicalSessionState(nextCanonical);
      if (isDesktopRuntimeSession) {
        const nextDesktop = await renameDesktopChatSession(sessionId, nextTitle);
        setDesktopChatState(nextDesktop);
      } else {
        await refreshDesktopChat();
      }
      if (actorIdentityId && renamedSession?.kind === 'group') {
        try {
          await syncGroupSessionTitleRename(nextCanonical, sessionId, nextTitle, actorIdentityId);
        } catch (error) {
          setDesktopChatError(`Session renamed, but Bridge rename sync failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      await refreshCanonicalState();
      const message = error instanceof Error ? error.message : 'Unable to rename session';
      setDesktopChatError(message);
    }
  }, [appendRenameNotice, canonicalSessionState?.profile.humanIdentityId, desktopChatState?.sessions, isNativeShell, refreshCanonicalState, refreshDesktopChat, setCanonicalSessionState, setDesktopChatError, setDesktopChatState, syncGroupSessionTitleRename]);

  const handleArchiveChatSession = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!isNativeShell || !trimmedSessionId) return;

    try {
      setDesktopChatError(null);
      if (shouldUseCloudSessionAction(trimmedSessionId)) {
        await hideCloudSession(trimmedSessionId);
        optimisticallyRemoveChatSession(trimmedSessionId);
        await refreshCanonicalState();
        return;
      }

      optimisticallyRemoveChatSession(trimmedSessionId);
      const nextState = await archiveDesktopChatSession(trimmedSessionId, desktopChatState?.activeSessionId);
      setDesktopChatState(nextState);
      if (activeConvId === trimmedSessionId || desktopChatState?.activeSessionId === trimmedSessionId) {
        setActiveConvId(nextState.activeSessionId);
      }
      await refreshCanonicalState();
    } catch (error) {
      await refreshCanonicalState();
      const message = error instanceof Error ? error.message : 'Unable to hide session';
      setDesktopChatError(message.startsWith('Session not found') ? null : message);
      if (shouldUseCloudSessionAction(trimmedSessionId)) throw error;
    }
  }, [activeConvId, desktopChatState?.activeSessionId, hideCloudSession, isNativeShell, optimisticallyRemoveChatSession, refreshCanonicalState, setActiveConvId, setDesktopChatError, setDesktopChatState]);

  const handleDeleteChatSession = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!isNativeShell || !trimmedSessionId) return;

    try {
      setDesktopChatError(null);
      if (shouldUseCloudSessionAction(trimmedSessionId)) {
        await deleteCloudSession(trimmedSessionId);
        optimisticallyRemoveChatSession(trimmedSessionId);
        try {
          const nextState = await archiveDesktopChatSession(trimmedSessionId, desktopChatState?.activeSessionId);
          setDesktopChatState(nextState);
          if (activeConvId === trimmedSessionId || desktopChatState?.activeSessionId === trimmedSessionId) {
            setActiveConvId(nextState.activeSessionId);
          }
        } catch (localError) {
          const localMessage = localError instanceof Error ? localError.message : String(localError);
          if (!localMessage.startsWith('Session not found')) throw localError;
        }
        await refreshCanonicalState();
        return;
      }

      optimisticallyRemoveChatSession(trimmedSessionId);
      const nextState = await archiveDesktopChatSession(trimmedSessionId, desktopChatState?.activeSessionId);
      setDesktopChatState(nextState);
      if (activeConvId === trimmedSessionId || desktopChatState?.activeSessionId === trimmedSessionId) {
        setActiveConvId(nextState.activeSessionId);
      }
      await refreshCanonicalState();
    } catch (error) {
      await refreshCanonicalState();
      const message = error instanceof Error ? error.message : 'Unable to remove chat';
      setDesktopChatError(message.startsWith('Session not found') ? null : message);
      if (shouldUseCloudSessionAction(trimmedSessionId)) throw error;
    }
  }, [activeConvId, deleteCloudSession, desktopChatState?.activeSessionId, isNativeShell, optimisticallyRemoveChatSession, refreshCanonicalState, setActiveConvId, setDesktopChatError, setDesktopChatState]);

  const handleMoveChatSessionToProject = useCallback(async (sessionId: string, requestedProjectRoot: string) => {
    if (!isNativeShell || !sessionId.trim()) return;

    try {
      setDesktopChatError(null);
      const nextState = await moveDesktopChatSessionToProject(sessionId, requestedProjectRoot);
      setDesktopChatState(nextState);

      const resolvedProjectRoot = nextState.activeSession.project?.root ?? requestedProjectRoot;
      const resolvedProjectId = canonicalProjectGroupIdFromRoot(resolvedProjectRoot) ?? resolvedProjectRoot;
      if (resolvedProjectId) {
        selectProjectSession(resolvedProjectId, nextState.activeSessionId);
        projectsUi.setExpandedProjectIds((current) => ({ ...current, [resolvedProjectId]: true }));
      }
      setActiveNav('projects');
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to move session to project');
    }
  }, [isNativeShell, projectsUi.setExpandedProjectIds, selectProjectSession, setActiveNav, setDesktopChatError, setDesktopChatState]);

  const handleSelectCreatedProject = useCallback(async (projectRoot: string) => {
    const projectId = canonicalProjectGroupIdFromRoot(projectRoot) ?? projectRoot;
    setActiveNav('projects');
    selectProject(projectId);
    projectsUi.setExpandedProjectIds((current) => ({ ...current, [projectId]: true }));
    await refreshDesktopChat(desktopChatState?.activeSessionId);
    await refreshCanonicalState();
  }, [desktopChatState?.activeSessionId, projectsUi.setExpandedProjectIds, refreshCanonicalState, refreshDesktopChat, selectProject, setActiveNav]);

  const handleCreateProjectFromFolder = useCallback(async (folderPath: string, name?: string) => {
    if (!isNativeShell) return;
    try {
      setDesktopChatError(null);
      const project = await createDesktopProjectFromFolder(folderPath, name);
      await handleSelectCreatedProject(project.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create project from folder';
      setDesktopChatError(message);
      throw new Error(message);
    }
  }, [handleSelectCreatedProject, isNativeShell, setDesktopChatError]);

  const handleCreateProject = useCallback(async (name: string, parentDir?: string) => {
    if (!isNativeShell) return;
    try {
      setDesktopChatError(null);
      const project = await createDesktopProject(name, parentDir);
      await handleSelectCreatedProject(project.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create project';
      setDesktopChatError(message);
      throw new Error(message);
    }
  }, [handleSelectCreatedProject, isNativeShell, setDesktopChatError]);

  const handleCreateProjectSession = useCallback(async () => {
    if (!isNativeShell) return;
    const projectRoot = activeProject.root?.trim();
    if (!projectRoot) return;

    setDesktopChatError(null);
    const projectId = canonicalProjectGroupIdFromRoot(projectRoot) ?? activeProject.id;
    const draftSessionId = projectDraftSessionId(projectId);
    selectProjectSession(projectId, draftSessionId);
    projectsUi.setExpandedProjectIds((current) => ({ ...current, [projectId]: true }));
    composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'project', draftSessionId, ''));
    composerUi.setChatComposerAttachments([]);
    composerUi.setOpenComposerSelector(null);
    setActiveNav('projects');
  }, [
    activeProject.id,
    activeProject.root,
    composerUi.setChatComposerAttachments,
    composerUi.setComposerDrafts,
    composerUi.setOpenComposerSelector,
    isNativeShell,
    projectsUi.setExpandedProjectIds,
    selectProjectSession,
    setActiveNav,
    setDesktopChatError,
  ]);

  const peopleContactById = useMemo(
    () => buildChatCreatePeopleContactLookup(displayedContacts),
    [displayedContacts],
  );

  const selectNewChatSession = useCallback((sessionId: string) => {
    setActiveNav('chats');
    setActiveConvId(sessionId);
    composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'chat', sessionId, ''));
    composerUi.setChatComposerAttachments([]);
    composerUi.setOpenComposerSelector(null);
  }, [
    composerUi.setChatComposerAttachments,
    composerUi.setComposerDrafts,
    composerUi.setOpenComposerSelector,
    setActiveConvId,
    setActiveNav,
  ]);

  const handleStartChatWithPerson = useCallback(async (contact: Contact) => {
    setDesktopChatError(null);
    if (contact.bridgeHostId === CLOUD_HOST_SENTINEL && contact.bridgePeerNodeId) {
      selectNewChatSession(cloudBridgeConversationId(contact.bridgePeerNodeId, 'person'));
      return;
    }
    if (contact.bridgeHostId && contact.bridgePeerNodeId) {
      await handleStartBridgePersonSession({
        hostId: contact.bridgeHostId,
        nodeId: contact.bridgePeerNodeId,
        displayName: contact.name,
        ownerName: contact.owner,
        humanId: contact.bridgeHumanId,
      });
      return;
    }

    if (!isNativeShell) return;
    const existingSessionId = existingSessionIdForPersonStart(contact, chatConversations);
    if (existingSessionId) {
      selectNewChatSession(existingSessionId);
      return;
    }
    const creatorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const identityRequest = contactCanonicalIdentityRequest(contact);
    const targetIdentityId = identityRequest.id?.trim();
    if (!targetIdentityId) {
      throw new Error('Unable to resolve contact identity.');
    }
    const identity = await upsertCanonicalIdentityFast(identityRequest);
    setCanonicalSessionState((current) => current ? mergeCanonicalIdentity(current, identity) : current);
    const sessionId = chatSessionIdForPersonStart(crypto.randomUUID());
    const openResult = await openOrCreateCanonicalSessionFast({
      id: sessionId,
      kind: 'direct-person',
      title: 'New session',
      status: 'active',
      createdByIdentityId: creatorIdentityId,
      primaryIdentityId: targetIdentityId,
      relationshipIdentityId: targetIdentityId,
      participantIdentityIds: [targetIdentityId],
      metadata: { createdFrom: 'chat-create-flow', contactId: contact.id, participantSpaceKind: 'direct-human' },
    });
    setCanonicalSessionState((current) => current ? mergeOpenCanonicalSessionResult(current, openResult) : current);
    selectNewChatSession(sessionId);
  }, [
    canonicalSessionState?.profile.humanIdentityId,
    chatConversations,
    handleStartBridgePersonSession,
    isNativeShell,
    selectNewChatSession,
    setDesktopChatError,
  ]);

  const handleStartChatWithAgent = useCallback(async (agent: Agent) => {
    setDesktopChatError(null);
    setActiveNav('chats');

    if (agent.isOwned) {
      if (!isNativeShell) {
        await handleCreateChatSession();
        return;
      }
      const creatorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
      if (!creatorIdentityId) {
        throw new Error('Local profile identity is not ready yet.');
      }
      if (agent.bridgeHostId && agent.bridgeAgentId && !agent.isBridgeActive) {
        await handleActivateBridgeAgent(agent.bridgeHostId, agent.bridgeAgentId);
      }
      const existingBlankSessionId = existingBlankSessionIdForAgentStart(agent, chatConversations);
      if (existingBlankSessionId) {
        selectNewChatSession(existingBlankSessionId);
        return;
      }
      const identityRequest = agentCanonicalIdentityRequest(agent);
      const targetIdentityId = identityRequest.id?.trim();
      if (!targetIdentityId) {
        throw new Error('Unable to resolve agent identity.');
      }
      const identity = await upsertCanonicalIdentityFast(identityRequest);
      setCanonicalSessionState((current) => current ? mergeCanonicalIdentity(current, identity) : current);
      const sessionId = chatSessionIdForAgentStart(agent, crypto.randomUUID());
      const openResult = await openOrCreateCanonicalSessionFast({
        id: sessionId,
        kind: buildChatAgentSessionKind(agent),
        title: agent.name || 'New session',
        status: 'active',
        createdByIdentityId: creatorIdentityId,
        primaryIdentityId: targetIdentityId,
        relationshipIdentityId: null,
        participantIdentityIds: [targetIdentityId],
        metadata: buildChatAgentSessionMetadata(agent),
      });
      setCanonicalSessionState((current) => current ? mergeOpenCanonicalSessionResult(current, openResult) : current);
      selectNewChatSession(sessionId);
      return;
    }

    if (agent.bridgeHostId === CLOUD_HOST_SENTINEL && agent.bridgePeerNodeId) {
      selectNewChatSession(cloudBridgeConversationId(agent.bridgePeerNodeId, agent.bridgePeerRuntime ?? 'kordi-desktop'));
      return;
    }

    if (!isNativeShell) return;
    const creatorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const identityRequest = agentCanonicalIdentityRequest(agent);
    const targetIdentityId = identityRequest.id?.trim();
    if (!targetIdentityId) {
      throw new Error('Unable to resolve agent identity.');
    }
    const identity = await upsertCanonicalIdentityFast(identityRequest);
    setCanonicalSessionState((current) => current ? mergeCanonicalIdentity(current, identity) : current);
    const sessionId = chatSessionIdForAgentStart(agent, crypto.randomUUID());
    const openResult = await openOrCreateCanonicalSessionFast({
      id: sessionId,
      kind: buildChatAgentSessionKind(agent),
      title: agent.name || 'New session',
      status: 'active',
      createdByIdentityId: creatorIdentityId,
      primaryIdentityId: targetIdentityId,
      relationshipIdentityId: null,
      participantIdentityIds: [targetIdentityId],
      metadata: buildChatAgentSessionMetadata(agent),
    });
    setCanonicalSessionState((current) => current ? mergeOpenCanonicalSessionResult(current, openResult) : current);
    selectNewChatSession(sessionId);
  }, [
    canonicalSessionState?.profile.humanIdentityId,
    chatConversations,
    handleActivateBridgeAgent,
    handleCreateChatSession,
    isNativeShell,
    selectNewChatSession,
    setActiveNav,
    setDesktopChatError,
  ]);

  const handleCreateChatGroup = useCallback(async (request: { name?: string | null; contactIds: string[] }) => {
    if (!isNativeShell) return;
    setDesktopChatError(null);
    const currentCanonicalState = canonicalSessionState;
    const creatorIdentityId = currentCanonicalState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId || !currentCanonicalState) {
      throw new Error('Local profile identity is not ready yet.');
    }
    let nextCanonicalState = currentCanonicalState;
    if (cloudSession.account) {
      const identity = await upsertCanonicalIdentityFast(cloudGroupIdentityRequest(
        cloudGroupSelfParticipant(cloudSession.account, 'admin'),
        cloudSession.account,
        creatorIdentityId,
      ));
      nextCanonicalState = mergeCanonicalIdentity(nextCanonicalState, identity);
      setCanonicalSessionState(nextCanonicalState);
    }
    const contacts = uniqueStrings(request.contactIds)
      .map((contactId) => peopleContactById.get(contactId))
      .filter((contact): contact is Contact => Boolean(contact));
    if (contacts.length < 2) {
      throw new Error('Select at least 2 people to start a group.');
    }
    const blockedBridgeContacts = contacts.filter((contact) => contact.bridgePeerNodeId && !isApprovedBridgeContact(contact));
    if (blockedBridgeContacts.length > 0) {
      throw new Error('Approve people as contacts before adding them to a group.');
    }

    const identityIds: string[] = [];
    for (const contact of contacts) {
      const identityRequest = contactCanonicalIdentityRequest(contact);
      const identityId = identityRequest.id?.trim();
      if (!identityId) continue;
      const identity = await upsertCanonicalIdentityFast(identityRequest);
      nextCanonicalState = mergeCanonicalIdentity(nextCanonicalState, identity);
      setCanonicalSessionState(nextCanonicalState);
      identityIds.push(identityId);
    }

    const participantIdentityIds = uniqueStrings(identityIds);
    if (participantIdentityIds.length < 2) {
      throw new Error('Select at least 2 people to start a group.');
    }
    const selectedNames = contacts.map((contact) => contact.name);
    const groupDisplayName = request.name?.trim() || groupDefaultName(selectedNames);
    const sessionId = `session:group:${crypto.randomUUID()}`;
    const openResult = await openOrCreateCanonicalSessionFast({
      id: sessionId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId: creatorIdentityId,
      primaryIdentityId: null,
      relationshipIdentityId: null,
      participantIdentityIds,
      metadata: buildChatCreateGroupMetadata({
        creatorIdentityId,
        selectedContactIds: contacts.map((contact) => contact.id),
        selectedNames,
        customName: groupDisplayName,
        groupSpaceId: sessionId,
      }),
    });
    nextCanonicalState = mergeOpenCanonicalSessionResult(nextCanonicalState, openResult);
    setCanonicalSessionState(nextCanonicalState);

    const inviteTargets = buildChatCreateGroupBridgeInviteTargets(contacts);
    const cloudInviteTargetAccountIds = cloudGroupTargetAccountIds(inviteTargets);
    if (cloudInviteTargetAccountIds.length > 0 && cloudSession.account) {
      try {
        await sendCloudGroupControl({
          targetAccountIds: cloudInviteTargetAccountIds,
          kind: 'group-invite',
          groupId: sessionId,
          groupSpaceId: sessionId,
          groupTitle: groupDisplayName,
          participants: cloudGroupParticipantsForContacts(cloudSession.account, contacts),
        });
      } catch (error) {
        setDesktopChatError(`Group created, but Cloud invites failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    selectNewChatSession(sessionId);
  }, [
    canonicalSessionState,
    cloudSession.account,
    isNativeShell,
    peopleContactById,
    selectNewChatSession,
    sendCloudGroupControl,
    setDesktopChatError,
  ]);

  const handleCreateChatSessionInParticipantSpace = useCallback(async (space: ParticipantSpaceViewModel) => {
    if (space.kind === 'self') {
      await handleCreateChatSession();
      return;
    }

    const existingBlankSessionId = existingBlankSessionIdForParticipantSpace(space);
    if (existingBlankSessionId) {
      selectNewChatSession(existingBlankSessionId);
      return;
    }

    if (!isNativeShell) return;
    setDesktopChatError(null);

    const currentCanonicalState = canonicalSessionState;
    const creatorIdentityId = currentCanonicalState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId || !currentCanonicalState) {
      throw new Error('Local profile identity is not ready yet.');
    }

    const sourceSession = space.sessions[0] ?? null;
    const sourceSessionId = sourceSession?.canonicalSessionId ?? sourceSession?.id ?? null;
    const sourceMetadata = sourceSessionId ? sessionMetadataRecord(currentCanonicalState, sourceSessionId) : {};
    const sessionId = chatSessionIdForParticipantSpaceContinuation(space, crypto.randomUUID());
    const createKey = participantSpaceCreateKey(space);
    const pendingSessionId = pendingParticipantSpaceCreateRef.current.get(createKey);
    if (pendingSessionId) {
      selectNewChatSession(pendingSessionId);
      return;
    }
    pendingParticipantSpaceCreateRef.current.set(createKey, sessionId);

    try {
      if (space.kind === 'group') {
        const members = participantSpaceNonSelfIdentities(space, 'human');
        const participantIdentityIds = uniqueStrings(members.map((member) => member.id));
        if (participantIdentityIds.length < 2) {
          throw new Error('A group session needs at least 2 other people.');
        }

        const customName = metadataString(sourceMetadata, 'customName') || space.title;
        const groupSourceMetadata = { ...sourceMetadata };
        delete groupSourceMetadata.titleSource;
        delete groupSourceMetadata.sessionTitleSource;
        delete groupSourceMetadata.cloudUnreadCount;
        const participantNames = members.map((member) => member.name);
        const groupSpaceId = metadataGroupSpaceId(sourceMetadata) || normalizeStoredGroupSpaceId(space.id) || sourceSessionId;
        const openResult = await openOrCreateCanonicalSessionFast({
          id: sessionId,
          kind: 'group',
          title: 'New session',
          status: 'active',
          createdByIdentityId: creatorIdentityId,
          primaryIdentityId: null,
          relationshipIdentityId: null,
          participantIdentityIds,
          metadata: {
            ...groupSourceMetadata,
            schemaVersion: 1,
            kind: 'chat-group',
            customName,
            groupId: groupSpaceId,
            groupSpaceId,
            adminIdentityIds: [creatorIdentityId],
            initialContactIds: metadataStringArray(sourceMetadata, 'initialContactIds'),
            initialParticipantNames: uniqueStrings([
              ...metadataStringArray(sourceMetadata, 'initialParticipantNames'),
              ...participantNames,
            ]),
            memberApprovalPolicy: 'under-50-open',
            createdFrom: 'chat-create-flow',
            continuedFromSessionId: sourceSessionId,
            continuedFromSpaceId: space.id,
          },
        });
        const nextState = mergeOpenCanonicalSessionResult(currentCanonicalState, openResult);
        setCanonicalSessionState(nextState);
        selectNewChatSession(sessionId);

        try {
          const participants = canonicalGroupParticipantsForSession(nextState, sessionId);
          const targets = buildChatGroupBridgeUpdateTargets({ actorIdentityId: creatorIdentityId, participants });
          if (targets.length > 0) {
            const syncContext = canonicalGroupSessionSyncContextForSession(nextState, sessionId, groupSpaceId ?? sessionId);
            const cloudTargetAccountIds = cloudGroupTargetAccountIds(targets);
            if (cloudTargetAccountIds.length > 0 && cloudSession.account) {
              await sendCloudGroupControl({
                targetAccountIds: cloudTargetAccountIds,
                kind: 'group-update',
                groupId: sessionId,
                groupSpaceId: syncContext.parentGroupSpaceId || sessionId,
                groupTitle: syncContext.parentSessionTitle,
                participants: cloudGroupParticipantsForBridgeSessionParticipants(cloudSession.account, syncContext.parentSessionParticipants),
              });
            }
          }
        } catch (error) {
          setDesktopChatError(`Session created, but Bridge session sync failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      const receiver = participantSpaceNonSelfIdentities(space)[0];
      if (!receiver) {
        pendingParticipantSpaceCreateRef.current.delete(createKey);
        await handleCreateChatSession();
        return;
      }

      const kind = receiver.kind === 'agent' ? 'direct-agent' : 'direct-person';
      const openResult = await openOrCreateCanonicalSessionFast({
        id: sessionId,
        kind,
        title: 'New session',
        status: 'active',
        createdByIdentityId: creatorIdentityId,
        primaryIdentityId: receiver.id,
        relationshipIdentityId: receiver.id,
        participantIdentityIds: [receiver.id],
        metadata: buildParticipantSpaceContinuationMetadata({
          sourceMetadata,
          continuedFromSessionId: sourceSessionId,
          continuedFromSpaceId: space.id,
          participantSpaceKind: space.kind,
        }),
      });
      const nextState = mergeOpenCanonicalSessionResult(currentCanonicalState, openResult);
      setCanonicalSessionState(nextState);
      selectNewChatSession(sessionId);
    } catch (error) {
      pendingParticipantSpaceCreateRef.current.delete(createKey);
      throw error;
    }
  }, [
    canonicalSessionState,
    cloudSession.account,
    handleCreateChatSession,
    isNativeShell,
    selectNewChatSession,
    sendCloudGroupControl,
    setDesktopChatError,
  ]);

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
      nextState = await appendRenameNotice(nextState, sessionId, title, 'group', actorIdentityId);
    }
    setCanonicalSessionState(nextState);

    try {
      for (const [groupId, sourceSessionId] of renamedGroupIds) {
        const participants = canonicalGroupParticipantsForSession(nextState, sourceSessionId);
        const targets = buildChatGroupBridgeUpdateTargets({ actorIdentityId, participants });
        if (targets.length === 0) continue;
        const updateParticipants = buildChatGroupBridgeUpdateParticipants({
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
            participants: cloudGroupParticipantsForBridgeSessionParticipants(cloudSession.account, updateParticipants),
          });
        }
      }
    } catch (error) {
      setDesktopChatError(`Group renamed, but Bridge rename sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [appendRenameNotice, canonicalSessionState, cloudSession.account, isNativeShell, sendCloudGroupControl, setDesktopChatError]);

  const handleAddChatGroupMembers = useCallback(async (sessionIds: string[], contactIds: string[]) => {
    if (!isNativeShell) return;
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
    setDesktopChatError(null);
    const currentCanonicalState = canonicalSessionState;
    const creatorIdentityId = currentCanonicalState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId || !currentCanonicalState) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const contacts = uniqueStrings(contactIds)
      .map((contactId) => peopleContactById.get(contactId))
      .filter((contact): contact is Contact => Boolean(contact));
    const blockedBridgeContacts = contacts.filter((contact) => contact.bridgePeerNodeId && !isApprovedBridgeContact(contact));
    if (blockedBridgeContacts.length > 0) {
      throw new Error('Approve people as contacts before adding them to a group.');
    }
    const identityIds: string[] = [];
    let nextState = currentCanonicalState;
    for (const contact of contacts) {
      const identityRequest = contactCanonicalIdentityRequest(contact);
      const identityId = identityRequest.id?.trim();
      if (!identityId) continue;
      const identity = await upsertCanonicalIdentityFast(identityRequest);
      nextState = mergeCanonicalIdentity(nextState, identity);
      identityIds.push(identityId);
    }
    const participantIdentityIds = uniqueStrings(identityIds);
    if (participantIdentityIds.length === 0) return;

    for (const sessionId of groupSessionIds) {
      nextState = await addCanonicalSessionParticipants({
        sessionId,
        identityIds: participantIdentityIds,
        addedByIdentityId: creatorIdentityId,
      });
    }

    const fallbackGroupSpaceId = groupSessionIds[0];
    const addedContactIds = contacts.map((contact) => contact.id);
    const addedNames = contacts.map((contact) => contact.name);
    for (const sessionId of groupSessionIds) {
      const currentMetadata = sessionMetadataRecord(nextState, sessionId);
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: creatorIdentityId,
        metadata: {
          ...currentMetadata,
          groupId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          groupSpaceId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          initialContactIds: uniqueStrings([...metadataStringArray(currentMetadata, 'initialContactIds'), ...addedContactIds]),
          initialParticipantNames: uniqueStrings([...metadataStringArray(currentMetadata, 'initialParticipantNames'), ...addedNames]),
        },
      });
    }
    setCanonicalSessionState(nextState);

    const inviteTargets = buildChatCreateGroupBridgeInviteTargets(contacts);
    const cloudInviteTargetAccountIds = cloudGroupTargetAccountIds(inviteTargets);
    if (cloudInviteTargetAccountIds.length > 0 && cloudSession.account) {
      try {
        for (const sessionId of groupSessionIds) {
          const inviteContext = canonicalGroupInviteContextForSession(
            nextState,
            sessionId,
            fallbackGroupSpaceId,
          );
          await sendCloudGroupControl({
            targetAccountIds: cloudInviteTargetAccountIds,
            kind: 'group-invite',
            groupId: sessionId,
            groupSpaceId: inviteContext.parentGroupSpaceId || sessionId,
            groupTitle: inviteContext.parentSessionTitle,
            participants: cloudGroupParticipantsForBridgeSessionParticipants(cloudSession.account, inviteContext.parentSessionParticipants),
          });
        }
      } catch (error) {
        setDesktopChatError(`Group members added, but Cloud invites failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [
    canonicalSessionState,
    cloudSession.account,
    isNativeShell,
    peopleContactById,
    sendCloudGroupControl,
    setDesktopChatError,
  ]);

  const handleRemoveChatGroupMember = useCallback(async (sessionIds: string[], identityId: string) => {
    if (!isNativeShell) return;
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
    setDesktopChatError(null);
    const actorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!actorIdentityId) throw new Error('Local profile identity is not ready yet.');
    const fallbackGroupSpaceId = groupSessionIds[0];
    let nextState = canonicalSessionState;
    for (const sessionId of groupSessionIds) {
      nextState = await removeCanonicalSessionParticipant({ sessionId, identityId, removedByIdentityId: actorIdentityId });
      const currentMetadata = sessionMetadataRecord(nextState, sessionId);
      const adminIds = adminIdentityIdsFromMetadata(currentMetadata).filter((adminId) => adminId !== identityId);
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: actorIdentityId,
        metadata: {
          ...currentMetadata,
          groupId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          groupSpaceId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          adminIdentityIds: adminIds.length > 0 ? adminIds : activeGroupAdminIds(nextState, sessionId),
        },
      });
    }
    setCanonicalSessionState(nextState);
  }, [canonicalSessionState, isNativeShell, setDesktopChatError]);

  const handleSetChatGroupAdmin = useCallback(async (sessionIds: string[], identityId: string, isAdmin: boolean) => {
    if (!isNativeShell) return;
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
    setDesktopChatError(null);
    const actorIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim();
    if (!actorIdentityId) throw new Error('Local profile identity is not ready yet.');
    const fallbackGroupSpaceId = groupSessionIds[0];
    let nextState = canonicalSessionState;
    for (const sessionId of groupSessionIds) {
      nextState = await setCanonicalSessionParticipantRole({
        sessionId,
        identityId,
        role: isAdmin ? 'admin' : 'person',
        requestedByIdentityId: actorIdentityId,
      });
      const currentMetadata = sessionMetadataRecord(nextState, sessionId);
      const adminIds = uniqueStrings([
        ...adminIdentityIdsFromMetadata(currentMetadata),
        ...activeGroupAdminIds(nextState, sessionId),
      ]);
      const nextAdminIds = isAdmin
        ? uniqueStrings([...adminIds, identityId])
        : adminIds.filter((adminId) => adminId !== identityId);
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: actorIdentityId,
        metadata: {
          ...currentMetadata,
          groupId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          groupSpaceId: metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
          adminIdentityIds: nextAdminIds.length > 0 ? nextAdminIds : activeGroupAdminIds(nextState, sessionId),
        },
      });
    }
    setCanonicalSessionState(nextState);
  }, [canonicalSessionState, isNativeShell, setDesktopChatError]);

  const {
    rootThemeClass,
    lastBridgePollAtLabel,
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
  } = useKordiShellViewModel({
    themeMode: settingsUi.resolvedThemeMode,
    lastBridgePollAt,
    chatTranscriptScrollRef,
    shouldAutoFollowChatRef,
    desktopChatState,
    activeConv,
    activeConversationIsBridge,
    chatModelOptions,
    selectComposerValue,
    selectComposerAuthChoice,
    selectComposerProviderChoice,
    handleStopDesktopChatTurn,
    handleSendProjectMessage,
    handleSendChatMessage: handleSendChatMessageWithQuoteClear,
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
    activeBridgeHost,
    localProfileAvatarSeed,
    refreshDesktopBridge,
    handleCopyBridgeText,
    handleCreateBridgeDraft,
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
    handleAddBridgeContact,
    handleActivateBridgeAgent,
    handleCreateBridgeAgent,
    handleOpenBridgeConversation,
    handleRemoveBridgeContact,
    handleStartBridgePersonSession,
    handleSetBridgeDiscoveryMode,
    handleSetBridgeHostPrivacyPolicy,
    handleSetBridgeAgentReachabilityPolicy,
    handleApproveBridgeContactRequest,
    handleRejectBridgeContactRequest,
    handleSetDefaultBridgeAgent,
    handleUpdateBridgeAgentModelRouting: handleUpdateBridgeAgentModelRoutingForActiveSession,
    handleUpdateLocalAgentModelRouting,
    activeAgentId: agentsUi.activeAgentId,
    setActiveAgentId: agentsUi.setActiveAgentId,
    activeAgent,
    isAgentOverlayOpen: agentsUi.isAgentOverlayOpen,
    setIsAgentOverlayOpen: agentsUi.setIsAgentOverlayOpen,
    desktopBridgeState,
    activeBridgePeople,
    activeBridgeAgents,
    bridgeSettingsDraft,
    setBridgeSettingsDraft,
    isDesktopBridgeSaving,
    desktopBridgeError,
    bridgeWizardOpen,
    setBridgeWizardOpen,
    bridgeWizardStep,
    setBridgeWizardStep,
    bridgeWizardDraft,
    setBridgeWizardDraft,
    handleSelectBridgeHost,
    openBridgeWizard,
    handleStartLocalBridgeHost,
    handleStopLocalBridgeHost,
    handleSaveBridgeSettings,
    handleRemoveBridgeHost,
    handleBridgeWizardPrimary,
    handleOpenBridgeConfigFolder,
    handleRevealBridgeStorageFile,
    handleExportBridgeHostsConfig,
    handleImportBridgeHostsConfig,
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
    activeProjectBridgeHost,
    activeProjectBridgeProject,
    chatTranscriptScrollRef,
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
    handleStopBridgeAgentRequest,
    handleSendProjectMessage: wrappedSendProjectMessage,
    handleSendChatMessage: wrappedSendChatMessage,
    handleForkChatMessage,
    showChatDetailRail,
    activeDetailTab,
    setActiveDetailTab,
    activeProjectLastMessage,
    isProjectBridgeBusy,
    bridgeInvite,
    handleCreateProjectBridgeInvite,
    activeConv,
    activeConvHasSubtitle,
    activeLastMessage,
    activeConversationIsBridge,
    activeBridgeConversationHost,
    activeBridgeConversation,
    activeBridgeAwaitingReply,
    isBridgePolling,
    lastBridgePollAtLabel,
    activeSessionProject,
    activeQueuedDesktopMessages,
    queuedDesktopMessagesBySession,
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

  const messageForwardDialog = forwardDialog ? createElement(MessageForwardDialog, {
    sources: forwardDialog.sources,
    destinations: forwardDialog.destinations,
    onClose: () => setForwardDialog(null),
    onForward: handleConfirmForwardMessage,
  }) : null;

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
