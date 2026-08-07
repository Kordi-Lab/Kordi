import {
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  Dispatch,
  SetStateAction,
} from 'react';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type {
  CanonicalSessionState,
  DesktopAuthState,
  DesktopCollaborationState,
  MessageActionMetadata,
} from '@/kordi-app/types';
import {
  CloudAuthClient,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudMessage,
  type CloudSessionTitle,
} from './authClient';
import {
  CLOUD_AGENT_RUNTIME_SESSION_PREFIX,
} from './cloudAgentMessages';
import {
  type CloudGroupReadCursor,
} from './cloudGroupMessages';
import {
  buildCloudMessageIndex,
  type CloudMessageIndex,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';
import { defaultCloudAgentsClient } from './cloudAgentsClient';
import { defaultCloudMessageCache } from './cloudMessageCache';
import {
  CloudGroupOutbox,
  defaultCloudGroupOutboxPersistence,
} from './cloudGroupOutbox';
import { CloudGroupReplayCoordinator } from './cloudGroupReplayCoordinator';
import { CloudProfileIdentityAdoptionCoordinator, CloudSyncCoordinator } from './cloudSyncCoordinator';
import {
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import {
  useCloudAgentCancellation,
  useCloudAgentRequestCancellation,
} from './useCloudAgentCancellation';
import { useCloudDirectAgentExecution } from './useCloudDirectAgentExecution';
import { useCloudSelfAgentForwardSync } from './useCloudSelfAgentForwardSync';
import { useCloudSelfAgentMetadataSync } from './useCloudSelfAgentMetadataSync';
import { useCloudSelfAgentCanonicalSync } from './useCloudSelfAgentCanonicalSync';
import {
  useCloudGroupOutboxDelivery,
} from './useCloudGroupOutboxDelivery';
import {
  useCloudRealtimeMessages,
} from './useCloudRealtimeMessages';
import {
  useCloudCanonicalReconciliation,
} from './useCloudCanonicalReconciliation';
import { useRecoveredCloudGroupReplay } from './useRecoveredCloudGroupReplay';
import { useCloudAgentProviderAuthSync } from './useCloudAgentProviderAuthSync';
import {
  useCloudMessageReadReceipts,
} from './useCloudMessageReadReceipts';
import {
  useCloudFocusRefresh,
} from './useCloudFocusRefresh';
import {
  useCloudSessionActions,
} from './useCloudSessionActions';
import {
  useCloudGroupControlSender,
} from './useCloudGroupControlSender';
import {
  useCloudGroupControlApplication,
} from './useCloudGroupControlApplication';
import {
  useCloudCollaborationReadModel,
} from './useCloudCollaborationReadModel';
import {
  useCloudCollaborationTopology,
} from './useCloudCollaborationTopology';
import {
  useCloudCollaborationStores,
  type CloudCollaborationMessageStore,
} from './useCloudCollaborationStores';
import {
  useCloudCollaborationTransport,
} from './useCloudCollaborationTransport';
import {
  useCloudActiveSessionLifecycle,
} from './useCloudActiveSessionLifecycle';
import type {
  UseCloudCollaborationStateResult,
} from './cloudCollaborationState.types';

export type {
  UseCloudCollaborationStateResult,
} from './cloudCollaborationState.types';

export {
  resolveAuthorizedCloudGroupSessionTitleSnapshot,
  resolveCloudGroupAdminSnapshot,
} from './cloudGroupSessionControl';
export {
  CLOUD_FOCUS_REFRESH_DELAY_MS,
  CLOUD_FOCUS_REFRESH_THROTTLE_MS,
  CLOUD_MESSAGE_DISCOVERY_MAX_PASSES,
  cloudBootstrapPeerIds,
  cloudAccountGenerationKey,
  cloudMessagesAuthoritativeForContext,
  cloudMessagesByPeerEqual,
  cloudSessionForksByIdEqual,
  cloudUnreadReadinessContextKey,
  cloudUnreadReadyForContext,
  cloudUnreadStatusForContext,
  createAccountScopedSingleFlight,
  loadCloudMessagesByPeerUntilStable,
  markCloudMessagesReadLocally,
  mergeCloudMessagesByPeerSnapshot,
  shouldRefreshCloudForVisibility,
  shouldRunCloudFocusRefresh,
  transitionCloudUnreadReadiness,
  type CloudUnreadReadinessSnapshot,
  type CloudUnreadReadinessStatus,
} from './cloudMessageSyncState';
export { CLOUD_MESSAGES_REFRESH_MS } from './useCloudMessageSync';
export { cloudFallbackRunClaimsForMessages } from './cloudAgentFallbackClaims';
export {
  CLOUD_AGENT_MENTION_WINDOW_MS,
  cloudAgentMentionCandidates,
  shouldRunLocalCloudAgentForCloudMessage,
} from './cloudAgentMentionPolicy';
export {
  CLOUD_GROUP_AGENT_UNAVAILABLE_NOTICE,
  cloudAgentResponseExistsForRequest,
  cloudAgentRunStatusAlreadyOwnsRequest,
  cloudGroupAgentResponseExistsForRequest,
} from './cloudAgentRequestState';
export {
  cloudFallbackClaimErrorIsRetryable,
  cloudFallbackClaimFailureDiagnostic,
} from './cloudFallbackClaimDiagnostics';
export {
  CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS,
  CLOUD_GROUP_AGENT_STATUS_RECHECK_MS,
} from './useCloudAgentAvailability';
export {
  CLOUD_AGENT_TURN_POLL_MS,
  CLOUD_AGENT_TURN_TIMEOUT_MS,
  cloudAgentFailedTurnSnapshot,
} from './cloudAgentLocalExecution';
export {
  cloudGroupAgentCancelledNoticeRequest,
  cloudGroupAgentCancelRoleForRequest,
  cloudGroupAgentProcessingMessageForRequest,
  optimisticCloudAgentCancelMessage,
  type CloudGroupAgentCancelRole,
} from './cloudAgentCancellation';
export {
  planCloudSelfAgentSync,
  seedCloudSelfAgentForwardSyncLedger,
} from './cloudSelfAgentForwardSync';
export { planCloudSelfAgentCanonicalSync } from './cloudSelfAgentCanonicalSync';
export {
  cloudGroupOutboxAttachmentSources,
  prepareCloudGroupOutboxEntryAttachments,
} from './cloudGroupOutboxAttachments';
export type {
  SendCloudGroupControlInput,
} from './useCloudGroupControlSender';
export type {
  SendCloudCollaborationMessageOptions,
} from './useCloudDirectMessaging';
export {
  cloudGroupAgentProcessingSlotForResponse,
  cloudGroupIncomingMessageAlreadyApplied,
  cloudGroupMessageTargetsLocalAgent,
  cloudGroupNativeContextMessages,
} from './useCloudGroupControlApplication';
export {
  cloudCollaborationPreviousStateForContext,
  suppressCloudCollaborationUnreadCounts,
} from './useCloudCollaborationReadModel';

const EMPTY_CLOUD_MESSAGES_BY_PEER: Record<string, CloudMessage[]> = {};

function useCloudCollaborationMessageStore(
  account: CloudAccount | null,
): CloudCollaborationMessageStore {
  const [messagesByPeer, setMessagesByPeer] = useState<Record<string, CloudMessage[]>>({});
  const cacheAccountRef = useRef<string | null>(null);
  const hydratedCacheAccountRef = useRef<string | null>(null);
  const peerReadAtByPeerRef = useRef<Record<string, string>>({});
  const belongsToCurrentAccount = Boolean(account?.accountId
    && cacheAccountRef.current === account.accountId);
  const currentAccountMessagesByPeer = belongsToCurrentAccount
    ? messagesByPeer
    : EMPTY_CLOUD_MESSAGES_BY_PEER;
  const indexRef = useRef<CloudMessageIndex>(null!);
  const index = useMemo(
    () => buildCloudMessageIndex(
      account?.accountId ?? null,
      currentAccountMessagesByPeer,
      { previousIndex: indexRef.current },
    ),
    [account?.accountId, currentAccountMessagesByPeer],
  );
  const valueRef = useRef<Record<string, CloudMessage[]>>({});

  return {
    value: messagesByPeer,
    setValue: setMessagesByPeer,
    valueRef,
    currentAccountValue: currentAccountMessagesByPeer,
    belongsToCurrentAccount,
    index,
    indexRef,
    cacheAccountRef,
    hydratedCacheAccountRef,
    peerReadAtByPeerRef,
  };
}

function reportCloudAgentAvailabilityWarning(message: string, error: unknown) {
  console.warn(message, error);
}

function reportCloudAgentExecutionWarning(message: string, error: unknown) {
  console.warn(message, error);
}

export function useCloudCollaborationState({
  account,
  activeConversationId,
  canonicalSessionState,
  setCanonicalSessionState,
  cloudAgentRuntimeRoutesBySessionId,
  defaultCloudAgentRuntimeRoute,
  desktopAuthState,
}: {
  account: CloudAccount | null;
  activeConversationId?: string | null;
  canonicalSessionState?: CanonicalSessionState | null;
  setCanonicalSessionState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  cloudAgentRuntimeRoutesBySessionId?: Record<string, DesktopChatMessageRoute>;
  defaultCloudAgentRuntimeRoute?: DesktopChatMessageRoute | null;
  desktopAuthState?: DesktopAuthState | null;
}): UseCloudCollaborationStateResult {
  const client = useMemo<CloudAuthClient>(() => defaultCloudAuthClient(), []);
  const cloudAgentsClient = useMemo(() => defaultCloudAgentsClient(), []);
  const cloudMessageCache = useMemo(() => defaultCloudMessageCache(), []);
  const cloudSyncCoordinator = useMemo(() => new CloudSyncCoordinator(), []);
  const cloudProfileIdentityAdoptionCoordinator = useMemo(() => new CloudProfileIdentityAdoptionCoordinator(), []);
  const cloudGroupReplayCoordinator = useMemo(
    () => new CloudGroupReplayCoordinator<IndexedCloudGroupRow>(),
    [],
  );
  const accountId = account?.accountId ?? null;
  const cloudGroupOutbox = useMemo(() => accountId
    ? new CloudGroupOutbox(
      accountId,
      defaultCloudGroupOutboxPersistence(accountId),
    )
    : null, [accountId]);
  const messageStore = useCloudCollaborationMessageStore(account);
  const stores = useCloudCollaborationStores({
    account,
    canonicalState: canonicalSessionState,
    client,
    messageCache: cloudMessageCache,
    messageStore,
    syncCoordinator: cloudSyncCoordinator,
    profileIdentityAdoptionCoordinator:
      cloudProfileIdentityAdoptionCoordinator,
    groupReplayCoordinator: cloudGroupReplayCoordinator,
  });
  const {
    messages: {
      byPeer: messagesByPeer,
      setByPeer: setMessagesByPeer,
      currentAccountByPeer: currentAccountMessagesByPeer,
      belongsToCurrentAccount: messagesBelongToCurrentAccount,
      index: cloudMessageIndex,
      indexRef: cloudMessageIndexRef,
    },
    unread: {
      readiness: cloudUnreadReadiness,
      publishedContextKey: publishedCloudUnreadContextKey,
      setPublishedContextKey: setPublishedCloudUnreadContextKey,
      readInboundMessageIdsByPeer,
      setReadInboundMessageIdsByPeer,
    },
    canonicalStateRef: canonicalSessionStateRef,
    profileCacheRef: cloudProfileCacheRef,
    localTurns: {
      byRequestId: localAgentTurnsByRequestId,
      setByRequestId: setLocalAgentTurnsByRequestId,
    },
    collaboration: {
      override: cloudCollaborationOverride,
      setOverride: setCloudCollaborationOverride,
      overrideContextKey: cloudCollaborationOverrideContextKey,
      setOverrideContextKey:
        setCloudCollaborationOverrideContextKey,
      stateRef: cloudCollaborationStateRef,
      stateContextKeyRef: cloudCollaborationStateContextKeyRef,
    },
    agentRequests: {
      processedMentionIdsRef: processedCloudAgentMentionIdsRef,
      turnIdsByRequestIdRef: cloudAgentTurnIdsByRequestIdRef,
    },
    activity: {
      value: cloudSessionActivity,
      setValue: setCloudSessionActivity,
      valueRef: cloudSessionActivityRef,
    },
    forks: {
      byId: cloudSessionForksById,
      setById: setCloudSessionForksById,
    },
    pins: {
      byId: cloudSessionPinsById,
      setById: setCloudSessionPinsById,
    },
    titles: {
      byId: cloudSessionTitlesById,
      setById: setCloudSessionTitlesById,
      backfillsRef: cloudGroupSessionTitleBackfillsRef,
    },
    agents: {
      definitionsById: cloudAgentDefinitionsById,
    },
    visibility: {
      hiddenSessionIds: cloudHiddenSessionIds,
      setHiddenSessionIds: setCloudHiddenSessionIds,
      deletedSessionIds: cloudDeletedSessionIds,
      setDeletedSessionIds: setCloudDeletedSessionIds,
    },
    cancelledRef,
  } = stores;

  useCloudActiveSessionLifecycle({
    account,
    activeConversationId,
    canonicalState: canonicalSessionState,
    setCanonicalState: setCanonicalSessionState,
    client,
    setPinsBySessionId: setCloudSessionPinsById,
  });

  const {
    bootstrapPeerIds,
    bootstrapPeerKey,
    cloudContacts,
    cloudLookupContacts,
    accountContextKey: cloudCollaborationAccountContextKey,
    unreadContextKey: cloudUnreadContextKey,
    unreadReadinessStatus: cloudUnreadReadinessStatus,
    authoritativeMessagesReady,
    initialContactsSettled,
    initialMessagesSettled,
    refreshContacts: refreshCloudContacts,
  } = useCloudCollaborationTopology({
    account,
    canonicalState: canonicalSessionState,
    setCanonicalState: setCanonicalSessionState,
    syncCoordinator: cloudSyncCoordinator,
    profileIdentityAdoptionCoordinator:
      cloudProfileIdentityAdoptionCoordinator,
    unreadReadiness: cloudUnreadReadiness,
    publishedUnreadContextKey:
      publishedCloudUnreadContextKey,
    reportWarning: reportCloudAgentExecutionWarning,
  });
  const canonicalStateReady = Boolean(canonicalSessionState);

  const {
    catalog: {
      refreshDefinitions: refreshCloudAgents,
      sharedAgents: sharedCloudAgents,
      refreshShared: refreshSharedCloudAgents,
      createDefinition: createCloudAgentDefinition,
      updateDefinition: updateCloudAgentDefinition,
      archiveDefinition: archiveCloudAgentDefinition,
    },
    refreshCloudMessages,
    syncCloudCollaborationDiff,
    claimFreshCloudGroupFallback,
    mergeMessage,
    prepareForwardAttachments: prepareCloudForwardAttachments,
    sendMessage: sendCloudCollaborationMessage,
  } = useCloudCollaborationTransport({
    account,
    canonicalState: canonicalSessionState,
    setCanonicalState: setCanonicalSessionState,
    client,
    agentsClient: cloudAgentsClient,
    syncCoordinator: cloudSyncCoordinator,
    stores,
    contacts: cloudContacts,
    bootstrapPeerIds,
    bootstrapPeerKey,
    unreadContextKey: cloudUnreadContextKey,
    initialContactsSettled,
    initialMessagesSettled,
    reportAvailabilityWarning:
      reportCloudAgentAvailabilityWarning,
  });

  useCloudSelfAgentForwardSync({
    account,
    canonicalState: canonicalSessionState,
    canonicalStateRef: canonicalSessionStateRef,
    client,
    cancelledRef,
    processedRequestIdsRef: processedCloudAgentMentionIdsRef,
    mergeMessage,
    syncCloudCollaborationDiff,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  const cloudGroupControlApplication = useCloudGroupControlApplication({
    account,
    client,
    canonicalStateRef: canonicalSessionStateRef,
    setCanonicalState: setCanonicalSessionState,
    profileCacheRef: cloudProfileCacheRef,
    messageIndexRef: cloudMessageIndexRef,
    mergeMessage,
    syncDiff: syncCloudCollaborationDiff,
    sessionActivityRef: cloudSessionActivityRef,
    setSessionActivity: setCloudSessionActivity,
    setLocalTurns: setLocalAgentTurnsByRequestId,
    processedRequestIdsRef: processedCloudAgentMentionIdsRef,
    turnIdsByRequestIdRef: cloudAgentTurnIdsByRequestIdRef,
    agentDefinitionsById: cloudAgentDefinitionsById,
    routesBySessionId: cloudAgentRuntimeRoutesBySessionId,
    defaultRoute: defaultCloudAgentRuntimeRoute,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  const persistCloudGroupOutboxDelivery =
    useCloudGroupOutboxDelivery({
      account,
      canonicalStateReady,
      canonicalStateRef: canonicalSessionStateRef,
      setCanonicalState: setCanonicalSessionState,
      client,
      outbox: cloudGroupOutbox,
      mergeMessage,
      syncCloudCollaborationDiff,
      reportWarning: reportCloudAgentExecutionWarning,
    });

  useCloudRealtimeMessages({
    account,
    mergeMessage,
    syncCloudCollaborationDiff,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  useCloudCanonicalReconciliation({
    account,
    activeConversationId,
    canonical: {
      state: canonicalSessionState,
      setState: setCanonicalSessionState,
    },
    messages: {
      index: cloudMessageIndex,
      authoritative: authoritativeMessagesReady,
    },
    unread: {
      contextKey: cloudUnreadContextKey,
      setPublishedContextKey:
        setPublishedCloudUnreadContextKey,
    },
  });

  useRecoveredCloudGroupReplay({
    account,
    client,
    humanIdentityId: canonicalSessionState?.profile.humanIdentityId,
    canonicalStateRef: canonicalSessionStateRef,
    setCanonicalState: setCanonicalSessionState,
    initialMessagesSettled,
    processedRequestIdsRef: processedCloudAgentMentionIdsRef,
    coordinator: cloudGroupReplayCoordinator,
    messageIndex: cloudMessageIndex,
    applyControl: cloudGroupControlApplication.apply,
    flushCanonicalState:
      cloudGroupControlApplication.flushCanonicalState,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  useCloudAgentProviderAuthSync({
    account,
    client,
    authState: desktopAuthState,
    agentDefinitionsById: cloudAgentDefinitionsById,
    updateDefinition: updateCloudAgentDefinition,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  useCloudAgentCancellation({
    account,
    canonicalStateRef: canonicalSessionStateRef,
    setCanonicalState: setCanonicalSessionState,
    messageIndex: cloudMessageIndex,
    initialMessagesSettled,
    processedRequestIdsRef: processedCloudAgentMentionIdsRef,
    turnIdsByRequestIdRef: cloudAgentTurnIdsByRequestIdRef,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  useCloudDirectAgentExecution({
    account,
    client,
    cloudAgentDefinitionsById,
    cloudAgentRuntimeRoutesBySessionId,
    cloudLookupContacts,
    cloudMessageIndex,
    defaultCloudAgentRuntimeRoute,
    initialMessagesSettled,
    processedRequestIdsRef: processedCloudAgentMentionIdsRef,
    turnIdsByRequestIdRef: cloudAgentTurnIdsByRequestIdRef,
    activityRef: cloudSessionActivityRef,
    setLocalTurns: setLocalAgentTurnsByRequestId,
    setActivity: setCloudSessionActivity,
    mergeMessage,
    syncMessages: syncCloudCollaborationDiff,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  useCloudMessageReadReceipts({
    account,
    activeConversationId,
    client,
    canonical: {
      setState: setCanonicalSessionState,
    },
    messages: {
      byPeer: messagesByPeer,
      setByPeer: setMessagesByPeer,
      index: cloudMessageIndex,
      sync: syncCloudCollaborationDiff,
    },
    setReadInboundMessageIdsByPeer,
  });

  useCloudSelfAgentMetadataSync({
    account,
    canonicalState: canonicalSessionState,
    client,
    initialMessagesSettled,
    messagesByPeer,
    setForksBySessionId: setCloudSessionForksById,
    titlesBySessionId: cloudSessionTitlesById,
    setTitlesBySessionId: setCloudSessionTitlesById,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  useCloudSelfAgentCanonicalSync({
    account,
    canonicalState: canonicalSessionState,
    setCanonicalState: setCanonicalSessionState,
    messagesByPeer,
    messageIndex: cloudMessageIndex,
    forksBySessionId: cloudSessionForksById,
    titlesBySessionId: cloudSessionTitlesById,
    initialMessagesSettled,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  useCloudFocusRefresh({
    account,
    syncCloudCollaborationDiff,
  });

  const {
    cloudCollaborationState,
    setCloudCollaborationState,
  } = useCloudCollaborationReadModel({
    account,
    activeConversationId,
    canonicalState: canonicalSessionState,
    routesBySessionId: cloudAgentRuntimeRoutesBySessionId,
    defaultRoute: defaultCloudAgentRuntimeRoute,
    contacts: cloudContacts,
    hiddenSessionIds: cloudHiddenSessionIds,
    deletedSessionIds: cloudDeletedSessionIds,
    accountContextKey: cloudCollaborationAccountContextKey,
    override: cloudCollaborationOverride,
    setOverride: setCloudCollaborationOverride,
    overrideContextKey: cloudCollaborationOverrideContextKey,
    setOverrideContextKey:
      setCloudCollaborationOverrideContextKey,
    stateRef: cloudCollaborationStateRef,
    stateContextKeyRef: cloudCollaborationStateContextKeyRef,
    localAgentTurnsByRequestId,
    initialMessagesSettled,
    messageIndex: cloudMessageIndex,
    messagesByPeer: currentAccountMessagesByPeer,
    readInboundMessageIdsByPeer,
  });

  const sendCloudGroupControl = useCloudGroupControlSender({
    account,
    transport: {
      client,
      messageIndex: cloudMessageIndex,
      outbox: cloudGroupOutbox,
      mergeMessage,
      persistOutboxDelivery: persistCloudGroupOutboxDelivery,
      claimFreshFallback: claimFreshCloudGroupFallback,
      syncDiff: syncCloudCollaborationDiff,
    },
    canonical: {
      state: canonicalSessionState,
      stateRef: canonicalSessionStateRef,
      titleBackfillsRef: cloudGroupSessionTitleBackfillsRef,
      initialMessagesSettled,
    },
    reportWarning: reportCloudAgentExecutionWarning,
  });

  const {
    refreshActivity: refreshCloudSessionActivity,
    publishTask: publishCloudTaskActivity,
    publishArtifact: publishCloudArtifactActivity,
    recordFork: recordCloudSessionFork,
    updatePin: updateCloudSessionPin,
    hide: hideCloudSession,
    unhide: unhideCloudSession,
    remove: deleteCloudSession,
  } = useCloudSessionActions({
    account,
    client,
    stores: {
      activity: {
        valueRef: cloudSessionActivityRef,
        setValue: setCloudSessionActivity,
      },
      forks: {
        setById: setCloudSessionForksById,
      },
      pins: {
        setById: setCloudSessionPinsById,
      },
      visibility: {
        setHiddenIds: setCloudHiddenSessionIds,
        setDeletedIds: setCloudDeletedSessionIds,
      },
      messages: {
        setByPeer: setMessagesByPeer,
      },
    },
    syncCollaborationDiff: syncCloudCollaborationDiff,
  });

  const cancelCloudAgentRequest = useCloudAgentRequestCancellation({
    account,
    client,
    canonicalState: canonicalSessionState,
    setCanonicalState: setCanonicalSessionState,
    messageIndex: cloudMessageIndex,
    mergeMessage,
    syncDiff: syncCloudCollaborationDiff,
    processedRequestIdsRef: processedCloudAgentMentionIdsRef,
    turnIdsByRequestIdRef: cloudAgentTurnIdsByRequestIdRef,
    setCollaborationOverride: setCloudCollaborationOverride,
  });

  return {
    cloudCollaborationState,
    setCloudCollaborationState,
    mergedCollaborationState: cloudCollaborationState,
    prepareCloudForwardAttachments,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
    recordCloudSessionFork,
    updateCloudSessionPin,
    hideCloudSession,
    unhideCloudSession,
    deleteCloudSession,
    cancelCloudAgentRequest,
    refreshCloudMessages,
    refreshCloudAgents,
    createCloudAgentDefinition,
    updateCloudAgentDefinition,
    archiveCloudAgentDefinition,
    refreshSharedCloudAgents,
    cloudAgentDefinitionsById,
    sharedCloudAgents,
    cloudSessionActivity,
    refreshCloudSessionActivity,
    publishCloudTaskActivity,
    publishCloudArtifactActivity,
    refreshCloudContacts,
    cloudContacts,
    initialContactsSettled,
    initialMessagesSettled,
    cloudUnreadReadinessStatus,
    cachedMessagesReady: messagesBelongToCurrentAccount && cloudMessageIndex.allMessages.length > 0,
    cloudHiddenSessionIds,
    cloudDeletedSessionIds,
    cloudSessionPinsById,
  };
}
