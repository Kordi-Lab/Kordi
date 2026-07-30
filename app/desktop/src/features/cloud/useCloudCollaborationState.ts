import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import {
  cancelDesktopChatTurn,
  upsertCanonicalMessageFast,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import type {
  CanonicalSessionState,
  Contact,
  DesktopCollaborationState,
  DesktopChatTurnSnapshot,
  MessageActionMetadata,
  MessageAttachment,
} from '@/kordi-app/types';
import {
  CloudAuthClient,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudMessage,
  type CloudPublicProfile,
  type CloudSessionPin,
  type CloudSessionTitle,
  type UpsertCloudArtifactActivityInput,
  type UpsertCloudTaskActivityInput,
} from './authClient';
import {
  buildCloudDesktopCollaborationState,
  cloudGroupParticipantContacts,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdForCollaborationSend,
  isCloudCollaborationHostId,
} from './cloudCollaborationState';
import {
  CLOUD_AGENT_RUNTIME_SESSION_PREFIX,
  encodeCloudAgentCancel,
} from './cloudAgentMessages';
import {
  cloudAgentRuntimeRouteForSession,
  cloudAgentRuntimeSessionId,
} from './cloudAgentRuntime';
import {
  cloudGroupIdFromAgentConversationId,
  type CloudGroupReadCursor,
} from './cloudGroupMessages';
import {
  buildCloudMessageIndex,
  type CloudMessageIndex,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';
import {
  uploadComposerAttachments,
  resolveForwardAttachmentItems,
} from './cloudAttachments';
import { defaultCloudAgentsClient, type CreateCloudAgentInput, type UpdateCloudAgentInput } from './cloudAgentsClient';
import type { CloudAgentDefinition, SharedCloudAgentSummary } from './cloudAgents';
import { cloudMessageMetadataOnly, defaultCloudMessageCache } from './cloudMessageCache';
import {
  CloudGroupOutbox,
  defaultCloudGroupOutboxPersistence,
} from './cloudGroupOutbox';
import { CloudGroupReplayCoordinator } from './cloudGroupReplayCoordinator';
import { CloudProfileIdentityAdoptionCoordinator, CloudSyncCoordinator } from './cloudSyncCoordinator';
import {
  removeCloudSessionMessages,
  type CloudSessionPinsById,
} from './cloudDiffSync';
import {
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import { loadSession } from './session';
import { useCloudContacts } from './useCloudContacts';
import {
  cloudBootstrapPeerIds,
  cloudAccountGenerationKey,
  cloudMessagesAuthoritativeForContext,
  cloudUnreadReadinessContextKey,
  cloudUnreadStatusForContext,
  mergeCloudMessagesByPeerSnapshot,
  type CloudUnreadReadinessSnapshot,
  type CloudUnreadReadinessStatus,
} from './cloudMessageSyncState';
import { useCloudMessageSync } from './useCloudMessageSync';
import { cloudFallbackRunClaimsForMessages } from './cloudAgentFallbackClaims';
import {
  collapseCloudAgentOfflinePlaceholderForRequest,
  upsertCanonicalRequestIntoLocalState,
} from './cloudAgentRequestState';
import { useCloudAgentAvailability } from './useCloudAgentAvailability';
import {
  cloudGroupAgentCancelledNoticeRequest,
  cloudGroupAgentCancelRoleForRequest,
  cloudGroupAgentProcessingMessageForRequest,
  optimisticCloudAgentCancelMessage,
} from './cloudAgentCancellation';
import { useCloudAgentCancellation } from './useCloudAgentCancellation';
import { useCloudDirectAgentExecution } from './useCloudDirectAgentExecution';
import {
  cloudSelfAgentDerivedSyncedStatusBySessionId,
  type CloudSelfAgentSyncStatus,
} from './cloudSelfAgentForwardSync';
import { useCloudSelfAgentForwardSync } from './useCloudSelfAgentForwardSync';
import { useCloudSelfAgentMetadataSync } from './useCloudSelfAgentMetadataSync';
import { useCloudSelfAgentCanonicalSync } from './useCloudSelfAgentCanonicalSync';
import {
  cloudGroupReadCursorsBySessionId,
} from './cloudSelfAgentCanonicalSync';
import {
  useCloudGroupOutboxDelivery,
} from './useCloudGroupOutboxDelivery';
import {
  useCloudRealtimeMessages,
} from './useCloudRealtimeMessages';
import {
  useCanonicalActiveSessionRead,
} from './useCanonicalActiveSessionRead';
import {
  useCloudActiveSessionPin,
} from './useCloudActiveSessionPin';
import {
  useCloudCanonicalReconciliation,
} from './useCloudCanonicalReconciliation';
import {
  useCloudGroupReplay,
} from './useCloudGroupReplay';
import {
  useCloudProviderAuthSnapshotSync,
} from './useCloudProviderAuthSnapshotSync';
import {
  useCloudMessageReadReceipts,
} from './useCloudMessageReadReceipts';
import {
  useCloudFocusRefresh,
} from './useCloudFocusRefresh';
import {
  useCloudAccountLifecycleState,
  useCloudSessionVisibilityRefresh,
} from './useCloudAccountLifecycleState';
import {
  useCloudCanonicalIdentitySync,
} from './useCloudCanonicalIdentitySync';
import {
  useCloudAgentCatalog,
} from './useCloudAgentCatalog';
import {
  useCloudSessionActions,
} from './useCloudSessionActions';
import {
  useCloudGroupControlSender,
  type SendCloudGroupControlInput,
} from './useCloudGroupControlSender';
import {
  useCloudGroupControlApplication,
} from './useCloudGroupControlApplication';

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
  cloudFallbackClaimErrorIsRetryable,
  cloudGroupAgentResponseExistsForRequest,
} from './cloudAgentRequestState';
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
  cloudSelfAgentDerivedSyncedStatusBySessionId,
  planCloudSelfAgentSync,
  seedCloudSelfAgentForwardSyncLedger,
  type CloudSelfAgentSyncStatus,
} from './cloudSelfAgentForwardSync';
export { planCloudSelfAgentCanonicalSync } from './cloudSelfAgentCanonicalSync';
export {
  cloudGroupOutboxAttachmentSources,
  prepareCloudGroupOutboxEntryAttachments,
} from './cloudGroupOutboxAttachments';
export type {
  SendCloudGroupControlInput,
} from './useCloudGroupControlSender';
export {
  cloudGroupAgentProcessingSlotForResponse,
  cloudGroupIncomingMessageAlreadyApplied,
  cloudGroupMessageTargetsLocalAgent,
  cloudGroupNativeContextMessages,
} from './useCloudGroupControlApplication';

const EMPTY_CLOUD_MESSAGES_BY_PEER: Record<string, CloudMessage[]> = {};

function reportCloudAgentAvailabilityWarning(message: string, error: unknown) {
  console.warn(message, error);
}

function reportCloudAgentExecutionWarning(message: string, error: unknown) {
  console.warn(message, error);
}

export type SendCloudCollaborationMessageOptions = {
  clientMessageId?: string | null;
};

export type UseCloudCollaborationStateResult = {
  cloudCollaborationState: DesktopCollaborationState | null;
  setCloudCollaborationState: Dispatch<SetStateAction<DesktopCollaborationState | null>>;
  mergedCollaborationState: DesktopCollaborationState | null;
  prepareCloudForwardAttachments(attachments: MessageAttachment[]): Promise<AttachmentItem[]>;
  sendCloudCollaborationMessage(
    conversationId: string,
    text: string,
    attachments?: AttachmentItem[],
    options?: SendCloudCollaborationMessageOptions,
  ): Promise<void>;
  sendCloudGroupControl(input: SendCloudGroupControlInput): Promise<void>;
  recordCloudSessionFork(input: { sourceSessionId: string; forkSessionId: string; parentMessageId?: string | null }): Promise<void>;
  updateCloudSessionPin(input: { sessionId: string; messageId: string | null; scope: 'private' | 'shared' }): Promise<CloudSessionPin>;
  hideCloudSession(sessionId: string): Promise<void>;
  unhideCloudSession(sessionId: string): Promise<void>;
  deleteCloudSession(sessionId: string): Promise<void>;
  cancelCloudAgentRequest(conversationId: string, requestId: string): Promise<void>;
  refreshCloudMessages(): Promise<void>;
  refreshCloudAgents(): Promise<void>;
  createCloudAgentDefinition(input: CreateCloudAgentInput): Promise<CloudAgentDefinition>;
  updateCloudAgentDefinition(agentId: string, input: UpdateCloudAgentInput): Promise<CloudAgentDefinition>;
  archiveCloudAgentDefinition(agentId: string): Promise<CloudAgentDefinition>;
  refreshSharedCloudAgents(ownerAccountIds: string[]): Promise<SharedCloudAgentSummary[]>;
  cloudAgentDefinitionsById: Record<string, CloudAgentDefinition>;
  sharedCloudAgents: SharedCloudAgentSummary[];
  cloudSessionActivity: CloudSessionActivityStore;
  refreshCloudSessionActivity(sessionId: string): Promise<void>;
  publishCloudTaskActivity(input: UpsertCloudTaskActivityInput): Promise<void>;
  publishCloudArtifactActivity(input: UpsertCloudArtifactActivityInput): Promise<void>;
  refreshCloudContacts(): Promise<void>;
  cloudContacts: Contact[];
  initialContactsSettled: boolean;
  initialMessagesSettled: boolean;
  cloudUnreadReadinessStatus: CloudUnreadReadinessStatus;
  cachedMessagesReady: boolean;
  cloudHiddenSessionIds: Set<string>;
  cloudDeletedSessionIds: Set<string>;
  cloudSessionPinsById: CloudSessionPinsById;
  cloudSelfAgentSyncStatusBySessionId: Record<string, CloudSelfAgentSyncStatus>;
};

function applyCloudAgentRuntimeRouteToState(
  state: DesktopCollaborationState | null,
  route: DesktopChatMessageRoute | null,
): DesktopCollaborationState | null {
  if (!state) return state;
  return {
    ...state,
    hosts: state.hosts.map((host) => {
      if (!isCloudCollaborationHostId(host.id)) return host;
      return {
        ...host,
        agents: host.agents.map((agent) => (
          agent.id === 'cloud-local-agent'
            ? {
                ...agent,
                defaultModel: route?.model ?? null,
                defaultAuthProvider: route?.authProvider ?? null,
                defaultAuthChoice: route?.authChoice ?? null,
                thinking: route?.thinking ?? null,
              }
            : agent
        )),
      };
    }),
  };
}

export function cloudCollaborationPreviousStateForContext(
  state: DesktopCollaborationState | null,
  stateContextKey: string | null,
  currentContextKey: string | null,
) {
  return currentContextKey && stateContextKey === currentContextKey ? state : null;
}

export function suppressCloudCollaborationUnreadCounts(
  state: DesktopCollaborationState | null,
): DesktopCollaborationState | null {
  if (!state) return state;
  let changed = false;
  const conversations = state.conversations.map((conversation) => {
    if (conversation.unreadCount === 0) return conversation;
    changed = true;
    return { ...conversation, unreadCount: 0 };
  });
  return changed ? { ...state, conversations } : state;
}

export function useCloudCollaborationState({
  account,
  activeConversationId,
  canonicalSessionState,
  setCanonicalSessionState,
  cloudAgentRuntimeRoutesBySessionId,
  defaultCloudAgentRuntimeRoute,
}: {
  account: CloudAccount | null;
  activeConversationId?: string | null;
  canonicalSessionState?: CanonicalSessionState | null;
  setCanonicalSessionState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  cloudAgentRuntimeRoutesBySessionId?: Record<string, DesktopChatMessageRoute>;
  defaultCloudAgentRuntimeRoute?: DesktopChatMessageRoute | null;
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
  const cloudGroupOutbox = useMemo(() => account?.accountId
    ? new CloudGroupOutbox(account.accountId, defaultCloudGroupOutboxPersistence(account.accountId))
    : null, [account?.accountId]);
  const contacts = useCloudContacts(account);
  const [messagesByPeer, setMessagesByPeer] =
    useState<Record<string, CloudMessage[]>>({});
  const messagesCacheAccountRef = useRef<string | null>(null);
  const hydratedMessagesCacheAccountRef = useRef<string | null>(null);
  const messagesBelongToCurrentAccount = Boolean(
    account?.accountId
      && messagesCacheAccountRef.current === account.accountId,
  );
  const currentAccountMessagesByPeer = messagesBelongToCurrentAccount
    ? messagesByPeer
    : EMPTY_CLOUD_MESSAGES_BY_PEER;
  const cloudMessageIndexRef = useRef<CloudMessageIndex>(null!);
  const cloudMessageIndex = useMemo(
    () => buildCloudMessageIndex(
      account?.accountId ?? null,
      currentAccountMessagesByPeer,
      { previousIndex: cloudMessageIndexRef.current },
    ),
    [account?.accountId, currentAccountMessagesByPeer],
  );
  const messagesByPeerRef =
    useRef<Record<string, CloudMessage[]>>({});
  const [cloudUnreadReadiness, setCloudUnreadReadiness] =
    useState<CloudUnreadReadinessSnapshot>(() => ({
      status: account ? 'pending' : 'ready',
      contextKey: null,
    }));
  const [
    publishedCloudUnreadContextKey,
    setPublishedCloudUnreadContextKey,
  ] = useState<string | null>(null);
  const canonicalSessionStateRef =
    useRef<CanonicalSessionState | null>(
      canonicalSessionState ?? null,
    );
  const cloudProfileCacheRef =
    useRef<Map<string, CloudPublicProfile>>(new Map());
  const [
    readInboundMessageIdsByPeer,
    setReadInboundMessageIdsByPeer,
  ] = useState<Record<string, Set<string>>>({});
  const [
    localAgentTurnsByRequestId,
    setLocalAgentTurnsByRequestId,
  ] = useState<Record<string, DesktopChatTurnSnapshot>>({});
  const [
    cloudCollaborationOverride,
    setCloudCollaborationOverride,
  ] = useState<DesktopCollaborationState | null>(null);
  const [
    cloudSelfAgentSyncStatusBySessionId,
    setCloudSelfAgentSyncStatusBySessionId,
  ] = useState<Record<string, CloudSelfAgentSyncStatus>>({});
  const cloudCollaborationStateRef =
    useRef<DesktopCollaborationState | null>(null);
  const cloudCollaborationStateContextKeyRef =
    useRef<string | null>(null);
  const cloudCollaborationOverrideContextKeyRef =
    useRef<string | null>(null);
  const processedCloudAgentMentionIdsRef =
    useRef<Set<string>>(new Set());
  const cloudAgentTurnIdsByRequestIdRef =
    useRef<Map<string, string>>(new Map());

  const {
    activity: {
      value: cloudSessionActivity,
      setValue: setCloudSessionActivity,
      valueRef: cloudSessionActivityRef,
    },
    forks: {
      byId: cloudSessionForksById,
      setById: setCloudSessionForksById,
      byIdRef: cloudSessionForksByIdRef,
    },
    pins: {
      byId: cloudSessionPinsById,
      setById: setCloudSessionPinsById,
      byIdRef: cloudSessionPinsByIdRef,
    },
    titles: {
      byId: cloudSessionTitlesById,
      setById: setCloudSessionTitlesById,
      byIdRef: cloudSessionTitlesByIdRef,
      backfillsRef: cloudGroupSessionTitleBackfillsRef,
    },
    agents: {
      definitionsById: cloudAgentDefinitionsById,
      setDefinitionsById: setCloudAgentDefinitionsById,
      definitionsByIdRef: cloudAgentDefinitionsByIdRef,
      sharedByOwner: sharedCloudAgentsByOwner,
      setSharedByOwner: setSharedCloudAgentsByOwner,
    },
    visibility: {
      hiddenSessionIds: cloudHiddenSessionIds,
      setHiddenSessionIds: setCloudHiddenSessionIds,
      hiddenSessionIdsRef: cloudHiddenSessionIdsRef,
      deletedSessionIds: cloudDeletedSessionIds,
      setDeletedSessionIds: setCloudDeletedSessionIds,
      deletedSessionIdsRef: cloudDeletedSessionIdsRef,
    },
    cancelledRef,
    resetAccountState: resetCloudAccountState,
  } = useCloudAccountLifecycleState({
    account,
    messages: {
      cache: cloudMessageCache,
      value: messagesByPeer,
      setValue: setMessagesByPeer,
      valueRef: messagesByPeerRef,
      index: cloudMessageIndex,
      indexRef: cloudMessageIndexRef,
      cacheAccountRef: messagesCacheAccountRef,
      hydratedCacheAccountRef: hydratedMessagesCacheAccountRef,
    },
    unread: {
      setReadiness: setCloudUnreadReadiness,
      setPublishedContextKey: setPublishedCloudUnreadContextKey,
    },
    collaboration: {
      stateRef: cloudCollaborationStateRef,
      stateContextKeyRef: cloudCollaborationStateContextKeyRef,
      overrideContextKeyRef:
        cloudCollaborationOverrideContextKeyRef,
      setOverride: setCloudCollaborationOverride,
      setReadInboundMessageIdsByPeer,
      setLocalAgentTurnsByRequestId,
    },
    syncCoordinator: cloudSyncCoordinator,
    profileIdentityAdoptionCoordinator:
      cloudProfileIdentityAdoptionCoordinator,
    groupReplayCoordinator: cloudGroupReplayCoordinator,
  });

  useEffect(() => {
    return resetCloudAccountState();
  }, [resetCloudAccountState]);

  useCloudSessionVisibilityRefresh({
    account,
    client,
    setHiddenSessionIds: setCloudHiddenSessionIds,
    setDeletedSessionIds: setCloudDeletedSessionIds,
  });

  useEffect(() => {
    canonicalSessionStateRef.current = canonicalSessionState ?? null;
  }, [canonicalSessionState]);

  useCanonicalActiveSessionRead({
    account,
    activeConversationId,
    canonicalState: canonicalSessionState,
    setCanonicalState: setCanonicalSessionState,
  });

  useCloudActiveSessionPin({
    account,
    activeConversationId,
    client,
    setPinsBySessionId: setCloudSessionPinsById,
  });

  const acceptedContactPeerIds = useMemo(
    () => contacts.contacts
      .map((contact) => contact.sourceParticipantId || contact.id.replace(/^cloud:/, ''))
      .filter((value): value is string => Boolean(value)),
    [contacts.contacts],
  );
  const groupParticipantContacts = useMemo(
    () => account
      ? cloudGroupParticipantContacts({
        account,
        canonicalSessionState,
        existingPeerIds: acceptedContactPeerIds,
      })
      : [],
    [account, acceptedContactPeerIds, canonicalSessionState],
  );
  const cloudCollaborationContacts = contacts.contacts;
  const groupParticipantPeerIds = useMemo(
    () => groupParticipantContacts
      .map((contact) => contact.sourceParticipantId || contact.id.replace(/^cloud:/, ''))
      .filter((value): value is string => Boolean(value)),
    [groupParticipantContacts],
  );
  const cloudLookupContacts = useMemo(
    () => [...contacts.contacts, ...groupParticipantContacts],
    [contacts.contacts, groupParticipantContacts],
  );
  const contactPeerIds = useMemo(
    () => contacts.contacts
      .map((contact) => contact.sourceParticipantId || contact.id.replace(/^cloud:/, ''))
      .filter((value): value is string => Boolean(value)),
    [contacts.contacts],
  );
  const bootstrapPeerIds = useMemo(() => cloudBootstrapPeerIds(
    account,
    contactPeerIds,
    groupParticipantPeerIds,
    contacts.requests,
  ), [account, contactPeerIds, groupParticipantPeerIds, contacts.requests]);
  const bootstrapPeerKey = useMemo(() => bootstrapPeerIds.join('|'), [bootstrapPeerIds]);
  const cloudSyncGeneration = cloudSyncCoordinator.currentGeneration();
  const cloudUnreadContextKey = account
    ? cloudUnreadReadinessContextKey(account.accountId, cloudSyncGeneration, bootstrapPeerKey)
    : null;
  const cloudCollaborationAccountContextKey = account
    ? cloudAccountGenerationKey(account.accountId, cloudSyncGeneration)
    : null;
  const authoritativeMessagesReady = cloudMessagesAuthoritativeForContext({
    accountId: account?.accountId,
    contactsSettled: contacts.initialLoadSettled,
    generation: cloudSyncGeneration,
    peerKey: bootstrapPeerKey,
    readiness: cloudUnreadReadiness,
  });
  const cloudUnreadReadinessStatus = cloudUnreadStatusForContext({
    accountId: account?.accountId,
    contactsSettled: contacts.initialLoadSettled,
    generation: cloudSyncGeneration,
    peerKey: bootstrapPeerKey,
    readiness: cloudUnreadReadiness,
    publishedContextKey: publishedCloudUnreadContextKey,
  });
  const initialMessagesSettled = cloudUnreadReadinessStatus === 'ready';
  const canonicalStateReady = Boolean(canonicalSessionState);
  useCloudCanonicalIdentitySync({
    account,
    contacts: contacts.contacts,
    canonicalState: canonicalSessionState,
    setCanonicalState: setCanonicalSessionState,
    profileIdentityAdoptionCoordinator:
      cloudProfileIdentityAdoptionCoordinator,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  const {
    refreshDefinitions: refreshCloudAgents,
    sharedAgents: sharedCloudAgents,
    refreshShared: refreshSharedCloudAgents,
    createDefinition: createCloudAgentDefinition,
    updateDefinition: updateCloudAgentDefinition,
    archiveDefinition: archiveCloudAgentDefinition,
  } = useCloudAgentCatalog({
    account,
    client: cloudAgentsClient,
    syncCoordinator: cloudSyncCoordinator,
    cancelledRef,
    stores: {
      setDefinitionsById: setCloudAgentDefinitionsById,
      sharedByOwner: sharedCloudAgentsByOwner,
      setSharedByOwner: setSharedCloudAgentsByOwner,
    },
  });

  const { refreshCloudMessages, syncCloudCollaborationDiff } = useCloudMessageSync({
    account,
    bootstrapPeerIds,
    bootstrapPeerKey,
    cloudUnreadContextKey,
    contactsSettled: contacts.initialLoadSettled,
    client,
    coordinator: cloudSyncCoordinator,
    cancelledRef,
    stores: {
      messages: { stateRef: messagesByPeerRef, setState: setMessagesByPeer },
      activity: { stateRef: cloudSessionActivityRef, setState: setCloudSessionActivity },
      forks: { stateRef: cloudSessionForksByIdRef, setState: setCloudSessionForksById },
      pins: { stateRef: cloudSessionPinsByIdRef, setState: setCloudSessionPinsById },
      titles: { stateRef: cloudSessionTitlesByIdRef, setState: setCloudSessionTitlesById },
      agents: { stateRef: cloudAgentDefinitionsByIdRef, setState: setCloudAgentDefinitionsById },
      hiddenSessionIds: { stateRef: cloudHiddenSessionIdsRef, setState: setCloudHiddenSessionIds },
      deletedSessionIds: { stateRef: cloudDeletedSessionIdsRef, setState: setCloudDeletedSessionIds },
    },
    setUnreadReadiness: setCloudUnreadReadiness,
    refreshCloudAgents,
  });
  const claimCloudFallbackRun = useCloudAgentAvailability({
    account,
    canonicalSessionState,
    canonicalSessionStateRef,
    setCanonicalSessionState,
    client,
    contacts: contacts.contacts,
    messageIndex: cloudMessageIndex,
    messageIndexRef: cloudMessageIndexRef,
    initialMessagesSettled,
    reportWarning: reportCloudAgentAvailabilityWarning,
  });

  const mergeMessage = useCallback((message: CloudMessage) => {
    const metadataMessage = cloudMessageMetadataOnly(message);
    const peerId = metadataMessage.fromAccountId === account?.accountId
      ? metadataMessage.toAccountId
      : metadataMessage.fromAccountId;
    if (!peerId) return;
    setMessagesByPeer((current) => {
      const previous = current[peerId] ?? [];
      if (previous.some((candidate) => candidate.messageId === metadataMessage.messageId)) return current;
      const next = [...previous, metadataMessage].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return { ...current, [peerId]: next };
    });
  }, [account?.accountId, setMessagesByPeer]);

  const claimFreshCloudGroupFallback = useCallback(async (
    sentMessages: readonly CloudMessage[],
    requestMessageId: string,
    token: string,
  ) => {
    if (!account || sentMessages.length === 0 || !requestMessageId.trim()) return;
    const incomingByPeer: Record<string, CloudMessage[]> = {};
    for (const sentMessage of sentMessages) {
      const message = cloudMessageMetadataOnly(sentMessage);
      const peerId = message.fromAccountId === account.accountId
        ? message.toAccountId
        : message.fromAccountId;
      if (!peerId) continue;
      incomingByPeer[peerId] = [...(incomingByPeer[peerId] ?? []), message];
    }
    const latestMessagesByPeer = mergeCloudMessagesByPeerSnapshot(
      messagesByPeerRef.current,
      incomingByPeer,
    );
    messagesByPeerRef.current = latestMessagesByPeer;
    const exactClaims = cloudFallbackRunClaimsForMessages({
      account,
      contacts: contacts.contacts,
      messagesByPeer: latestMessagesByPeer,
    }).filter((claim) => claim.requestMessageId === requestMessageId);
    await Promise.all(exactClaims.map((claim) => claimCloudFallbackRun(claim, token)));
  }, [
    account,
    claimCloudFallbackRun,
    contacts.contacts,
    messagesByPeerRef,
  ]);

  useCloudSelfAgentForwardSync({
    account,
    canonicalState: canonicalSessionState,
    canonicalStateRef: canonicalSessionStateRef,
    client,
    cancelledRef,
    processedRequestIdsRef: processedCloudAgentMentionIdsRef,
    setSyncStatusBySessionId:
      setCloudSelfAgentSyncStatusBySessionId,
    mergeMessage,
    syncCloudCollaborationDiff,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  const applyCloudGroupControl = useCloudGroupControlApplication({
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

  useCloudGroupReplay({
    enabled: Boolean(
      account
      && canonicalSessionState?.profile.humanIdentityId
      && setCanonicalSessionState
      && initialMessagesSettled
    ),
    contextKey:
      account
      && canonicalSessionState?.profile.humanIdentityId
        ? `${account.accountId}:${canonicalSessionState.profile.humanIdentityId}`
        : null,
    coordinator: cloudGroupReplayCoordinator,
    messageIndex: cloudMessageIndex,
    applyControl: applyCloudGroupControl,
    reportWarning: reportCloudAgentExecutionWarning,
  });

  useCloudProviderAuthSnapshotSync({
    account,
    client,
    route: defaultCloudAgentRuntimeRoute,
    initialMessagesSettled,
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

  const cloudCollaborationState = useMemo(() => {
    if (!account) return null;
    const activeRuntimeSessionId = cloudAgentRuntimeSessionId(account.accountId, activeConversationId);
    const activeRuntimeRoute = cloudAgentRuntimeRouteForSession(cloudAgentRuntimeRoutesBySessionId, activeRuntimeSessionId, defaultCloudAgentRuntimeRoute);
    const canonicalSelfAgentSessions = (canonicalSessionState?.sessions ?? [])
      .filter((session) => session.kind === 'self-agent');
    const cloudSessionTitlesById = Object.fromEntries(canonicalSelfAgentSessions
      .map((session) => [session.id, session.title]));
    const hiddenCloudSessionIds = new Set([
      ...canonicalSelfAgentSessions.map((session) => session.id.trim()).filter(Boolean),
      ...cloudHiddenSessionIds,
      ...cloudDeletedSessionIds,
    ]);
    const canonicalSelfAgentSessionIds = new Set(canonicalSelfAgentSessions.map((session) => session.id));
    const suppressUnscopedSelfAgentConversation = (canonicalSessionState?.messages ?? []).some((message) => (
      canonicalSelfAgentSessionIds.has(message.sessionId)
      && message.sourceTransport !== 'canonical-fork-snapshot'
      && message.sourceTransport !== 'cloud-group-fork-snapshot'
    ));
    const visibleMessagesByPeer = (() => {
      let next = currentAccountMessagesByPeer;
      for (const sessionId of hiddenCloudSessionIds) {
        next = removeCloudSessionMessages(account.accountId, next, sessionId);
      }
      return next;
    })();
    const previousState = cloudCollaborationPreviousStateForContext(
      cloudCollaborationStateRef.current,
      cloudCollaborationStateContextKeyRef.current,
      cloudCollaborationAccountContextKey,
    );
    const generated = buildCloudDesktopCollaborationState({
      account,
      contacts: cloudCollaborationContacts,
      messagesByPeer: visibleMessagesByPeer,
      messageIndex: cloudMessageIndex,
      previousState,
      readInboundMessageIdsByPeer,
      readCursorsBySessionId: cloudGroupReadCursorsBySessionId(canonicalSessionState),
      activeConversationId,
      localAgentTurnsByRequestId,
      localAgentRuntimeRoute: activeRuntimeRoute,
      cloudSessionTitlesById,
      hiddenCloudSessionIds,
      suppressUnscopedSelfAgentConversation,
    });
    const currentOverride = cloudCollaborationPreviousStateForContext(
      cloudCollaborationOverride,
      cloudCollaborationOverrideContextKeyRef.current,
      cloudCollaborationAccountContextKey,
    );
    const routed = applyCloudAgentRuntimeRouteToState(currentOverride ?? generated, activeRuntimeRoute);
    return initialMessagesSettled ? routed : suppressCloudCollaborationUnreadCounts(routed);
  }, [
    account,
    activeConversationId,
    cloudAgentRuntimeRoutesBySessionId,
    defaultCloudAgentRuntimeRoute,
    canonicalSessionState,
    cloudCollaborationOverride,
    cloudCollaborationContacts,
    cloudDeletedSessionIds,
    cloudHiddenSessionIds,
    cloudCollaborationAccountContextKey,
    cloudCollaborationOverrideContextKeyRef,
    cloudCollaborationStateContextKeyRef,
    cloudCollaborationStateRef,
    localAgentTurnsByRequestId,
    initialMessagesSettled,
    cloudMessageIndex,
    currentAccountMessagesByPeer,
    readInboundMessageIdsByPeer,
  ]);

  useEffect(() => {
    cloudCollaborationStateRef.current = cloudCollaborationState;
    cloudCollaborationStateContextKeyRef.current = cloudCollaborationAccountContextKey;
  }, [
    cloudCollaborationAccountContextKey,
    cloudCollaborationState,
    cloudCollaborationStateContextKeyRef,
    cloudCollaborationStateRef,
  ]);

  const setCloudCollaborationState = useCallback<Dispatch<SetStateAction<DesktopCollaborationState | null>>>((action) => {
    const current = cloudCollaborationPreviousStateForContext(
      cloudCollaborationStateRef.current,
      cloudCollaborationStateContextKeyRef.current,
      cloudCollaborationAccountContextKey,
    );
    const next = typeof action === 'function'
      ? (action as (value: DesktopCollaborationState | null) => DesktopCollaborationState | null)(current)
      : action;
    cloudCollaborationOverrideContextKeyRef.current = cloudCollaborationAccountContextKey;
    setCloudCollaborationOverride(next);
  }, [
    cloudCollaborationAccountContextKey,
    cloudCollaborationOverrideContextKeyRef,
    cloudCollaborationStateContextKeyRef,
    cloudCollaborationStateRef,
    setCloudCollaborationOverride,
  ]);

  const mergedCollaborationState = cloudCollaborationState;
  const visibleCloudSelfAgentSyncStatusBySessionId = useMemo(() => ({
    ...cloudSelfAgentDerivedSyncedStatusBySessionId(account?.accountId, currentAccountMessagesByPeer),
    ...cloudSelfAgentSyncStatusBySessionId,
  }), [account?.accountId, cloudSelfAgentSyncStatusBySessionId, currentAccountMessagesByPeer]);

  const prepareCloudForwardAttachments = useCallback(async (attachments: MessageAttachment[]) => {
    if (attachments.length === 0) return [];
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    return resolveForwardAttachmentItems({
      token: session.token,
      client,
      attachments,
    });
  }, [client]);

  const sendCloudCollaborationMessage = useCallback(async (
    conversationId: string,
    text: string,
    attachments: AttachmentItem[] = [],
    options: SendCloudCollaborationMessageOptions = {},
  ) => {
    const peerId = cloudPeerAccountIdFromConversationId(conversationId);
    const trimmed = text.trim();
    if (!peerId || (!trimmed && attachments.length === 0)) throw new Error('Unable to resolve cloud conversation.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const uploadedAttachments = attachments.length > 0
      ? await uploadComposerAttachments({ token: session.token, client, attachments })
      : [];
    const cloudSessionId = cloudSessionIdForCollaborationSend(account?.accountId, peerId, conversationId);
    const message = await client.sendMessage(session.token, peerId, trimmed, {
      sessionId: cloudSessionId,
      attachments: uploadedAttachments,
      clientMessageId: options.clientMessageId,
    });
    mergeMessage(message);
  }, [account?.accountId, client, mergeMessage]);

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

  const cancelCloudAgentRequest = useCallback(async (conversationId: string, requestId: string) => {
    const trimmedRequestId = requestId.trim();
    if (!trimmedRequestId) throw new Error('Unable to resolve request.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');

    const groupId = cloudGroupIdFromAgentConversationId(conversationId);
    if (groupId) {
      processedCloudAgentMentionIdsRef.current.add(trimmedRequestId);
      const turnId = cloudAgentTurnIdsByRequestIdRef.current.get(trimmedRequestId);
      if (turnId) {
        await cancelDesktopChatTurn(turnId).finally(() => {
          cloudAgentTurnIdsByRequestIdRef.current.delete(trimmedRequestId);
        });
      }
      const processingMessage = canonicalSessionState
        ? cloudGroupAgentProcessingMessageForRequest(canonicalSessionState.messages, groupId, trimmedRequestId)
        : null;
      if (processingMessage && setCanonicalSessionState && account && canonicalSessionState) {
        const cancelNoticeRequest = cloudGroupAgentCancelledNoticeRequest({
          processingMessage,
          requestId: trimmedRequestId,
          conversationId,
          cancelledByAccountId: account.accountId,
          cancelledByRole: cloudGroupAgentCancelRoleForRequest({
            state: canonicalSessionState,
            requestId: trimmedRequestId,
            processingMessage,
            cancelledByAccountId: account.accountId,
          }),
          now: Date.now(),
        });
        await upsertCanonicalMessageFast(cancelNoticeRequest);
        // Collapse the cancel write and the offline-placeholder removal into a
        // single render so the cancel notice replaces the "Processing…" bubble
        // atomically. Without this, the offline-timer effect removes the
        // offline-tier placeholder on the next tick, which visually shifts the
        // cancel notice up and reads as a flicker (appear → disappear → appear).
        setCanonicalSessionState((current) => {
          const cancelledState = upsertCanonicalRequestIntoLocalState(current, cancelNoticeRequest);
          if (!cancelledState) return cancelledState;
          return collapseCloudAgentOfflinePlaceholderForRequest(
            cancelledState,
            processingMessage,
            trimmedRequestId,
          );
        });
      }
      const cancelBody = encodeCloudAgentCancel({ requestId: trimmedRequestId });
      const groupEnvelope = cloudMessageIndex.groupRows.find((row) => (
        row.envelope.kind === 'group-message'
        && row.envelope.groupId === groupId
        && row.canonicalMessageId === trimmedRequestId
      ))?.envelope;
      const targetAccountIds = [...new Set((groupEnvelope?.participants ?? [])
        .map((participant) => participant.accountId.trim())
        .filter((accountId) => accountId && accountId !== account?.accountId))];
      const sent = await Promise.allSettled(
        targetAccountIds.map((targetAccountId) => client.sendMessage(session.token, targetAccountId, cancelBody)),
      );
      sent.forEach((result) => {
        if (result.status === 'fulfilled') mergeMessage(result.value);
      });
      await syncCloudCollaborationDiff();
      setCloudCollaborationOverride(null);
      return;
    }

    const peerId = cloudPeerAccountIdFromConversationId(conversationId);
    if (!peerId || !account) throw new Error('Unable to resolve request.');
    mergeMessage(optimisticCloudAgentCancelMessage({
      account,
      peerAccountId: peerId,
      requestId: trimmedRequestId,
    }));
    const message = await client.sendMessage(session.token, peerId, encodeCloudAgentCancel({ requestId: trimmedRequestId }));
    mergeMessage(message);
    await syncCloudCollaborationDiff();
    setCloudCollaborationOverride(null);
  }, [
    account,
    canonicalSessionState,
    client,
    cloudAgentTurnIdsByRequestIdRef,
    cloudMessageIndex,
    mergeMessage,
    processedCloudAgentMentionIdsRef,
    setCanonicalSessionState,
    setCloudCollaborationOverride,
    syncCloudCollaborationDiff,
  ]);

  return {
    cloudCollaborationState,
    setCloudCollaborationState,
    mergedCollaborationState,
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
    refreshCloudContacts: () => contacts.refresh(),
    cloudContacts: contacts.contacts,
    initialContactsSettled: contacts.initialLoadSettled,
    initialMessagesSettled,
    cloudUnreadReadinessStatus,
    cachedMessagesReady: messagesBelongToCurrentAccount && cloudMessageIndex.allMessages.length > 0,
    cloudHiddenSessionIds,
    cloudDeletedSessionIds,
    cloudSessionPinsById,
    cloudSelfAgentSyncStatusBySessionId: visibleCloudSelfAgentSyncStatusBySessionId,
  };
}
