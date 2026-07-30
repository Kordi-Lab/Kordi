import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import {
  adoptCloudProfileIdentity,
  cancelDesktopChatTurn,
  upsertCanonicalIdentityFast,
  upsertCanonicalMessageFast,
  type DesktopChatContextMessage,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import type {
  AppendCanonicalMessageRequest,
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
  OpenCanonicalSessionFastResult,
  OpenCanonicalSessionRequest,
  UpsertCanonicalIdentityRequest,
  Contact,
  DesktopCollaborationSessionParticipant,
  DesktopCollaborationState,
  DesktopChatTurnSnapshot,
  MessageActionMetadata,
  MessageAttachment,
} from '@/kordi-app/types';
import {
  applyCanonicalProfileIdentityDelta,
} from '@/features/canonical/canonicalStateReducers';
import {
  beginChatPerformanceSpan,
  chatPerformancePayloadBytes,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import {
  CloudAuthClient,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudMessage,
  type CloudPublicProfile,
  type SendCloudMessageAttachmentInput,
  type CloudSessionForkSummary,
  type CloudSessionPin,
  type CloudSessionTitle,
  type UpsertCloudArtifactActivityInput,
  type UpsertCloudTaskActivityInput,
} from './authClient';
import {
  buildCloudDesktopCollaborationState,
  cloudContactsToCanonicalIdentityRequests,
  cloudGroupParticipantContacts,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdForCollaborationSend,
  isCloudCollaborationHostId,
} from './cloudCollaborationState';
import {
  CLOUD_AGENT_RUNTIME_SESSION_PREFIX,
  compactCloudAgentNativeContextMessages,
  cloudMessageMentionsLocalAgent,
  encodeCloudAgentCancel,
} from './cloudAgentMessages';
import {
  cloudAgentRuntimeRouteForSession,
  cloudAgentRuntimeSessionId,
} from './cloudAgentRuntime';
import {
  cloudGroupAttachmentReferences,
  cloudGroupForkPayloadFromSessionMetadata,
  cloudGroupIdFromAgentConversationId,
  cloudGroupManualSessionTitleSnapshot,
  cloudGroupOutgoingParticipantSnapshot,
  cloudGroupParticipantsForCollaborationSession,
  cloudGroupSelfParticipant,
  cloudGroupTitleForOutgoingControl,
  type CloudGroupReadCursor,
  cloudGroupRelatedControlsForSend,
  encodeCloudGroupControl,
  firstCloudGroupSendFailure,
  firstRequiredCloudGroupSendFailure,
  fulfilledCloudGroupSends,
  requiredCloudGroupControlTargetAccountIds,
  type CloudGroupControlEnvelope,
  type CloudGroupMemberJoin,
  type CloudGroupMemberLeave,
  type CloudGroupParticipant,
} from './cloudGroupMessages';
import {
  buildCloudMessageIndex,
  type CloudMessageIndex,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';
import {
  cloudMessageActionAllowsAgentContext,
  cloudMessageActionAllowsAgentTrigger,
} from './cloudAgentTriggerPolicy';
import {
  uploadComposerAttachments,
  resolveForwardAttachmentItems,
  resetCloudAttachmentPreviewLoader,
} from './cloudAttachments';
import { defaultCloudAgentsClient, type CreateCloudAgentInput, type UpdateCloudAgentInput } from './cloudAgentsClient';
import type { CloudAgentDefinition, SharedCloudAgentSummary } from './cloudAgents';
import { cloudMessageMetadataOnly, defaultCloudMessageCache } from './cloudMessageCache';
import {
  CloudGroupOutbox,
  defaultCloudGroupOutboxPersistence,
  type CloudGroupOutboxEntry,
} from './cloudGroupOutbox';
import { CloudGroupReplayCoordinator } from './cloudGroupReplayCoordinator';
import { CloudProfileIdentityAdoptionCoordinator, CloudSyncCoordinator } from './cloudSyncCoordinator';
import {
  loadCloudSessionVisibility,
  removeCloudSessionMessages,
  saveCloudSessionVisibility,
  type CloudSessionPinsById,
  type CloudSessionTitlesById,
} from './cloudDiffSync';
import {
  EMPTY_CLOUD_SESSION_ACTIVITY,
  cloneCloudSessionActivityForFork,
  loadCachedCloudSessionActivity,
  mergeCloudSessionActivity,
  normalizeCloudSessionActivitySnapshot,
  saveCachedCloudSessionActivity,
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import { loadSession } from './session';
import { useCloudContacts } from './useCloudContacts';
import {
  applyCloudGroupSessionControl,
  resolveAuthorizedCloudGroupSessionTitleSnapshot,
  resolveCloudGroupAdminSnapshot,
} from './cloudGroupSessionControl';
import { applyCloudGroupMessageControl } from './cloudGroupMessageControl';
import { applyCloudGroupAgentControl } from './cloudGroupAgentControl';
import {
  cloudBootstrapPeerIds,
  cloudAccountGenerationKey,
  cloudMessagesAuthoritativeForContext,
  cloudMessagesByPeerEqual,
  cloudUnreadReadinessContextKey,
  cloudUnreadStatusForContext,
  mergeCloudMessagesByPeerSnapshot,
  type CloudUnreadReadinessSnapshot,
  type CloudUnreadReadinessStatus,
} from './cloudMessageSyncState';
import { useCloudMessageSync } from './useCloudMessageSync';
import { cloudFallbackRunClaimsForMessages } from './cloudAgentFallbackClaims';
import { isRecentCloudAgentMention } from './cloudAgentMentionPolicy';
import {
  cloudFallbackRunAlreadyOwnsRequest,
  cloudGroupAgentResponseExistsForRequest,
  collapseCloudAgentOfflinePlaceholderForRequest,
  isCloudAgentProcessingPlaceholderText,
  removeCanonicalMessageById,
  removeCloudGroupOfflinePlaceholder,
  removeCloudGroupPendingRowsForTerminalResponse,
  removeCloudGroupTimeoutPlaceholderForTerminalResponse,
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
import {
  publishDerivedCloudSessionActivity,
  waitForCloudAgentTurn,
} from './cloudAgentLocalExecution';
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
  mergeOpenCanonicalSessionFastResultIntoLocalState,
  upsertCanonicalIdentityIntoLocalState,
} from './cloudCanonicalStateMerge';
import {
  cloudGroupOutboxAttachmentSources,
  prepareCloudGroupOutboxEntryAttachments,
} from './cloudGroupOutboxAttachments';
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

const EMPTY_CLOUD_MESSAGES_BY_PEER: Record<string, CloudMessage[]> = {};

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function reportCloudGroupAgentFailure(
  kind: 'local-response' | 'no-provider-notice',
  error: unknown,
) {
  if (kind === 'no-provider-notice') {
    console.warn('[cloud-group-agent-mention] no-provider notice failed', error);
    return;
  }
  console.warn('[cloud-group-agent-mention] local agent response failed', error);
}

function reportCloudAgentAvailabilityWarning(message: string, error: unknown) {
  console.warn(message, error);
}

function reportCloudAgentExecutionWarning(message: string, error: unknown) {
  console.warn(message, error);
}

export function cloudGroupAgentProcessingSlotForResponse(
  messages: CanonicalSessionMessage[],
  groupId: string,
  requestId: string,
  senderAccountId: string,
): CanonicalSessionMessage | null {
  const trimmedGroupId = groupId.trim();
  const trimmedRequestId = requestId.trim();
  const trimmedSenderAccountId = senderAccountId.trim();
  if (!trimmedGroupId || !trimmedRequestId || !trimmedSenderAccountId) return null;
  const senderIdentityId = `agent:cloud:${trimmedSenderAccountId}`;
  return messages.find((message) => {
    if (message.sessionId !== trimmedGroupId || message.senderIdentityId !== senderIdentityId) return false;
    if (!message.sourceTransport?.startsWith('cloud-group-agent')) return false;
    const content = objectContent(message.content);
    const linkedRequestId = cleanText(message.parentMessageId)
      || cleanText(typeof content.requestId === 'string' ? content.requestId : null)
      || cleanText(typeof content.replyToMessageId === 'string' ? content.replyToMessageId : null);
    if (linkedRequestId !== trimmedRequestId) return false;
    const deliveryState = cleanText(typeof content.deliveryState === 'string' ? content.deliveryState : null).toLowerCase();
    return message.status === 'processing' || deliveryState === 'processing';
  }) ?? null;
}

export function cloudGroupIncomingMessageAlreadyApplied(
  existingMessage: CanonicalSessionMessage | null,
  incomingDeliveryState?: string | null,
): boolean {
  if (!existingMessage) return false;
  const incomingState = cleanText(incomingDeliveryState).toLowerCase();
  const incomingIsTerminal = Boolean(incomingState)
    && !['sending', 'processing'].includes(incomingState);
  if (!incomingIsTerminal) return true;

  const content = objectContent(existingMessage.content);
  const existingDeliveryState = cleanText(
    typeof content.deliveryState === 'string' ? content.deliveryState : null,
  ).toLowerCase();
  const existingStatus = existingMessage.status.trim().toLowerCase();
  const existingIsPending = ['sending', 'processing'].includes(existingStatus)
    || ['sending', 'processing'].includes(existingDeliveryState);
  if (existingIsPending) return false;

  // The offline tier is a local timeout hint, not a terminal Cloud response.
  // A later owner response must still replace it.
  if (existingMessage.sourceTransport === 'cloud-group-agent-offline') return false;
  return true;
}

export function cloudGroupMessageTargetsLocalAgent(
  message: NonNullable<CloudGroupControlEnvelope['message']>,
  account: CloudAccount,
): boolean {
  if (message.forkSnapshot === true || !cloudMessageActionAllowsAgentTrigger(message.messageAction)) return false;
  const targetsOwnedHostedCloudAgent = Boolean(
    cleanText(message.targetCloudAgentId).startsWith('cloud_agent_')
    && cleanText(message.targetCloudAgentOwnerAccountId) === account.accountId,
  );
  return targetsOwnedHostedCloudAgent || cloudMessageMentionsLocalAgent(
    message.text,
    account,
    { allowFirstPerson: message.senderAccountId === account.accountId },
  );
}

export function cloudGroupNativeContextMessages({
  groupRows,
  groupId,
  requestMessageId,
  requestCreatedAtMs,
}: {
  groupRows: readonly IndexedCloudGroupRow[];
  groupId: string;
  requestMessageId: string;
  requestCreatedAtMs: number;
}): DesktopChatContextMessage[] {
  return compactCloudAgentNativeContextMessages(groupRows.flatMap(({ envelope }) => {
    if (envelope?.kind !== 'group-message' || envelope.groupId !== groupId || !envelope.message) return [];
    const message = envelope.message;
    if (message.id === requestMessageId) return [];
    if (message.createdAtMs > requestCreatedAtMs) return [];
    if (message.forkSnapshot === true) return [];
    if (!cloudMessageActionAllowsAgentContext(message.messageAction)) return [];
    if (message.deliveryState === 'processing' || isCloudAgentProcessingPlaceholderText(message.text)) return [];
    const text = message.text.trim();
    if (!text) return [];
    const participantName = envelope.participants.find((participant) => participant.accountId === message.senderAccountId)?.displayName?.trim();
    return [{
      id: message.id,
      authorName: message.senderDisplayName?.trim() || participantName || 'Cloud participant',
      authorKind: message.senderKind === 'agent' ? 'agent' : 'human',
      text,
      createdAtMs: message.createdAtMs,
    }];
  }));
}

export type SendCloudGroupControlInput = {
  targetAccountIds: string[];
  kind: CloudGroupControlEnvelope['kind'];
  groupId: string;
  groupSpaceId?: string | null;
  groupTitle?: string | null;
  createdByAccountId?: string | null;
  actor?: CloudGroupParticipant | null;
  participants?: CloudGroupParticipant[];
  memberJoins?: CloudGroupMemberJoin[];
  memberLeaves?: CloudGroupMemberLeave[];
  sessionTitleSyncOnly?: boolean;
  collaborationParticipants?: DesktopCollaborationSessionParticipant[];
  fork?: CloudGroupControlEnvelope['fork'];
  message?: CloudGroupControlEnvelope['message'];
  attachments?: AttachmentItem[];
  retryFailed?: boolean;
};

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
  const [messagesByPeer, setMessagesByPeer] = useState<Record<string, CloudMessage[]>>({});
  const messagesCacheAccountRef = useRef<string | null>(null);
  const hydratedMessagesCacheAccountRef = useRef<string | null>(null);
  const messagesBelongToCurrentAccount = Boolean(
    account?.accountId && messagesCacheAccountRef.current === account.accountId,
  );
  const currentAccountMessagesByPeer = messagesBelongToCurrentAccount
    ? messagesByPeer
    : EMPTY_CLOUD_MESSAGES_BY_PEER;
  const cloudMessageIndexRef = useRef<CloudMessageIndex>(null!);
  const cloudMessageIndex = useMemo(
    () => buildCloudMessageIndex(account?.accountId ?? null, currentAccountMessagesByPeer, {
      previousIndex: cloudMessageIndexRef.current,
    }),
    [account?.accountId, currentAccountMessagesByPeer],
  );
  const [cloudSessionActivity, setCloudSessionActivity] = useState<CloudSessionActivityStore>(() => loadCachedCloudSessionActivity(account?.accountId));
  const [cloudSessionForksById, setCloudSessionForksById] = useState<Record<string, CloudSessionForkSummary>>({});
  const [cloudSessionPinsById, setCloudSessionPinsById] = useState<CloudSessionPinsById>({});
  const [cloudSessionTitlesById, setCloudSessionTitlesById] = useState<CloudSessionTitlesById>({});
  const [cloudAgentDefinitionsById, setCloudAgentDefinitionsById] = useState<Record<string, CloudAgentDefinition>>({});
  const [sharedCloudAgentsByOwner, setSharedCloudAgentsByOwner] = useState<Record<string, SharedCloudAgentSummary[]>>({});
  const [cloudHiddenSessionIds, setCloudHiddenSessionIds] = useState<Set<string>>(() => loadCloudSessionVisibility(account?.accountId).hiddenSessionIds);
  const [cloudDeletedSessionIds, setCloudDeletedSessionIds] = useState<Set<string>>(() => loadCloudSessionVisibility(account?.accountId).deletedSessionIds);
  const messagesByPeerRef = useRef<Record<string, CloudMessage[]>>({});
  const cloudSessionActivityRef = useRef<CloudSessionActivityStore>(cloudSessionActivity);
  const cloudSessionForksByIdRef = useRef<Record<string, CloudSessionForkSummary>>(cloudSessionForksById);
  const cloudSessionPinsByIdRef = useRef<CloudSessionPinsById>(cloudSessionPinsById);
  const cloudSessionTitlesByIdRef = useRef<CloudSessionTitlesById>(cloudSessionTitlesById);
  const cloudGroupSessionTitleBackfillsRef = useRef<Set<string>>(new Set());
  const cloudAgentDefinitionsByIdRef = useRef<Record<string, CloudAgentDefinition>>(cloudAgentDefinitionsById);
  const cloudHiddenSessionIdsRef = useRef<Set<string>>(cloudHiddenSessionIds);
  const cloudDeletedSessionIdsRef = useRef<Set<string>>(cloudDeletedSessionIds);
  const [cloudUnreadReadiness, setCloudUnreadReadiness] = useState<CloudUnreadReadinessSnapshot>(() => ({
    status: account ? 'pending' : 'ready',
    contextKey: null,
  }));
  const [publishedCloudUnreadContextKey, setPublishedCloudUnreadContextKey] = useState<string | null>(null);
  const canonicalSessionStateRef = useRef<CanonicalSessionState | null>(canonicalSessionState ?? null);
  const cloudProfileCacheRef = useRef<Map<string, CloudPublicProfile>>(new Map());
  const [readInboundMessageIdsByPeer, setReadInboundMessageIdsByPeer] = useState<Record<string, Set<string>>>({});
  const [localAgentTurnsByRequestId, setLocalAgentTurnsByRequestId] = useState<Record<string, DesktopChatTurnSnapshot>>({});
  const [cloudCollaborationOverride, setCloudCollaborationOverride] = useState<DesktopCollaborationState | null>(null);
  const [cloudSelfAgentSyncStatusBySessionId, setCloudSelfAgentSyncStatusBySessionId] = useState<Record<string, CloudSelfAgentSyncStatus>>({});
  const cloudCollaborationStateRef = useRef<DesktopCollaborationState | null>(null);
  const cloudCollaborationStateContextKeyRef = useRef<string | null>(null);
  const cloudCollaborationOverrideContextKeyRef = useRef<string | null>(null);
  const processedCloudAgentMentionIdsRef = useRef<Set<string>>(new Set());
  const cloudAgentTurnIdsByRequestIdRef = useRef<Map<string, string>>(new Map());
  const syncedContactIdentitySignatureRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => () => {
    cloudGroupReplayCoordinator.dispose();
  }, [cloudGroupReplayCoordinator]);

  useEffect(() => {
    messagesByPeerRef.current = messagesByPeer;
    if (
      account
      && messagesCacheAccountRef.current === account.accountId
      && hydratedMessagesCacheAccountRef.current === account.accountId
    ) {
      void cloudMessageCache.save(account.accountId, messagesByPeer).catch(() => {});
    }
  }, [account, cloudMessageCache, messagesByPeer]);

  useEffect(() => {
    cloudMessageIndexRef.current = cloudMessageIndex;
  }, [cloudMessageIndex]);

  useEffect(() => {
    cloudSessionActivityRef.current = cloudSessionActivity;
    if (account && messagesCacheAccountRef.current === account.accountId) saveCachedCloudSessionActivity(account.accountId, cloudSessionActivity);
  }, [account, cloudSessionActivity]);

  useEffect(() => {
    cloudSessionForksByIdRef.current = cloudSessionForksById;
  }, [cloudSessionForksById]);

  useEffect(() => {
    cloudSessionPinsByIdRef.current = cloudSessionPinsById;
  }, [cloudSessionPinsById]);

  useEffect(() => {
    cloudSessionTitlesByIdRef.current = cloudSessionTitlesById;
  }, [cloudSessionTitlesById]);

  useEffect(() => {
    cloudAgentDefinitionsByIdRef.current = cloudAgentDefinitionsById;
  }, [cloudAgentDefinitionsById]);

  useEffect(() => {
    cloudHiddenSessionIdsRef.current = cloudHiddenSessionIds;
  }, [cloudHiddenSessionIds]);

  useEffect(() => {
    cloudDeletedSessionIdsRef.current = cloudDeletedSessionIds;
  }, [cloudDeletedSessionIds]);

  useEffect(() => {
    if (!account || messagesCacheAccountRef.current !== account.accountId) return;
    saveCloudSessionVisibility(account.accountId, {
      hiddenSessionIds: cloudHiddenSessionIds,
      deletedSessionIds: cloudDeletedSessionIds,
    });
  }, [account, cloudDeletedSessionIds, cloudHiddenSessionIds]);

  useEffect(() => () => {
    cloudProfileIdentityAdoptionCoordinator.changeAccount();
  }, [account?.accountId, cloudProfileIdentityAdoptionCoordinator]);

  useEffect(() => {
    cloudSyncCoordinator.changeAccount();
    const generation = cloudSyncCoordinator.currentGeneration();
    resetCloudAttachmentPreviewLoader();
    const accountId = account?.accountId ?? null;
    cloudGroupReplayCoordinator.changeAccount(accountId);
    messagesCacheAccountRef.current = accountId;
    hydratedMessagesCacheAccountRef.current = null;
    messagesByPeerRef.current = {};
    setMessagesByPeer({});
    setCloudUnreadReadiness({
      status: accountId ? 'pending' : 'ready',
      contextKey: accountId
        ? cloudUnreadReadinessContextKey(accountId, generation, '')
        : null,
    });
    setPublishedCloudUnreadContextKey(null);
    cloudCollaborationStateRef.current = null;
    cloudCollaborationStateContextKeyRef.current = null;
    cloudCollaborationOverrideContextKeyRef.current = null;
    setCloudCollaborationOverride(null);
    setReadInboundMessageIdsByPeer({});
    setLocalAgentTurnsByRequestId({});
    let cancelled = false;
    if (accountId) {
      void cloudMessageCache.load(accountId).then((cached) => {
        if (cancelled || messagesCacheAccountRef.current !== accountId) return;
        setMessagesByPeer((current) => {
          const merged = mergeCloudMessagesByPeerSnapshot(cached, current);
          return cloudMessagesByPeerEqual(current, merged) ? current : merged;
        });
        hydratedMessagesCacheAccountRef.current = accountId;
      }).catch(() => {});
    }
    const nextSessionActivity = account
      ? loadCachedCloudSessionActivity(account.accountId)
      : EMPTY_CLOUD_SESSION_ACTIVITY;
    cloudSessionActivityRef.current = nextSessionActivity;
    cloudSessionForksByIdRef.current = {};
    cloudSessionPinsByIdRef.current = {};
    cloudSessionTitlesByIdRef.current = {};
    cloudGroupSessionTitleBackfillsRef.current.clear();
    cloudAgentDefinitionsByIdRef.current = {};
    setCloudSessionActivity(nextSessionActivity);
    setCloudSessionForksById({});
    setCloudSessionPinsById({});
    setCloudSessionTitlesById({});
    setCloudAgentDefinitionsById({});
    const visibility = loadCloudSessionVisibility(account?.accountId);
    cloudHiddenSessionIdsRef.current = visibility.hiddenSessionIds;
    cloudDeletedSessionIdsRef.current = visibility.deletedSessionIds;
    setCloudHiddenSessionIds(visibility.hiddenSessionIds);
    setCloudDeletedSessionIds(visibility.deletedSessionIds);
    return () => {
      cancelled = true;
    };
  }, [account?.accountId, cloudGroupReplayCoordinator, cloudMessageCache, cloudSyncCoordinator]);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    void loadSession()
      .then(async (session) => {
        if (!session?.token) return null;
        return client.listSessionVisibility(session.token);
      })
      .then((visibility) => {
        if (cancelled || !visibility) return;
        const nextVisibility = {
          hiddenSessionIds: new Set(visibility.hiddenSessionIds.map(cleanText).filter(Boolean)),
          deletedSessionIds: new Set(visibility.deletedSessionIds.map(cleanText).filter(Boolean)),
        };
        saveCloudSessionVisibility(account.accountId, nextVisibility);
        setCloudHiddenSessionIds(nextVisibility.hiddenSessionIds);
        setCloudDeletedSessionIds(nextVisibility.deletedSessionIds);
      })
      .catch(() => {
        // A visibility refresh failure should not block the existing message
        // bootstrap; the next diff/full refresh can recover.
      });
    return () => {
      cancelled = true;
    };
  }, [account, client]);

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
  const cloudProfileIdentityId = account?.accountId ? `human:${account.accountId}` : '';
  const localHumanIdentityId = cloudProfileIdentityId || canonicalSessionState?.profile.humanIdentityId?.trim() || '';
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
  const cloudProfileAdoptionSignature = useMemo(() => JSON.stringify({
    accountId: account?.accountId ?? null,
    displayName: account?.displayName ?? account?.primaryEmail ?? null,
    avatarUrl: account?.avatarUrl ?? null,
    profileHumanIdentityId: canonicalSessionState?.profile.humanIdentityId ?? null,
  }), [account?.accountId, account?.avatarUrl, account?.displayName, account?.primaryEmail, canonicalSessionState?.profile.humanIdentityId]);

  useEffect(() => {
    if (!account || !canonicalStateReady || !setCanonicalSessionState) return;
    void cloudProfileIdentityAdoptionCoordinator.request(
      {
        accountId: account.accountId,
        displayName: account.displayName || account.primaryEmail || account.accountId,
        avatarKey: account.accountId,
        profileImageUrl: account.avatarUrl ?? null,
      },
      adoptCloudProfileIdentity,
      (delta) => {
        setCanonicalSessionState?.((current) => applyCanonicalProfileIdentityDelta(current, delta));
      },
    )
      .catch((error) => {
        console.warn('[cloud-profile-identity] failed to adopt stable cloud profile identity', error);
      });
  }, [account, canonicalSessionState?.profile.humanIdentityId, canonicalStateReady, cloudProfileAdoptionSignature, cloudProfileIdentityAdoptionCoordinator, setCanonicalSessionState]);

  const contactIdentitySignature = useMemo(() => JSON.stringify({
    accountId: account?.accountId ?? null,
    localHumanIdentityId,
    contacts: contacts.contacts
      .map((contact) => ({
        id: contact.id,
        name: contact.name,
        sourceParticipantId: contact.sourceParticipantId ?? null,
        sourceHumanId: contact.sourceHumanId ?? null,
        profileImageUrl: contact.profileImageUrl ?? null,
        avatarSeed: contact.avatarSeed ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }), [account?.accountId, contacts.contacts, localHumanIdentityId]);


  useEffect(() => {
    if (!account || !localHumanIdentityId || !setCanonicalSessionState) {
      syncedContactIdentitySignatureRef.current = null;
      return;
    }
    if (syncedContactIdentitySignatureRef.current === contactIdentitySignature) return;
    syncedContactIdentitySignatureRef.current = contactIdentitySignature;
    let cancelled = false;
    void (async () => {
      for (const request of cloudContactsToCanonicalIdentityRequests({
        account,
        contacts: contacts.contacts,
        localHumanIdentityId,
      })) {
        if (cancelled) return;
        const identity = await upsertCanonicalIdentityFast(request);
        if (!cancelled) setCanonicalSessionState((current) => upsertCanonicalIdentityIntoLocalState(current, identity));
      }
    })().catch(() => {
      syncedContactIdentitySignatureRef.current = null;
    });
    return () => {
      cancelled = true;
    };
  }, [account, contactIdentitySignature, contacts.contacts, localHumanIdentityId, setCanonicalSessionState]);

  const refreshCloudAgents = useCallback(async (generation?: number) => {
    if (!account) {
      setCloudAgentDefinitionsById({});
      return;
    }
    const session = await loadSession();
    if (!session?.token) return;
    const agents = await cloudAgentsClient.listCloudAgents(session.token);
    if (cancelledRef.current || (generation !== undefined && !cloudSyncCoordinator.isCurrentGeneration(generation))) return;
    const next = Object.fromEntries(agents.map((agent) => [agent.agentId, agent]));
    setCloudAgentDefinitionsById((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [account, cloudAgentsClient, cloudSyncCoordinator]);

  const sharedCloudAgents = useMemo(() => Object.values(sharedCloudAgentsByOwner).flat(), [sharedCloudAgentsByOwner]);

  const refreshSharedCloudAgents = useCallback(async (ownerAccountIds: string[]) => {
    const owners = [...new Set(ownerAccountIds.map((value) => value.trim()).filter(Boolean))];
    if (!account || owners.length === 0) {
      setSharedCloudAgentsByOwner((current) => (Object.keys(current).length === 0 ? current : {}));
      return [];
    }
    const session = await loadSession();
    if (!session?.token) return [];
    const agents = await cloudAgentsClient.listSharedCloudAgents(session.token, owners);
    const next: Record<string, SharedCloudAgentSummary[]> = {};
    for (const agent of agents) {
      next[agent.ownerAccountId] = [...(next[agent.ownerAccountId] ?? []), agent];
    }
    setSharedCloudAgentsByOwner((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    return agents;
  }, [account, cloudAgentsClient]);

  const createCloudAgentDefinition = useCallback(async (input: CreateCloudAgentInput) => {
    const session = await loadSession();
    if (!session?.token) throw new Error('Sign in to Cloud before creating an agent.');
    const agent = await cloudAgentsClient.createCloudAgent(session.token, input);
    setCloudAgentDefinitionsById((current) => ({ ...current, [agent.agentId]: agent }));
    return agent;
  }, [cloudAgentsClient]);

  const updateCloudAgentDefinition = useCallback(async (agentId: string, input: UpdateCloudAgentInput) => {
    const session = await loadSession();
    if (!session?.token) throw new Error('Sign in to Cloud before updating an agent.');
    const agent = await cloudAgentsClient.updateCloudAgent(session.token, agentId, input);
    setCloudAgentDefinitionsById((current) => ({ ...current, [agent.agentId]: agent }));
    return agent;
  }, [cloudAgentsClient]);

  const archiveCloudAgentDefinition = useCallback(async (agentId: string) => {
    const session = await loadSession();
    if (!session?.token) throw new Error('Sign in to Cloud before deleting an agent.');
    const agent = await cloudAgentsClient.archiveCloudAgent(session.token, agentId);
    setCloudAgentDefinitionsById((current) => {
      const { [agent.agentId]: _removed, ...rest } = current;
      return rest;
    });
    return agent;
  }, [cloudAgentsClient]);

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
  }, [account?.accountId]);

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
  }, [account, claimCloudFallbackRun, contacts.contacts]);

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

  const applyCloudGroupControl = useCallback(async (
    cloudMessage: CloudMessage,
    envelope: CloudGroupControlEnvelope,
  ) => {
    // Keep canonical state behind a ref so replay does not rebuild this callback
    // after each canonical write and re-enter the replay effect.
    const sessionContext = await applyCloudGroupSessionControl({
      cloudMessage,
      envelope,
      runtime: {
        account,
        client,
        profileCache: cloudProfileCacheRef.current,
      },
      canonical: {
        getState: () => canonicalSessionStateRef.current,
        setState: setCanonicalSessionState,
      },
      stateOps: {
        objectContent,
        cleanText,
        resolveAdminSnapshot: resolveCloudGroupAdminSnapshot,
        resolveSessionTitle: resolveAuthorizedCloudGroupSessionTitleSnapshot,
        upsertIdentity: upsertCanonicalIdentityIntoLocalState,
        mergeOpenSession: mergeOpenCanonicalSessionFastResultIntoLocalState,
      },
    });
    if (!sessionContext || !setCanonicalSessionState) return;

    const messageContext = await applyCloudGroupMessageControl({
      context: sessionContext,
      setCanonicalState: setCanonicalSessionState,
      stateOps: {
        objectContent,
        cleanText,
        upsertIdentity: upsertCanonicalIdentityIntoLocalState,
        processingSlot: cloudGroupAgentProcessingSlotForResponse,
        incomingAlreadyApplied: cloudGroupIncomingMessageAlreadyApplied,
        removeOfflinePlaceholder: removeCloudGroupOfflinePlaceholder,
        removeTimeoutPlaceholder: removeCloudGroupTimeoutPlaceholderForTerminalResponse,
        removePendingRows: removeCloudGroupPendingRowsForTerminalResponse,
        removeMessage: removeCanonicalMessageById,
        isProcessingPlaceholder: isCloudAgentProcessingPlaceholderText,
      },
    });
    if (!messageContext) return;

    applyCloudGroupAgentControl({
      context: messageContext,
      setCanonicalState: setCanonicalSessionState,
      runtime: {
        client,
        messageIndex: () => cloudMessageIndexRef.current,
        sessionActivity: () => cloudSessionActivityRef.current,
        setSessionActivity: setCloudSessionActivity,
        setLocalTurns: setLocalAgentTurnsByRequestId,
        processedMentionIds: processedCloudAgentMentionIdsRef.current,
        turnIdsByRequestId: cloudAgentTurnIdsByRequestIdRef.current,
        agentDefinitionsById: cloudAgentDefinitionsById,
        routesBySessionId: cloudAgentRuntimeRoutesBySessionId,
        defaultRoute: defaultCloudAgentRuntimeRoute,
        mergeMessage,
        syncDiff: syncCloudCollaborationDiff,
        reportFailure: reportCloudGroupAgentFailure,
      },
      stateOps: {
        cleanText,
        upsertRequest: upsertCanonicalRequestIntoLocalState,
        upsertIdentity: upsertCanonicalIdentityIntoLocalState,
        removePendingRows: removeCloudGroupPendingRowsForTerminalResponse,
        removeTimeoutPlaceholder: removeCloudGroupTimeoutPlaceholderForTerminalResponse,
      },
      policy: {
        isRecentMention: isRecentCloudAgentMention,
        messageTargetsLocalAgent: cloudGroupMessageTargetsLocalAgent,
        responseExists: cloudGroupAgentResponseExistsForRequest,
        fallbackRunOwnsRequest: cloudFallbackRunAlreadyOwnsRequest,
        nativeContext: cloudGroupNativeContextMessages,
        waitForTurn: waitForCloudAgentTurn,
        publishActivity: (input) => publishDerivedCloudSessionActivity({
          ...input,
          reportWarning: reportCloudAgentExecutionWarning,
        }),
      },
    });
  }, [
    account,
    client,
    cloudAgentDefinitionsById,
    cloudAgentRuntimeRoutesBySessionId,
    defaultCloudAgentRuntimeRoute,
    mergeMessage,
    syncCloudCollaborationDiff,
    setCanonicalSessionState,
  ]);

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
    localAgentTurnsByRequestId,
    initialMessagesSettled,
    cloudMessageIndex,
    currentAccountMessagesByPeer,
    readInboundMessageIdsByPeer,
  ]);

  useEffect(() => {
    cloudCollaborationStateRef.current = cloudCollaborationState;
    cloudCollaborationStateContextKeyRef.current = cloudCollaborationAccountContextKey;
  }, [cloudCollaborationAccountContextKey, cloudCollaborationState]);

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
  }, [cloudCollaborationAccountContextKey]);

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

  const sendCloudGroupControl = useCallback(async (input: SendCloudGroupControlInput) => {
    if (!account) throw new Error('Not signed in.');
    const firstAckPerformanceSpan = input.kind === 'group-message'
      ? beginChatPerformanceSpan('cloud-send-to-first-ack')
      : null;
    const relatedGroupControls = cloudGroupRelatedControlsForSend(cloudMessageIndex.groupRows.map((row) => ({
      envelope: row.envelope,
      createdAtMs: Date.parse(row.wire.createdAt) || 0,
    })), {
      groupId: input.groupId,
      groupSpaceId: input.groupSpaceId,
    }).sort((left, right) => left.createdAtMs - right.createdAtMs);
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const actor = input.actor ?? cloudGroupSelfParticipant(account, input.kind === 'group-message' ? 'person' : 'admin');
    const hasExplicitCurrentParticipantSnapshot = input.participants !== undefined
      || input.collaborationParticipants !== undefined;
    const inputParticipants = input.participants?.length
      ? input.participants
      : cloudGroupParticipantsForCollaborationSession(account, input.collaborationParticipants ?? []);
    const participants = cloudGroupOutgoingParticipantSnapshot({
      currentParticipants: inputParticipants,
      historicalParticipants: relatedGroupControls.flatMap((control) => control.envelope.participants),
      hasExplicitCurrentSnapshot: hasExplicitCurrentParticipantSnapshot,
    });
    const targetAccountIds = [...new Set([
      ...input.targetAccountIds.map((value) => value.trim()).filter(Boolean),
      ...participants.map((participant) => participant.accountId.trim()).filter(Boolean),
    ])].filter((accountId) => accountId !== account.accountId);
    const explicitTargetAccountIds = input.targetAccountIds
      .map((value) => value.trim())
      .filter((accountId) => accountId && accountId !== account.accountId);
    const requiredTargetAccountIds = requiredCloudGroupControlTargetAccountIds({
      kind: input.kind,
      explicitTargetAccountIds,
      memberLeaves: input.memberLeaves,
    });
    if (targetAccountIds.length === 0) return;
    const groupTitle = cloudGroupTitleForOutgoingControl({
      kind: input.kind,
      groupTitle: input.groupTitle,
      relatedGroupTitles: relatedGroupControls.map((control) => control.envelope.groupTitle),
    });
    const canonicalState = canonicalSessionStateRef.current;
    const sessionTitle = cloudGroupManualSessionTitleSnapshot({
      session: canonicalState?.sessions.find((candidate) => candidate.id === input.groupId),
      identities: canonicalState?.identities,
    });
    const forkFromSessionMetadata = input.kind === 'group-message'
      ? cloudGroupForkPayloadFromSessionMetadata(
          canonicalSessionStateRef.current?.sessions.find((sessionCandidate) => sessionCandidate.id === input.groupId)?.metadata,
          input.groupId,
        )
      : null;
    const buildPayload = (uploadedAttachments: SendCloudMessageAttachmentInput[]) => {
      const groupMessageAttachments = uploadedAttachments.length > 0
        ? uploadedAttachments
        : input.message?.attachments ?? [];
      const message = input.message
        ? {
            ...input.message,
            senderAccountId: input.message.senderAccountId?.trim() || account.accountId,
            attachments: groupMessageAttachments.length > 0
              ? cloudGroupAttachmentReferences(groupMessageAttachments)
              : input.message.attachments,
          }
        : null;
      const envelope = encodeCloudGroupControl({
        kind: input.kind,
        groupId: input.groupId,
        groupSpaceId: input.groupSpaceId ?? null,
        groupTitle,
        createdByAccountId: input.createdByAccountId?.trim() || account.accountId,
        actor,
        participants,
        sessionTitle,
        sessionTitleSyncOnly: input.sessionTitleSyncOnly,
        memberJoins: input.memberJoins,
        memberLeaves: input.memberLeaves,
        fork: input.fork ?? forkFromSessionMetadata,
        message,
      });
      return { message, envelope };
    };
    const initialPayload = buildPayload([]);
    const recordFirstAck = (envelope: string, attachmentCount: number) => finishChatPerformanceSpan(firstAckPerformanceSpan, () => ({
      recipientCount: targetAccountIds.length,
      attachmentCount,
      payloadBytes: chatPerformancePayloadBytes(envelope),
    }));
    const clientCreatedAtMs = typeof initialPayload.message?.createdAtMs === 'number' && Number.isFinite(initialPayload.message.createdAtMs)
      ? initialPayload.message.createdAtMs
      : typeof (input.fork?.createdAtMs ?? forkFromSessionMetadata?.createdAtMs) === 'number' && Number.isFinite(input.fork?.createdAtMs ?? forkFromSessionMetadata?.createdAtMs)
        ? (input.fork?.createdAtMs ?? forkFromSessionMetadata?.createdAtMs)!
        : null;
    const clientCreatedAt = clientCreatedAtMs !== null ? new Date(clientCreatedAtMs).toISOString() : null;
    const canonicalMessageId = cleanText(initialPayload.message?.id);
    if (input.kind === 'group-message' && canonicalMessageId && cloudGroupOutbox) {
      await cloudGroupOutbox.restore();
      const outboxEntry = {
        canonicalMessageId,
        sessionId: input.groupId,
        envelope: initialPayload.envelope,
        trackCanonicalDelivery: initialPayload.message?.forkSnapshot !== true,
        pendingAttachments: cloudGroupOutboxAttachmentSources(input.attachments ?? []),
        clientCreatedAt,
        pendingRecipientIds: targetAccountIds,
        deliveredRecipientIds: [],
        attemptsByRecipientId: {},
        nextAttemptAtMs: 0,
      };
      const queued = input.retryFailed
        ? await cloudGroupOutbox.requeueFailed(outboxEntry)
        : await cloudGroupOutbox.enqueue(outboxEntry);
      if (!queued) return;
      let sentAny = false;
      const sentMessages: CloudMessage[] = [];
      let preparedEntry: Promise<CloudGroupOutboxEntry> | null = null;
      const outcome = await cloudGroupOutbox.deliver(canonicalMessageId, async ({ recipientId, clientMessageId, entry }) => {
        preparedEntry ??= prepareCloudGroupOutboxEntryAttachments({
          outbox: cloudGroupOutbox,
          entry,
          upload: (attachments) => uploadComposerAttachments({
            token: session.token,
            client,
            attachments,
          }),
        });
        const ready = await preparedEntry;
        const sentMessage = await client.sendMessage(session.token, recipientId, ready.envelope, {
          sessionId: ready.sessionId,
          attachments: ready.attachments,
          clientCreatedAt: ready.clientCreatedAt,
          clientMessageId,
        });
        recordFirstAck(ready.envelope, ready.attachments?.length ?? 0);
        sentAny = true;
        sentMessages.push(sentMessage);
        mergeMessage(sentMessage);
      }, { force: true });
      if (outcome) {
        await persistCloudGroupOutboxDelivery(outcome).catch((error) => {
          // Recipient delivery is durable; canonical acknowledgement replays
          // on startup, focus, or reconnect without resending recipients.
          console.warn('[cloud-group-outbox] failed to persist delivery status', error);
        });
      }
      if (sentAny) {
        await Promise.all([
          claimFreshCloudGroupFallback(sentMessages, canonicalMessageId, session.token),
          syncCloudCollaborationDiff().catch(() => {}),
        ]);
      }
      return;
    }
    const uploadedAttachments = input.attachments?.length
      ? await uploadComposerAttachments({ token: session.token, client, attachments: input.attachments })
      : [];
    const payload = buildPayload(uploadedAttachments);
    const results = await Promise.allSettled(targetAccountIds.map(async (peerId) => {
      const sentMessage = await client.sendMessage(session.token, peerId, payload.envelope, {
        sessionId: input.groupId,
        attachments: uploadedAttachments,
        ...(clientCreatedAt ? { clientCreatedAt } : {}),
      });
      recordFirstAck(payload.envelope, uploadedAttachments.length);
      return sentMessage;
    }));
    const sent = fulfilledCloudGroupSends(results);
    sent.forEach(mergeMessage);
    const requiredControlFailure = firstRequiredCloudGroupSendFailure(
      results,
      targetAccountIds,
      requiredTargetAccountIds,
    );
    if (requiredControlFailure) {
      throw requiredControlFailure.reason instanceof Error
        ? requiredControlFailure.reason
        : new Error(String(requiredControlFailure.reason || 'Required group control failed.'));
    }
    if (sent.length > 0) {
      if (input.kind === 'group-message' && canonicalMessageId) {
        await Promise.all([
          claimFreshCloudGroupFallback(sent, canonicalMessageId, session.token),
          syncCloudCollaborationDiff(),
        ]);
        return;
      }
      await syncCloudCollaborationDiff();
      return;
    }
    const firstFailure = firstCloudGroupSendFailure(results);
    throw firstFailure instanceof Error ? firstFailure : new Error(String(firstFailure || 'Group message failed.'));
  }, [account, claimFreshCloudGroupFallback, client, cloudGroupOutbox, cloudMessageIndex, mergeMessage, persistCloudGroupOutboxDelivery, syncCloudCollaborationDiff]);

  useEffect(() => {
    if (!account || !canonicalSessionState || !initialMessagesSettled) return;
    const controls = cloudMessageIndex.groupRows.map((row) => ({
      envelope: row.envelope,
      createdAtMs: Date.parse(row.wire.createdAt) || 0,
    }));
    const identityById = new Map(canonicalSessionState.identities.map((identity) => [identity.id, identity]));
    for (const canonicalSession of canonicalSessionState.sessions) {
      if (canonicalSession.kind !== 'group') continue;
      const sessionTitle = cloudGroupManualSessionTitleSnapshot({
        session: canonicalSession,
        identities: canonicalSessionState.identities,
      });
      if (!sessionTitle) continue;
      const metadata = objectContent(canonicalSession.metadata);
      const groupSpaceId = cleanText(
        typeof metadata.groupSpaceId === 'string'
          ? metadata.groupSpaceId
          : typeof metadata.groupId === 'string'
            ? metadata.groupId
            : canonicalSession.id,
      ) || canonicalSession.id;
      const relatedControls = cloudGroupRelatedControlsForSend(controls, {
        groupId: canonicalSession.id,
        groupSpaceId,
      }).sort((left, right) => left.createdAtMs - right.createdAtMs);
      const latestControl = relatedControls[relatedControls.length - 1]?.envelope;
      if (!latestControl) continue;
      const targetAccountIds = [...new Set(latestControl.participants
        .map((participant) => participant.accountId.trim())
        .filter((accountId) => accountId && accountId !== account.accountId))];
      if (targetAccountIds.length === 0) continue;
      const backfillKey = `${account.accountId}:${canonicalSession.id}`;
      if (cloudGroupSessionTitleBackfillsRef.current.has(backfillKey)) continue;

      const creatorIdentityId = cleanText(
        typeof metadata.groupCreatorIdentityId === 'string'
          ? metadata.groupCreatorIdentityId
          : canonicalSession.createdByIdentityId,
      );
      const adminIdentityIds = new Set([
        creatorIdentityId,
        ...(Array.isArray(metadata.adminIdentityIds)
          ? metadata.adminIdentityIds.filter((identityId): identityId is string => typeof identityId === 'string')
          : []),
      ].map((identityId) => identityId.trim()).filter(Boolean));
      const selfIdentityId = canonicalSessionState.profile.humanIdentityId?.trim() ?? '';
      const actor = cloudGroupSelfParticipant(
        account,
        adminIdentityIds.has(selfIdentityId) ? 'admin' : 'person',
      );
      const creatorIdentity = identityById.get(creatorIdentityId);
      const createdByAccountId = cleanText(creatorIdentity?.humanId)
        || cleanText(creatorIdentity?.sourceIdentityId)
        || latestControl.createdByAccountId;

      cloudGroupSessionTitleBackfillsRef.current.add(backfillKey);
      void sendCloudGroupControl({
        targetAccountIds,
        kind: 'session-title-update',
        groupId: canonicalSession.id,
        groupSpaceId,
        groupTitle: sessionTitle.title,
        createdByAccountId,
        actor,
        participants: latestControl.participants,
        sessionTitleSyncOnly: true,
      }).catch((error) => {
        cloudGroupSessionTitleBackfillsRef.current.delete(backfillKey);
        console.warn('[cloud-group-session-title] failed to backfill title', error);
      });
    }
  }, [account, canonicalSessionState, cloudMessageIndex, initialMessagesSettled, sendCloudGroupControl]);

  const refreshCloudSessionActivity = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!account || !trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) return;
    const snapshot = await client.listSessionActivity(session.token, trimmedSessionId);
    const normalized = normalizeCloudSessionActivitySnapshot(snapshot);
    setCloudSessionActivity((current) => mergeCloudSessionActivity(current, normalized));
  }, [account, client]);

  const publishCloudTaskActivity = useCallback(async (input: UpsertCloudTaskActivityInput) => {
    if (!account) throw new Error('Not signed in.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const task = await client.upsertTaskActivity(session.token, input);
    setCloudSessionActivity((current) => mergeCloudSessionActivity(
      current,
      normalizeCloudSessionActivitySnapshot({ tasks: [task], artifacts: [] }),
    ));
  }, [account, client]);

  const publishCloudArtifactActivity = useCallback(async (input: UpsertCloudArtifactActivityInput) => {
    if (!account) throw new Error('Not signed in.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const artifact = await client.upsertArtifactActivity(session.token, input);
    setCloudSessionActivity((current) => mergeCloudSessionActivity(
      current,
      normalizeCloudSessionActivitySnapshot({ tasks: [], artifacts: [artifact] }),
    ));
  }, [account, client]);

  const recordCloudSessionFork = useCallback(async (input: { sourceSessionId: string; forkSessionId: string; parentMessageId?: string | null }) => {
    if (!account) throw new Error('Not signed in.');
    const sourceSessionId = input.sourceSessionId.trim();
    const forkSessionId = input.forkSessionId.trim();
    if (!sourceSessionId || !forkSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const fork = await client.createSessionFork(session.token, sourceSessionId, {
      forkSessionId,
      parentMessageId: input.parentMessageId ?? null,
    });
    setCloudSessionForksById((current) => ({ ...current, [fork.forkSessionId]: fork }));
    const cloned = cloneCloudSessionActivityForFork(
      cloudSessionActivityRef.current,
      sourceSessionId,
      forkSessionId,
      new Date().toISOString(),
    );
    setCloudSessionActivity((current) => mergeCloudSessionActivity(current, cloned));
    void refreshCloudSessionActivity(forkSessionId);
  }, [account, client, refreshCloudSessionActivity]);

  const updateCloudSessionPin = useCallback(async (input: { sessionId: string; messageId: string | null; scope: 'private' | 'shared' }) => {
    if (!account) throw new Error('Cloud account is not signed in.');
    const trimmedSessionId = input.sessionId.trim();
    if (!trimmedSessionId) throw new Error('Session id is required.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Cloud session is not available.');
    const pin = await client.updateCloudSessionPin(session.token, trimmedSessionId, {
      messageId: input.messageId?.trim() || null,
      scope: input.scope,
    });
    setCloudSessionPinsById((current) => ({ ...current, [pin.sessionId]: pin }));
    void syncCloudCollaborationDiff();
    return pin;
  }, [account, client, syncCloudCollaborationDiff]);

  const hideCloudSession = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    await client.hideCloudSession(session.token, trimmedSessionId);
    setCloudHiddenSessionIds((current) => new Set(current).add(trimmedSessionId));
  }, [client]);

  const unhideCloudSession = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    await client.unhideCloudSession(session.token, trimmedSessionId);
    setCloudHiddenSessionIds((current) => {
      if (!current.has(trimmedSessionId)) return current;
      const next = new Set(current);
      next.delete(trimmedSessionId);
      return next;
    });
  }, [client]);

  const deleteCloudSession = useCallback(async (sessionId: string) => {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    await client.deleteCloudSession(session.token, trimmedSessionId);
    setCloudHiddenSessionIds((current) => {
      if (!current.has(trimmedSessionId)) return current;
      const next = new Set(current);
      next.delete(trimmedSessionId);
      return next;
    });
    setCloudDeletedSessionIds((current) => new Set(current).add(trimmedSessionId));
    if (account) {
      setMessagesByPeer((current) => removeCloudSessionMessages(account.accountId, current, trimmedSessionId));
    }
  }, [account, client]);

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
  }, [account, canonicalSessionState?.messages, client, cloudMessageIndex, mergeMessage, setCanonicalSessionState, syncCloudCollaborationDiff]);

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
