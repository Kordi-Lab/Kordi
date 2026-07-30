import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { cloudAgentContextMessagesFromDefinition } from '@/features/chat/chatCreateFlows';
import {
  deriveSessionTitle,
  incomingSessionTitleWins,
  isGenericSessionTitle,
  sessionTitleMetadata,
  titleSourceFromMetadata,
} from '@/features/chat/sessionTitlePolicy';
import {
  adoptCloudProfileIdentity,
  buildDesktopCloudProviderAuthSnapshotPayload,
  cancelDesktopChatTurn,
  fetchDesktopChatTurnState,
  markCanonicalSessionRead,
  openOrCreateCanonicalSessionFast,
  startDesktopChatMessage,
  upsertCanonicalIdentityFast,
  upsertCanonicalMessageFast,
  updateCanonicalMessageDelivery,
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
  mergeCanonicalMessageDeliveryDelta,
  mergeCanonicalMessageRow,
  mergeCanonicalReadCursorDelta,
} from '@/features/canonical/canonicalStateReducers';
import {
  beginChatPerformanceSpan,
  chatPerformancePayloadBytes,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import {
  CloudAuthClient,
  cloudRealtimeWebSocketEnabled,
  cloudWebSocketUrl,
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
  cloudSessionIdFromConversationId,
  isCloudCollaborationHostId,
} from './cloudCollaborationState';
import {
  CLOUD_AGENT_RUNTIME_SESSION_PREFIX,
  cloudAgentNativeContextMessagesFromDirectCloudSession,
  compactCloudAgentNativeContextMessages,
  cloudMessageMentionsLocalAgent,
  cloudAgentNoProviderNoticeText,
  isCloudAgentNoProviderConfiguredError,
  encodeCloudAgentCancel,
  encodeCloudAgentResponse,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import {
  cloudAgentRuntimeRouteForSession,
  cloudAgentRuntimeRouteForTargetCloudAgent,
  cloudAgentRuntimeSessionId,
} from './cloudAgentRuntime';
import { cloudProviderAuthSnapshotRouteSignature } from './providerAuthSnapshot';
import {
  cloudGroupAttachmentReferences,
  cloudGroupControlWithAttachmentReferences,
  cloudGroupAgentConversationId,
  cloudGroupForkPayloadFromSessionMetadata,
  cloudGroupIdFromAgentConversationId,
  cloudGroupManualSessionTitleSnapshot,
  cloudGroupMessageReadTargets,
  cloudGroupOutgoingParticipantSnapshot,
  cloudGroupParticipantsForCollaborationSession,
  cloudGroupSelfParticipant,
  cloudGroupTitleForOutgoingControl,
  cloudGroupUnreadCountsBySessionId,
  type CloudGroupReadCursor,
  cloudGroupRelatedControlsForSend,
  encodeCloudGroupControl,
  firstCloudGroupSendFailure,
  firstRequiredCloudGroupSendFailure,
  fulfilledCloudGroupSends,
  parseCloudGroupControl,
  requiredCloudGroupControlTargetAccountIds,
  type CloudGroupControlEnvelope,
  type CloudGroupMemberJoin,
  type CloudGroupMemberLeave,
  type CloudGroupParticipant,
} from './cloudGroupMessages';
import {
  buildCloudMessageIndex,
  cloudGroupReplayKeyForRow,
  patchCanonicalDeliverySummaries,
  type CloudMessageIndex,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';
import {
  cloudDirectMessageAction,
  cloudDirectMessageDisplayText,
  cloudDirectMessageTargetCloudAgentId,
} from './cloudDirectMessages';
import {
  cloudMessageActionAllowsAgentContext,
  cloudMessageActionAllowsAgentTrigger,
} from './cloudAgentTriggerPolicy';
import {
  uploadComposerAttachments,
  resolveForwardAttachmentItems,
  resolveCloudMessageAttachments,
  resetCloudAttachmentPreviewLoader,
} from './cloudAttachments';
import { defaultCloudAgentsClient, type CreateCloudAgentInput, type UpdateCloudAgentInput } from './cloudAgentsClient';
import type { CloudAgentDefinition, SharedCloudAgentSummary } from './cloudAgents';
import { cloudMessageMetadataOnly, defaultCloudMessageCache } from './cloudMessageCache';
import {
  CloudGroupOutbox,
  cloudGroupOutboxNextWakeAtMs,
  cloudGroupOutboxDeliveryStatus,
  defaultCloudGroupOutboxPersistence,
  type CloudGroupOutboxAttachmentSource,
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
  deriveCloudActivityFromTurn,
  cloudVisibleTaskRecordsForSession,
  loadCachedCloudSessionActivity,
  mergeCloudSessionActivity,
  normalizeCloudSessionActivitySnapshot,
  saveCachedCloudSessionActivity,
  type CloudActivityParticipantProfile,
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import { loadSession } from './session';
import { CLOUD_CONTACT_ACCEPTED_SYNC_EVENT, useCloudContacts } from './useCloudContacts';
import {
  applyCloudGroupSessionControl,
  resolveAuthorizedCloudGroupSessionTitleSnapshot,
  resolveCloudGroupAdminSnapshot,
} from './cloudGroupSessionControl';
import { applyCloudGroupMessageControl } from './cloudGroupMessageControl';
import { applyCloudGroupAgentControl } from './cloudGroupAgentControl';
import {
  CLOUD_FOCUS_REFRESH_DELAY_MS,
  cloudBootstrapPeerIds,
  cloudAccountGenerationKey,
  cloudMessagesAuthoritativeForContext,
  cloudMessagesByPeerEqual,
  cloudUnreadReadinessContextKey,
  cloudUnreadStatusForContext,
  markCloudMessagesReadLocally,
  mergeCloudMessagesByPeerSnapshot,
  shouldRefreshCloudForVisibility,
  shouldRunCloudFocusRefresh,
  type CloudUnreadReadinessSnapshot,
  type CloudUnreadReadinessStatus,
} from './cloudMessageSyncState';
import { useCloudMessageSync } from './useCloudMessageSync';
import { cloudFallbackRunClaimsForMessages } from './cloudAgentFallbackClaims';
import {
  isRecentCloudAgentMention,
  shouldRunLocalCloudAgentForCloudMessage,
} from './cloudAgentMentionPolicy';
import {
  cloudAgentResponseExistsForRequest,
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

export const CLOUD_AGENT_TURN_POLL_MS = 500;
export const CLOUD_AGENT_TURN_TIMEOUT_MS = 10 * 60_000;

const EMPTY_CLOUD_MESSAGES_BY_PEER: Record<string, CloudMessage[]> = {};

function cloudAgentLocalFailureMessage(error: unknown): string {
  if (isCloudAgentNoProviderConfiguredError(error)) return cloudAgentNoProviderNoticeText();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Kordi could not finish this reply. Try again.';
}

export function cloudAgentFailedTurnSnapshot({
  requestId,
  sessionId,
  prompt,
  error,
  now = Date.now(),
}: {
  requestId: string;
  sessionId: string;
  prompt: string;
  error: unknown;
  now?: number;
}): DesktopChatTurnSnapshot {
  const message = cloudAgentLocalFailureMessage(error);
  return {
    id: `cloud-agent-local-failure:${requestId}`,
    sessionId,
    prompt,
    status: 'failed',
    message,
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: false,
    startedAtMs: now,
    completedAtMs: now,
    error: message,
    transcriptRefreshRequired: false,
  };
}

export function cloudGroupOutboxAttachmentSources(
  attachments: readonly AttachmentItem[],
): CloudGroupOutboxAttachmentSource[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    path: attachment.path,
    name: attachment.name,
    kind: attachment.kind,
    formatLabel: attachment.formatLabel ?? null,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
  }));
}

export async function prepareCloudGroupOutboxEntryAttachments({
  outbox,
  entry,
  upload,
}: {
  outbox: CloudGroupOutbox;
  entry: CloudGroupOutboxEntry;
  upload: (attachments: CloudGroupOutboxAttachmentSource[]) => Promise<SendCloudMessageAttachmentInput[]>;
}): Promise<CloudGroupOutboxEntry> {
  const pendingAttachments = entry.pendingAttachments ?? [];
  if (pendingAttachments.length === 0) return entry;
  const attachments = await upload(pendingAttachments);
  const envelope = cloudGroupControlWithAttachmentReferences(entry.envelope, attachments);
  const prepared = await outbox.completeAttachmentUpload(entry.canonicalMessageId, {
    envelope,
    attachments,
  });
  if (!prepared) throw new Error('Cloud group outbox entry disappeared during attachment upload.');
  return prepared;
}

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

async function publishDerivedCloudSessionActivity({
  client,
  token,
  accountId,
  sessionId,
  participantAccountIds,
  participantProfiles = [],
  turn,
  mergeActivity,
}: {
  client: CloudAuthClient;
  token: string;
  accountId: string;
  sessionId: string;
  participantAccountIds: string[];
  participantProfiles?: CloudActivityParticipantProfile[];
  turn: DesktopChatTurnSnapshot;
  mergeActivity: (snapshot: CloudSessionActivityStore) => void;
}) {
  const activity = deriveCloudActivityFromTurn({
    sessionId,
    localAccountId: accountId,
    participantAccountIds: [...new Set([accountId, ...participantAccountIds].map((value) => value.trim()).filter(Boolean))],
    participantProfiles,
    turn,
  });
  if (activity.tasks.length === 0 && activity.artifacts.length === 0) return;
  const [taskResults, artifactResults] = await Promise.all([
    Promise.allSettled(activity.tasks.map((task) => client.upsertTaskActivity(token, task))),
    Promise.allSettled(activity.artifacts.map((artifact) => client.upsertArtifactActivity(token, artifact))),
  ]);
  const tasks = taskResults.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<CloudAuthClient['upsertTaskActivity']>>> => result.status === 'fulfilled').map((result) => result.value);
  const artifacts = artifactResults.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<CloudAuthClient['upsertArtifactActivity']>>> => result.status === 'fulfilled').map((result) => result.value);
  if (tasks.length > 0 || artifacts.length > 0) {
    mergeActivity(normalizeCloudSessionActivitySnapshot({ tasks, artifacts }));
  }
  const firstFailure = [...taskResults, ...artifactResults].find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
  if (firstFailure) {
    console.warn('[cloud-session-activity] publish failed', firstFailure.reason);
  }
}

export function optimisticCloudAgentCancelMessage({
  account,
  peerAccountId,
  requestId,
  now = Date.now(),
}: {
  account: CloudAccount;
  peerAccountId: string;
  requestId: string;
  now?: number;
}): CloudMessage {
  const trimmedRequestId = requestId.trim();
  const trimmedPeerAccountId = peerAccountId.trim();
  return {
    messageId: `local-cloud-agent-cancel:${trimmedRequestId}:${trimmedPeerAccountId}`,
    fromAccountId: account.accountId,
    toAccountId: trimmedPeerAccountId,
    body: encodeCloudAgentCancel({ requestId: trimmedRequestId }),
    createdAt: new Date(now).toISOString(),
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
  };
}

export function cloudGroupAgentProcessingMessageForRequest(
  messages: CanonicalSessionMessage[],
  groupId: string,
  requestId: string,
): CanonicalSessionMessage | null {
  const trimmedGroupId = groupId.trim();
  const trimmedRequestId = requestId.trim();
  if (!trimmedGroupId || !trimmedRequestId) return null;
  return messages.find((message) => {
    if (message.sessionId !== trimmedGroupId || !message.sourceTransport?.startsWith('cloud-group-agent')) return false;
    const content = objectContent(message.content);
    const linkedRequestId = cleanText(message.parentMessageId)
      || cleanText(typeof content.requestId === 'string' ? content.requestId : null)
      || cleanText(typeof content.replyToMessageId === 'string' ? content.replyToMessageId : null);
    if (linkedRequestId !== trimmedRequestId) return false;
    const deliveryState = cleanText(typeof content.deliveryState === 'string' ? content.deliveryState : null).toLowerCase();
    return message.status === 'processing' || deliveryState === 'processing';
  }) ?? null;
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

export type CloudGroupAgentCancelRole = 'sender' | 'agent owner' | 'participant';

export function cloudGroupAgentCancelledNoticeRequest({
  processingMessage,
  requestId,
  conversationId,
  cancelledByAccountId,
  cancelledByRole,
  now,
}: {
  processingMessage: CanonicalSessionMessage;
  requestId: string;
  conversationId: string;
  cancelledByAccountId: string;
  cancelledByRole: CloudGroupAgentCancelRole;
  now?: number;
}): AppendCanonicalMessageRequest {
  const content = objectContent(processingMessage.content);
  const stableTimestampMs = typeof content.timestampMs === 'number' && Number.isFinite(content.timestampMs)
    ? content.timestampMs
    : processingMessage.createdAtMs;
  const noticeTimestampMs = typeof now === 'number' && Number.isFinite(now) ? now : stableTimestampMs;
  const trimmedRequestId = requestId.trim();
  const trimmedCancelledByAccountId = cancelledByAccountId.trim() || 'local';
  const role = cancelledByRole || 'participant';
  const text = `Request canceled by ${role}.`;
  // Always overwrite the processing row in place. processingMessage is the
  // current slot holding the "Processing…"/"Requesting…" state for this
  // request — whether that's the offline-tier placeholder (sourceTransport
  // 'cloud-group-agent-offline') or the live processing envelope from the
  // owner instance (sourceTransport 'cloud-group-agent'). Using a separate
  // cancel-notice id in the latter case leaves two rows for one slot, and
  // the offline-timer effect's setCloudGroupRequestPlaceholderProcessing
  // deletes the cancel row via cloudGroupAgentResponseMatches on each render
  // — producing visible oscillation between "Processing…" and the cancel
  // notice. cloudGroupAgentProcessingMessageForRequest only returns rows in
  // a processing state, so reusing this id can never clobber a completed
  // agent reply.
  const noticeId = processingMessage.id;
  return {
    id: noticeId,
    sessionId: processingMessage.sessionId,
    senderIdentityId: processingMessage.senderIdentityId,
    senderRole: processingMessage.senderRole,
    messageKind: 'agent-turn',
    contentText: text,
    content: {
      sender: typeof content.sender === 'string' ? content.sender : 'Kordi',
      timestampMs: noticeTimestampMs,
      deliveryState: 'cancelled',
      sourceConversationId: conversationId,
      requestId: trimmedRequestId,
      replyToMessageId: trimmedRequestId,
      cancelledByAccountId: trimmedCancelledByAccountId,
      cancelledByRole: role,
    },
    createdAtMs: noticeTimestampMs,
    parentMessageId: trimmedRequestId,
    status: 'cancelled',
    sourceTransport: 'cloud-group-agent',
    sourceEventId: `cloud-group-agent-cancel:${trimmedRequestId}:${trimmedCancelledByAccountId}`,
  };
}

function accountIdForHumanIdentity(state: CanonicalSessionState, identityId?: string | null): string | null {
  const identity = identityId ? state.identities.find((candidate) => candidate.id === identityId) : null;
  if (!identity || identity.kind !== 'human') return null;
  const metadata = objectContent(identity.metadata);
  return cleanText(identity.humanId)
    || cleanText(identity.sourceIdentityId)
    || cleanText(typeof metadata.accountId === 'string' ? metadata.accountId : null)
    || null;
}

export function cloudGroupAgentCancelRoleForRequest({
  state,
  requestId,
  processingMessage,
  cancelledByAccountId,
}: {
  state: CanonicalSessionState;
  requestId: string;
  processingMessage: CanonicalSessionMessage;
  cancelledByAccountId: string;
}): CloudGroupAgentCancelRole {
  const trimmedCancelledByAccountId = cancelledByAccountId.trim();
  const requestMessage = state.messages.find((message) => message.id === requestId.trim()) ?? null;
  const requestSenderAccountId = accountIdForHumanIdentity(state, requestMessage?.senderIdentityId);
  if (requestSenderAccountId && requestSenderAccountId === trimmedCancelledByAccountId) return 'sender';
  const agentOwnerAccountId = processingMessage.senderIdentityId.startsWith('agent:cloud:')
    ? processingMessage.senderIdentityId.slice('agent:cloud:'.length)
    : null;
  if (agentOwnerAccountId && agentOwnerAccountId === trimmedCancelledByAccountId) return 'agent owner';
  return 'participant';
}

function upsertCanonicalIdentityIntoLocalState(
  current: CanonicalSessionState | null,
  identity: CanonicalIdentity,
): CanonicalSessionState | null {
  if (!current) return current;
  return {
    ...current,
    identities: [
      ...current.identities.filter((candidate) => candidate.id !== identity.id),
      identity,
    ],
  };
}

function mergeOpenCanonicalSessionFastResultIntoLocalState(
  current: CanonicalSessionState | null,
  result: OpenCanonicalSessionFastResult,
): CanonicalSessionState | null {
  if (!current) return current;
  return {
    ...current,
    sessions: [
      result.session,
      ...current.sessions.filter((session) => session.id !== result.session.id),
    ],
    participants: [
      ...current.participants.filter((participant) => participant.sessionId !== result.session.id),
      ...result.participants,
    ],
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function cloudAgentResponsePublicationIsBlocked({
  client,
  token,
  peerId,
  fallbackMessages,
  account,
  requestMessageId,
}: {
  client: CloudAuthClient;
  token: string;
  peerId: string;
  fallbackMessages: readonly CloudMessage[];
  account: CloudAccount;
  requestMessageId: string;
}): Promise<boolean> {
  const [latestMessages, fallbackRunOwnsRequest] = await Promise.all([
    client.listMessages(token, peerId, 100).catch(() => fallbackMessages),
    cloudFallbackRunAlreadyOwnsRequest({ client, token, requestMessageId }),
  ] as const);
  return fallbackRunOwnsRequest
    || cloudAgentResponseExistsForRequest({ account, requestMessageId, peerMessages: latestMessages });
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

const CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX = 'kordi.cloud.selfAgentSync.v2:';
const CLOUD_SELF_AGENT_FORWARD_BASELINE_PREFIX = 'kordi.cloud.selfAgentForwardBaseline.v1:';

type CloudSelfAgentSyncLedgerEntry = {
  cloudMessageId: string | null;
  syncedAtMs: number;
  skippedLocalBackfill?: boolean;
};

type CloudSelfAgentSyncLedger = Record<string, CloudSelfAgentSyncLedgerEntry>;

type CloudSelfAgentSyncOperation = {
  localMessageId: string;
  sessionId: string;
  role: 'user' | 'agent';
  text: string;
  parentLocalMessageId: string | null;
  createdAtMs: number;
};

export type CloudSelfAgentSyncStatus = {
  state: 'syncing' | 'synced' | 'error';
  pendingCount?: number;
  message?: string;
  updatedAtMs: number;
};

export function cloudSelfAgentDerivedSyncedStatusBySessionId(
  accountId: string | null | undefined,
  messagesByPeer: Record<string, CloudMessage[]>,
  updatedAtMs: number = Date.now(),
): Record<string, CloudSelfAgentSyncStatus> {
  const localAccountId = accountId?.trim();
  if (!localAccountId) return {};
  const statuses: Record<string, CloudSelfAgentSyncStatus> = {};
  for (const message of messagesByPeer[localAccountId] ?? []) {
    if (message.fromAccountId !== localAccountId || message.toAccountId !== localAccountId) continue;
    const sessionId = cleanText(message.sessionId);
    if (!sessionId) continue;
    statuses[sessionId] = { state: 'synced', updatedAtMs };
  }
  return statuses;
}

function selfAgentSyncLedgerKey(accountId: string): string {
  return `${CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX}${accountId}`;
}

function selfAgentForwardBaselineKey(accountId: string): string {
  return `${CLOUD_SELF_AGENT_FORWARD_BASELINE_PREFIX}${accountId}`;
}

function loadCloudSelfAgentForwardBaseline(accountId: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(selfAgentForwardBaselineKey(accountId)) === '1';
}

function saveCloudSelfAgentForwardBaseline(accountId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(selfAgentForwardBaselineKey(accountId), '1');
  } catch {
    // Best effort. If persistence fails, this device may try again later.
  }
}

function loadCloudSelfAgentSyncLedger(accountId: string): CloudSelfAgentSyncLedger {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(selfAgentSyncLedgerKey(accountId));
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const ledger: CloudSelfAgentSyncLedger = {};
    for (const [localMessageId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const cloudMessageId = cleanText(typeof (value as Record<string, unknown>).cloudMessageId === 'string'
        ? (value as Record<string, unknown>).cloudMessageId as string
        : null);
      const syncedAtMs = (value as Record<string, unknown>).syncedAtMs;
      const skippedLocalBackfill = (value as Record<string, unknown>).skippedLocalBackfill === true;
      if (!localMessageId.trim() || typeof syncedAtMs !== 'number' || !Number.isFinite(syncedAtMs)) continue;
      if (!cloudMessageId && !skippedLocalBackfill) continue;
      ledger[localMessageId] = { cloudMessageId: cloudMessageId || null, syncedAtMs, skippedLocalBackfill: skippedLocalBackfill || undefined };
    }
    return ledger;
  } catch {
    return {};
  }
}

function saveCloudSelfAgentSyncLedger(accountId: string, ledger: CloudSelfAgentSyncLedger): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(selfAgentSyncLedgerKey(accountId), JSON.stringify(ledger));
  } catch {
    // Best effort. A failed ledger write may cause a future duplicate sync, but
    // should not block local chat or Cloud refresh.
  }
}

function isTerminalSelfAgentMessage(message: CanonicalSessionMessage): boolean {
  const status = cleanText(message.status).toLowerCase();
  return !['', 'sending', 'processing', 'failed', 'cancelled'].includes(status);
}

function cloudSelfAgentCanonicalMessageId(messageId: string): string {
  return `msg:cloud:self:${messageId}`;
}

function cloudSelfAgentCreatedAtMs(message: CloudMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

type CloudSelfAgentRestoreMessage = {
  message: CloudMessage;
  sessionId: string;
  role: 'user' | 'agent';
  text: string;
  createdAtMs: number;
  responseRequestId: string | null;
  messageAction: MessageActionMetadata | null;
};

function isSharedCloudSessionId(sessionId: string): boolean {
  const trimmed = cleanText(sessionId);
  return trimmed.startsWith('session:direct-person:') || trimmed.startsWith('session:group:');
}

function cloudGroupReadCursorsBySessionId(canonicalState?: CanonicalSessionState | null): Record<string, CloudGroupReadCursor> {
  if (!canonicalState) return {};
  const rawMessageById = new Map(canonicalState.messages.map((message) => [message.id, message]));
  const cursors: Record<string, CloudGroupReadCursor> = {};
  for (const participant of canonicalState.participants) {
    if (participant.role !== 'self') continue;
    if (canonicalState.profile.humanIdentityId && participant.identityId !== canonicalState.profile.humanIdentityId) continue;
    const lastReadMessageId = cleanText(participant.lastReadMessageId);
    if (!lastReadMessageId) continue;
    const lastReadMessage = rawMessageById.get(lastReadMessageId);
    cursors[participant.sessionId] = {
      lastReadMessageId,
      lastReadCreatedAtMs: lastReadMessage?.createdAtMs ?? participant.lastSeenAtMs ?? null,
    };
  }
  return cursors;
}

function normalizeCloudSelfAgentRestoreMessage(
  message: CloudMessage,
  isGroupControl?: boolean,
): CloudSelfAgentRestoreMessage | null {
  const sessionId = cleanText(message.sessionId);
  if (!sessionId || isSharedCloudSessionId(sessionId)) return null;
  const response = parseCloudAgentResponse(message.body);
  if (!response && (parseCloudAgentCancel(message.body) || (isGroupControl ?? Boolean(parseCloudGroupControl(message.body))))) return null;
  const text = cleanText(response?.text ?? cloudDirectMessageDisplayText(message.body));
  if (!text) return null;
  return {
    message,
    sessionId,
    role: response ? 'agent' : 'user',
    text,
    createdAtMs: cloudSelfAgentCreatedAtMs(message),
    responseRequestId: response?.requestId ?? null,
    messageAction: response ? null : cloudDirectMessageAction(message.body),
  };
}

function restoredForkSnapshotCloudMessageIds(
  messages: CloudSelfAgentRestoreMessage[],
  forksBySessionId: Record<string, CloudSessionForkSummary>,
): Set<string> {
  const messagesBySessionId = new Map<string, CloudSelfAgentRestoreMessage[]>();
  for (const message of messages) {
    const bucket = messagesBySessionId.get(message.sessionId) ?? [];
    bucket.push(message);
    messagesBySessionId.set(message.sessionId, bucket);
  }

  const snapshotIds = new Set<string>();
  for (const fork of Object.values(forksBySessionId)) {
    const forkSessionId = cleanText(fork.forkSessionId);
    const parentSessionId = cleanText(fork.parentSessionId);
    if (!forkSessionId || !parentSessionId) continue;
    const forkMessages = messagesBySessionId.get(forkSessionId) ?? [];
    const parentMessages = messagesBySessionId.get(parentSessionId) ?? [];
    if (forkMessages.length === 0 || parentMessages.length === 0) continue;

    for (let index = 0; index < forkMessages.length && index < parentMessages.length; index += 1) {
      const forkMessage = forkMessages[index];
      const parentMessage = parentMessages[index];
      if (forkMessage.role !== parentMessage.role || forkMessage.text !== parentMessage.text) break;
      snapshotIds.add(forkMessage.message.messageId);
    }
  }
  return snapshotIds;
}

function existingCanonicalMessageMatchesCloudSelfAgent(
  existing: CanonicalSessionMessage,
  input: { sessionId: string; role: 'user' | 'agent'; text: string; createdAtMs: number; cloudMessageId: string },
): boolean {
  if (existing.sessionId !== input.sessionId) return false;
  if (existing.id === cloudSelfAgentCanonicalMessageId(input.cloudMessageId)) return true;
  if (existing.sourceTransport === 'cloud-self-agent' && existing.sourceEventId === input.cloudMessageId) return true;
  const existingText = cleanText(existing.contentText);
  if (!existingText || existingText !== input.text) return false;
  const roleMatches = input.role === 'user'
    ? existing.senderRole === 'user'
    : existing.senderRole.includes('agent') || existing.messageKind === 'agent-turn';
  if (!roleMatches) return false;
  return Math.abs(existing.createdAtMs - input.createdAtMs) <= 5_000;
}

export function planCloudSelfAgentCanonicalSync({
  account,
  messages,
  state,
  forksBySessionId = {},
  groupRowByWireMessageId,
  cloudTitlesBySessionId = {},
}: {
  account: CloudAccount;
  messages: CloudMessage[];
  state: CanonicalSessionState;
  forksBySessionId?: Record<string, CloudSessionForkSummary>;
  groupRowByWireMessageId?: ReadonlyMap<string, IndexedCloudGroupRow>;
  cloudTitlesBySessionId?: Readonly<Record<string, CloudSessionTitle>>;
}): {
  agentIdentityRequest: UpsertCanonicalIdentityRequest;
  sessionRequests: OpenCanonicalSessionRequest[];
  messageRequests: AppendCanonicalMessageRequest[];
} {
  const localHumanIdentityId = state.profile.humanIdentityId?.trim() || `human:${account.accountId}`;
  const agentIdentityId = `agent:cloud-self:${account.accountId}`;
  const sorted = [...messages]
    .filter((message) => message.fromAccountId === account.accountId && message.toAccountId === account.accountId)
    .sort((left, right) => (
      cloudSelfAgentCreatedAtMs(left) - cloudSelfAgentCreatedAtMs(right)
      || left.messageId.localeCompare(right.messageId)
    ));
  const normalizedMessages = sorted
    .map((message) => normalizeCloudSelfAgentRestoreMessage(
      message,
      groupRowByWireMessageId?.has(message.messageId),
    ))
    .filter((message): message is CloudSelfAgentRestoreMessage => Boolean(message));
  const forkSnapshotCloudMessageIds = restoredForkSnapshotCloudMessageIds(normalizedMessages, forksBySessionId);

  const userTextByCloudMessageId = new Map<string, string>();
  const requestLocalMessageIdByCloudMessageId = new Map<string, string>();
  const plannedCanonicalMessageIdByDuplicateKey = new Map<string, string>();
  const sessionRequestsById = new Map<string, OpenCanonicalSessionRequest>();
  const existingSessionById = new Map(state.sessions.map((session) => [session.id, session]));
  const messageRequests: AppendCanonicalMessageRequest[] = [];

  const ensureSessionRequest = (
    sessionId: string,
    seed: string,
    generatedFromMessageId?: string | null,
    updatedAtMs?: number,
    isForkSnapshot = false,
  ) => {
    const cloudTitle = cloudTitlesBySessionId[sessionId];
    const fork = forksBySessionId[sessionId];
    const generatedTitle = deriveSessionTitle(seed);
    const title = cloudTitle?.title ?? generatedTitle ?? (fork ? 'New fork' : 'New chat');
    const cloudTitleMetadata = cloudTitle ? {
      sessionTitleSource: cloudTitle.titleSource,
      titleSource: cloudTitle.titleSource,
      sessionTitleRevision: cloudTitle.titleRevision,
      sessionTitlePolicyVersion: cloudTitle.titlePolicyVersion,
      sessionTitleUpdatedAtMs: cloudTitle.updatedAtMs,
      sessionTitleUpdatedByAccountId: cloudTitle.updatedByAccountId,
      ...(cloudTitle.titleGeneratedFromMessageId
        ? { sessionTitleGeneratedFromMessageId: cloudTitle.titleGeneratedFromMessageId }
        : {}),
    } : null;
    const planned = sessionRequestsById.get(sessionId);
    if (planned) {
      const plannedMetadata = planned.metadata && typeof planned.metadata === 'object' && !Array.isArray(planned.metadata)
        ? planned.metadata as Record<string, unknown>
        : {};
      const plannedSource = titleSourceFromMetadata(plannedMetadata, planned.title);
      const plannedUpdatedAtMs = typeof plannedMetadata.sessionTitleUpdatedAtMs === 'number'
        ? plannedMetadata.sessionTitleUpdatedAtMs
        : 0;
      const plannedRevision = typeof plannedMetadata.sessionTitleRevision === 'number'
        ? plannedMetadata.sessionTitleRevision
        : 0;
      const plannedUpdatedByAccountId = typeof plannedMetadata.sessionTitleUpdatedByAccountId === 'string'
        ? plannedMetadata.sessionTitleUpdatedByAccountId
        : null;
      const cloudWinsPlanned = Boolean(cloudTitle)
        && incomingSessionTitleWins(
          {
            titleSource: plannedSource,
            titleRevision: plannedRevision,
            updatedAtMs: plannedUpdatedAtMs,
            updatedByAccountId: plannedUpdatedByAccountId,
          },
          cloudTitle,
        );
      if (cloudWinsPlanned || (generatedTitle && plannedSource === 'placeholder')) {
        sessionRequestsById.set(sessionId, {
          ...planned,
          title,
          metadata: {
            ...plannedMetadata,
            ...(cloudTitleMetadata ?? sessionTitleMetadata('auto', { generatedFromMessageId, updatedAtMs })),
          },
        });
      }
      return;
    }
    const existingSession = existingSessionById.get(sessionId);
    const existingMetadata = existingSession?.metadata && typeof existingSession.metadata === 'object' && !Array.isArray(existingSession.metadata)
      ? existingSession.metadata as Record<string, unknown>
      : {};
    const existingSource = titleSourceFromMetadata(existingMetadata, existingSession?.title);
    const existingUpdatedAtMs = typeof existingMetadata.sessionTitleUpdatedAtMs === 'number'
      ? existingMetadata.sessionTitleUpdatedAtMs
      : 0;
    const existingRevision = typeof existingMetadata.sessionTitleRevision === 'number'
      ? existingMetadata.sessionTitleRevision
      : 0;
    const existingUpdatedByAccountId = typeof existingMetadata.sessionTitleUpdatedByAccountId === 'string'
      ? existingMetadata.sessionTitleUpdatedByAccountId
      : null;
    const existingGeneratedFromMessageId = typeof existingMetadata.sessionTitleGeneratedFromMessageId === 'string'
      ? existingMetadata.sessionTitleGeneratedFromMessageId.trim()
      : '';
    const currentGeneratedFromMessageId = generatedFromMessageId?.trim() ?? '';
    const cloudWinsExisting = Boolean(cloudTitle)
      && incomingSessionTitleWins(
        {
          titleSource: existingSource,
          titleRevision: existingRevision,
          updatedAtMs: existingUpdatedAtMs,
          updatedByAccountId: existingUpdatedByAccountId,
        },
          cloudTitle,
        );
    const generatedFromCurrentSnapshot = Boolean(currentGeneratedFromMessageId)
      && (
        existingGeneratedFromMessageId === currentGeneratedFromMessageId
        || existingGeneratedFromMessageId === cloudSelfAgentCanonicalMessageId(currentGeneratedFromMessageId)
      );
    const cloudTitleProtectsForkTitle = cloudWinsExisting
      && cloudTitle?.titleSource !== 'auto'
      && cloudTitle?.titleSource !== 'placeholder';
    const shouldResetInheritedForkTitle = Boolean(fork)
      && isForkSnapshot
      && existingSource === 'auto'
      && (!existingGeneratedFromMessageId || generatedFromCurrentSnapshot)
      && !cloudTitleProtectsForkTitle;
    const shouldUpdateExistingTitle = cloudWinsExisting
      || shouldResetInheritedForkTitle
      || (Boolean(generatedTitle) && existingSource === 'placeholder');
    const existingFork = existingMetadata.fork && typeof existingMetadata.fork === 'object' && !Array.isArray(existingMetadata.fork)
      ? existingMetadata.fork as Record<string, unknown>
      : null;
    const existingForkAliases = Array.isArray(existingFork?.forkedFromMessageAliases)
      ? existingFork.forkedFromMessageAliases
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    const forkedFromMessageAliases = fork?.parentMessageId
      ? [...new Set([...existingForkAliases, fork.parentMessageId])]
      : existingForkAliases;
    const metadata: Record<string, unknown> = {
      ...existingMetadata,
      cloudSelfAgentSession: true,
      ...(shouldUpdateExistingTitle || !existingSession
        ? shouldResetInheritedForkTitle
          ? sessionTitleMetadata('placeholder', { updatedAtMs })
          : cloudTitleMetadata ?? sessionTitleMetadata(generatedTitle ? 'auto' : 'placeholder', { generatedFromMessageId, updatedAtMs })
        : {}),
      ...(fork
        ? {
            fork: {
              ...existingFork,
              forkedFromSessionId: fork.parentSessionId,
              ...(fork.parentMessageId ? { forkedFromMessageId: fork.parentMessageId } : {}),
              ...(forkedFromMessageAliases.length > 0 ? { forkedFromMessageAliases } : {}),
              forkMode: 'private-local',
              contextPolicy: 'prefix-through-message',
              boundary: 'inherited-history-reference-only',
            },
          }
        : {}),
    };
    if (shouldResetInheritedForkTitle) {
      delete metadata.sessionTitleGeneratedFromMessageId;
    }
    const existingHasFork = Boolean(fork)
      && existingFork?.forkedFromSessionId === fork?.parentSessionId
      && (!fork?.parentMessageId || existingFork?.forkedFromMessageId === fork.parentMessageId);
    const existingHasCompleteForkContract = existingHasFork
      && (!fork?.parentMessageId || existingForkAliases.includes(fork.parentMessageId))
      && existingFork?.forkMode === 'private-local'
      && existingFork?.contextPolicy === 'prefix-through-message'
      && existingFork?.boundary === 'inherited-history-reference-only';
    if (existingSession && (!fork || existingHasCompleteForkContract) && !shouldUpdateExistingTitle) return;
    sessionRequestsById.set(sessionId, {
      id: sessionId,
      kind: 'self-agent',
      title: shouldResetInheritedForkTitle
        ? 'New fork'
        : shouldUpdateExistingTitle
          ? title
          : cleanText(existingSession?.title) || title,
      status: 'active',
      createdByIdentityId: localHumanIdentityId,
      primaryIdentityId: agentIdentityId,
      participantIdentityIds: [agentIdentityId],
      metadata,
    });
  };

  for (const restoreMessage of normalizedMessages) {
    const { message, sessionId, role, text, createdAtMs, responseRequestId, messageAction } = restoreMessage;
    const sourceTransport = forkSnapshotCloudMessageIds.has(message.messageId)
      ? 'canonical-fork-snapshot'
      : 'cloud-self-agent';
    const existingMatch = state.messages.find((existing) => existingCanonicalMessageMatchesCloudSelfAgent(existing, {
      sessionId,
      role,
      text,
      createdAtMs,
      cloudMessageId: message.messageId,
    }));
    if (existingMatch) {
      if (!responseRequestId) {
        userTextByCloudMessageId.set(message.messageId, text);
        requestLocalMessageIdByCloudMessageId.set(message.messageId, existingMatch.id);
        ensureSessionRequest(
          sessionId,
          sourceTransport === 'canonical-fork-snapshot' ? '' : text,
          message.messageId,
          createdAtMs,
          sourceTransport === 'canonical-fork-snapshot',
        );
      } else {
        ensureSessionRequest(
          sessionId,
          sourceTransport === 'canonical-fork-snapshot'
            ? ''
            : cleanText(userTextByCloudMessageId.get(responseRequestId)) || '',
          responseRequestId,
          createdAtMs,
          sourceTransport === 'canonical-fork-snapshot',
        );
      }
      if (sourceTransport === 'canonical-fork-snapshot' && existingMatch.sourceTransport !== sourceTransport) {
        messageRequests.push({
          id: existingMatch.id,
          sessionId,
          senderIdentityId: existingMatch.senderIdentityId,
          senderRole: existingMatch.senderRole,
          messageKind: existingMatch.messageKind,
          contentText: existingMatch.contentText,
          content: existingMatch.content ?? null,
          parentMessageId: existingMatch.parentMessageId ?? null,
          status: existingMatch.status,
          createdAtMs: existingMatch.createdAtMs,
          sourceTransport,
          sourceEventId: existingMatch.sourceEventId ?? message.messageId,
        });
      }
      continue;
    }

    const duplicateKey = [sessionId, role, createdAtMs.toString(), text].join('\u001f');
    const plannedDuplicateMessageId = plannedCanonicalMessageIdByDuplicateKey.get(duplicateKey);
    if (plannedDuplicateMessageId) {
      if (!responseRequestId) {
        userTextByCloudMessageId.set(message.messageId, text);
        requestLocalMessageIdByCloudMessageId.set(message.messageId, plannedDuplicateMessageId);
      }
      continue;
    }

    const canonicalMessageId = cloudSelfAgentCanonicalMessageId(message.messageId);
    if (!responseRequestId) {
      userTextByCloudMessageId.set(message.messageId, text);
      requestLocalMessageIdByCloudMessageId.set(message.messageId, canonicalMessageId);
    }
    const quoteSourceMessageId = messageAction?.kind === 'quote'
      ? cleanText(messageAction.source.sourceMessageId)
      : null;
    const parentMessageId = responseRequestId
      ? requestLocalMessageIdByCloudMessageId.get(responseRequestId) ?? null
      : quoteSourceMessageId;
    const title = cleanText(userTextByCloudMessageId.get(responseRequestId ?? message.messageId))
      || cleanText(existingSessionById.get(sessionId)?.title)
      || '';
    ensureSessionRequest(
      sessionId,
      sourceTransport === 'canonical-fork-snapshot' ? '' : title,
      responseRequestId ?? message.messageId,
      createdAtMs,
      sourceTransport === 'canonical-fork-snapshot',
    );
    plannedCanonicalMessageIdByDuplicateKey.set(duplicateKey, canonicalMessageId);
    messageRequests.push({
      id: canonicalMessageId,
      sessionId,
      senderIdentityId: responseRequestId ? agentIdentityId : localHumanIdentityId,
      senderRole: responseRequestId ? 'owned-agent' : 'user',
      messageKind: responseRequestId ? 'agent-turn' : 'text',
      contentText: text,
      content: responseRequestId
        ? { cloudRequestMessageId: responseRequestId }
        : messageAction
          ? {
              messageAction,
              ...(quoteSourceMessageId ? { replyToMessageId: quoteSourceMessageId } : {}),
            }
          : null,
      parentMessageId,
      status: responseRequestId ? 'complete' : 'sent',
      createdAtMs,
      sourceTransport,
      sourceEventId: message.messageId,
    });
  }

  return {
    agentIdentityRequest: {
      id: agentIdentityId,
      kind: 'agent',
      displayName: 'My Kordi',
      ownerIdentityId: localHumanIdentityId,
      source: 'local',
      sourceHostId: null,
      sourceIdentityId: null,
      humanId: null,
      agentId: `cloud-self:${account.accountId}`,
      avatarKey: `cloud-self:${account.accountId}`,
      profileImageUrl: null,
      metadata: { cloudSelfAgent: true, accountId: account.accountId },
    },
    sessionRequests: [...sessionRequestsById.values()],
    messageRequests,
  };
}

function localSelfAgentSessionIds(state: CanonicalSessionState): Set<string> {
  return new Set(state.sessions
    .filter((session) => session.kind === 'self-agent' && !session.id.startsWith(CLOUD_AGENT_RUNTIME_SESSION_PREFIX))
    .map((session) => session.id));
}

function shouldSkipSelfAgentForwardSyncMessage(message: CanonicalSessionMessage): boolean {
  return message.sourceTransport === 'canonical-fork-snapshot'
    || message.sourceTransport === 'cloud-group-fork-snapshot'
    || message.sourceTransport === 'cloud-self-agent'
    || message.id.startsWith('msg:cloud:self:');
}

export function seedCloudSelfAgentForwardSyncLedger(
  state: CanonicalSessionState,
  ledger: CloudSelfAgentSyncLedger,
  syncedAtMs: number = Date.now(),
): { ledger: CloudSelfAgentSyncLedger; changed: boolean } {
  const selfAgentSessionIds = localSelfAgentSessionIds(state);
  if (selfAgentSessionIds.size === 0) return { ledger, changed: false };

  let changed = false;
  const next: CloudSelfAgentSyncLedger = { ...ledger };
  for (const message of state.messages) {
    if (!selfAgentSessionIds.has(message.sessionId) || !isTerminalSelfAgentMessage(message)) continue;
    if (shouldSkipSelfAgentForwardSyncMessage(message)) continue;
    if (!cleanText(message.contentText) || next[message.id]) continue;
    next[message.id] = {
      cloudMessageId: null,
      syncedAtMs,
      skippedLocalBackfill: true,
    };
    changed = true;
  }
  return { ledger: changed ? next : ledger, changed };
}

export function planCloudSelfAgentSync(
  state: CanonicalSessionState,
  ledger: CloudSelfAgentSyncLedger,
  options: { allowLocalBackfill?: boolean } = {},
): CloudSelfAgentSyncOperation[] {
  if (options.allowLocalBackfill === false) return [];
  const selfAgentSessionIds = localSelfAgentSessionIds(state);
  if (selfAgentSessionIds.size === 0) return [];

  const messagesBySession = new Map<string, CanonicalSessionMessage[]>();
  for (const message of state.messages) {
    if (!selfAgentSessionIds.has(message.sessionId) || !isTerminalSelfAgentMessage(message)) continue;
    if (shouldSkipSelfAgentForwardSyncMessage(message)) continue;
    const text = cleanText(message.contentText);
    if (!text) continue;
    const bucket = messagesBySession.get(message.sessionId) ?? [];
    bucket.push(message);
    messagesBySession.set(message.sessionId, bucket);
  }

  const operations: CloudSelfAgentSyncOperation[] = [];
  for (const [sessionId, messages] of messagesBySession.entries()) {
    const sorted = [...messages].sort((left, right) => (
      left.sequenceNum - right.sequenceNum
      || left.createdAtMs - right.createdAtMs
      || left.id.localeCompare(right.id)
    ));
    let lastUserMessageId: string | null = null;
    for (const message of sorted) {
      if (message.senderRole === 'user') {
        lastUserMessageId = message.id;
        if (!ledger[message.id]) {
          operations.push({
            localMessageId: message.id,
            sessionId,
            role: 'user',
            text: cleanText(message.contentText),
            parentLocalMessageId: null,
            createdAtMs: message.createdAtMs,
          });
        }
        continue;
      }
      const isAgentMessage = message.messageKind === 'agent-turn' || message.senderRole.includes('agent');
      if (!isAgentMessage || !lastUserMessageId || ledger[message.id]) continue;
      operations.push({
        localMessageId: message.id,
        sessionId,
        role: 'agent',
        text: cleanText(message.contentText),
        parentLocalMessageId: lastUserMessageId,
        createdAtMs: message.createdAtMs,
      });
    }
  }

  return operations.sort((left, right) => {
    if (left.sessionId !== right.sessionId) return left.sessionId.localeCompare(right.sessionId);
    return 0;
  });
}

async function waitForCloudAgentTurn(
  turnId: string,
  onSnapshot?: (snapshot: DesktopChatTurnSnapshot) => void,
) {
  const deadline = Date.now() + CLOUD_AGENT_TURN_TIMEOUT_MS;
  let latest = await fetchDesktopChatTurnState(turnId);
  onSnapshot?.(latest);
  while (!latest.completed && Date.now() < deadline) {
    await wait(CLOUD_AGENT_TURN_POLL_MS);
    latest = await fetchDesktopChatTurnState(turnId);
    onSnapshot?.(latest);
  }
  return latest;
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
  const cloudSessionTitleUploadsRef = useRef<Map<string, string>>(new Map());
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
  const readReceiptRequestRef = useRef<string | null>(null);
  const persistedActiveReadSignatureRef = useRef<string | null>(null);
  const processedCloudAgentMentionIdsRef = useRef<Set<string>>(new Set());
  const syncedProviderAuthSnapshotKeysRef = useRef<Set<string>>(new Set());
  const cloudAgentTurnIdsByRequestIdRef = useRef<Map<string, string>>(new Map());
  const cloudSelfAgentForkRefreshKeyRef = useRef<string | null>(null);
  const syncingSelfAgentHistoryRef = useRef(false);
  const lastCloudFocusRefreshAtRef = useRef(0);
  const cloudFocusRefreshTimerRef = useRef<number | null>(null);
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
    cloudSelfAgentForkRefreshKeyRef.current = null;
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
    cloudSessionTitleUploadsRef.current.clear();
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

  useEffect(() => {
    const sessionId = activeConversationId?.trim() ?? '';
    if (!account || !sessionId || !isSharedCloudSessionId(sessionId) || !canonicalSessionState) return;
    const latestMessages = canonicalSessionState.messages
      .filter((message) => (
        message.sessionId === sessionId
        && !['canonical-fork-snapshot', 'cloud-group-fork-snapshot'].includes(message.sourceTransport ?? '')
        && !['sending', 'processing'].includes(message.status.trim().toLowerCase())
      ))
      .sort((left, right) => left.sequenceNum - right.sequenceNum || left.createdAtMs - right.createdAtMs);
    const latestMessage = latestMessages[latestMessages.length - 1];
    if (!latestMessage) return;
    const selfParticipant = canonicalSessionState.participants.find((participant) => (
      participant.sessionId === sessionId
      && participant.role === 'self'
      && (!canonicalSessionState.profile.humanIdentityId || participant.identityId === canonicalSessionState.profile.humanIdentityId)
    )) ?? canonicalSessionState.participants.find((participant) => participant.sessionId === sessionId && participant.role === 'self');
    if (selfParticipant?.lastReadMessageId === latestMessage.id) return;

    const signature = `${account.accountId}:${sessionId}:${latestMessage.id}`;
    if (persistedActiveReadSignatureRef.current === signature) return;
    persistedActiveReadSignatureRef.current = signature;
    void markCanonicalSessionRead({ sessionId, messageId: latestMessage.id })
      .then((delta) => {
        setCanonicalSessionState?.((current) => mergeCanonicalReadCursorDelta(current, delta));
      })
      .catch(() => {
        persistedActiveReadSignatureRef.current = null;
      });
  }, [account, activeConversationId, canonicalSessionState, setCanonicalSessionState]);

  const activeCloudPinSessionId = useMemo(() => {
    const fromConversation = activeConversationId ? cloudSessionIdFromConversationId(activeConversationId) : null;
    const trimmedActive = activeConversationId?.trim() ?? '';
    return fromConversation || (trimmedActive.startsWith('session:') ? trimmedActive : null);
  }, [activeConversationId]);

  useEffect(() => {
    if (!account || !activeCloudPinSessionId) return;
    let cancelled = false;
    void loadSession()
      .then(async (session) => {
        if (!session?.token) return null;
        return client.getCloudSessionPin(session.token, activeCloudPinSessionId);
      })
      .then((pin) => {
        if (cancelled || !pin) return;
        setCloudSessionPinsById((current) => ({ ...current, [pin.sessionId]: pin }));
      })
      .catch(() => {
        // Best-effort. The cursor sync loop also applies pin updates.
      });
    return () => {
      cancelled = true;
    };
  }, [account, activeCloudPinSessionId, client]);

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

  useEffect(() => {
    if (!account || syncingSelfAgentHistoryRef.current) return;

    syncingSelfAgentHistoryRef.current = true;
    let plannedSessionIds: string[] = [];
    void (async () => {
      const latestState = canonicalSessionStateRef.current ?? canonicalSessionState ?? null;
      if (!latestState) return;
      const initialLedger = loadCloudSelfAgentSyncLedger(account.accountId);
      if (!loadCloudSelfAgentForwardBaseline(account.accountId)) {
        const seeded = seedCloudSelfAgentForwardSyncLedger(latestState, initialLedger);
        if (seeded.changed) {
          saveCloudSelfAgentSyncLedger(account.accountId, seeded.ledger);
        }
        saveCloudSelfAgentForwardBaseline(account.accountId);
        return;
      }
      const operations = planCloudSelfAgentSync(latestState, initialLedger);
      if (operations.length === 0) return;

      plannedSessionIds = [...new Set(operations.map((operation) => operation.sessionId))];
      const session = await loadSession();
      if (!session?.token) return;
      const pendingBySession = operations.reduce<Record<string, number>>((counts, operation) => {
        counts[operation.sessionId] = (counts[operation.sessionId] ?? 0) + 1;
        return counts;
      }, {});
      setCloudSelfAgentSyncStatusBySessionId((current) => {
        const next = { ...current };
        for (const [sessionId, pendingCount] of Object.entries(pendingBySession)) {
          next[sessionId] = { state: 'syncing', pendingCount, updatedAtMs: Date.now() };
        }
        return next;
      });
      const ledger = loadCloudSelfAgentSyncLedger(account.accountId);
      for (const operation of operations) {
        if (cancelledRef.current) return;
        if (ledger[operation.localMessageId]) continue;
        let body = operation.text;
        if (operation.role === 'agent') {
          const parentCloudMessageId = operation.parentLocalMessageId
            ? ledger[operation.parentLocalMessageId]?.cloudMessageId ?? null
            : null;
          if (!parentCloudMessageId) continue;
          body = encodeCloudAgentResponse({ requestId: parentCloudMessageId, text: operation.text });
        }
        const message = await client.sendMessage(session.token, account.accountId, body, {
          sessionId: operation.sessionId,
          clientCreatedAt: new Date(operation.createdAtMs).toISOString(),
        });
        if (operation.role === 'user') {
          // These are historical local-agent requests, not fresh Cloud asks.
          // Suppress the direct-agent runner so backfill does not ask My Kordi
          // to answer old prompts a second time before their historical answer
          // envelope is uploaded.
          processedCloudAgentMentionIdsRef.current.add(message.messageId);
        }
        ledger[operation.localMessageId] = {
          cloudMessageId: message.messageId,
          syncedAtMs: Date.now(),
        };
        saveCloudSelfAgentSyncLedger(account.accountId, ledger);
        pendingBySession[operation.sessionId] = Math.max(0, (pendingBySession[operation.sessionId] ?? 1) - 1);
        setCloudSelfAgentSyncStatusBySessionId((current) => ({
          ...current,
          [operation.sessionId]: pendingBySession[operation.sessionId] > 0
            ? { state: 'syncing', pendingCount: pendingBySession[operation.sessionId], updatedAtMs: Date.now() }
            : { state: 'synced', updatedAtMs: Date.now() },
        }));
        mergeMessage(message);
      }
      await syncCloudCollaborationDiff();
    })()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (plannedSessionIds.length > 0) {
          setCloudSelfAgentSyncStatusBySessionId((current) => {
            const next = { ...current };
            for (const sessionId of plannedSessionIds) {
              next[sessionId] = { state: 'error', message, updatedAtMs: Date.now() };
            }
            return next;
          });
        }
        console.warn('[cloud-self-agent-sync] failed to sync local history', error);
      })
      .finally(() => {
        syncingSelfAgentHistoryRef.current = false;
      });
  }, [account, canonicalSessionState, client, mergeMessage, syncCloudCollaborationDiff]);

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
        publishActivity: publishDerivedCloudSessionActivity,
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

  const mergeMessageRef = useRef(mergeMessage);
  const syncCloudCollaborationDiffRef = useRef(syncCloudCollaborationDiff);
  useEffect(() => { mergeMessageRef.current = mergeMessage; }, [mergeMessage]);
  useEffect(() => { syncCloudCollaborationDiffRef.current = syncCloudCollaborationDiff; }, [syncCloudCollaborationDiff]);

  const persistCloudGroupOutboxDelivery = useCallback(async (entry: CloudGroupOutboxEntry) => {
    if (entry.trackCanonicalDelivery === false) {
      await cloudGroupOutbox?.acknowledgeCanonicalDelivery(entry.canonicalMessageId);
      return;
    }
    const delivery = cloudGroupOutboxDeliveryStatus(entry);
    const delta = await updateCanonicalMessageDelivery({
      messageId: entry.canonicalMessageId,
      sessionId: entry.sessionId,
      ...delivery,
    });
    if (!delta) return;
    canonicalSessionStateRef.current = mergeCanonicalMessageDeliveryDelta(
      canonicalSessionStateRef.current,
      delta,
    );
    setCanonicalSessionState?.((current) => mergeCanonicalMessageDeliveryDelta(current, delta));
    await cloudGroupOutbox?.acknowledgeCanonicalDelivery(entry.canonicalMessageId);
  }, [cloudGroupOutbox, setCanonicalSessionState]);

  useEffect(() => {
    if (!account || !cloudGroupOutbox || !canonicalStateReady || typeof window === 'undefined') return undefined;
    let cancelled = false;
    let draining = false;
    let retryTimer: number | null = null;

    const scheduleNext = () => {
      if (cancelled) return;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      const nowMs = Date.now();
      const nextWakeAtMs = cloudGroupOutboxNextWakeAtMs(cloudGroupOutbox.entries(), nowMs);
      if (nextWakeAtMs === null) return;
      retryTimer = window.setTimeout(() => { void drain(); }, Math.max(0, nextWakeAtMs - nowMs));
    };

    const drain = async () => {
      if (cancelled || draining) return;
      draining = true;
      let sentAny = false;
      const sessionPromise = loadSession();
      try {
        const preparedEntries = new Map<string, Promise<CloudGroupOutboxEntry>>();
        const outcomes = await cloudGroupOutbox.deliverDue(async ({ recipientId, clientMessageId, entry }) => {
          const session = await sessionPromise;
          if (!session?.token) throw new Error('Not signed in.');
          let preparedEntry = preparedEntries.get(entry.canonicalMessageId);
          if (!preparedEntry) {
            preparedEntry = prepareCloudGroupOutboxEntryAttachments({
              outbox: cloudGroupOutbox,
              entry,
              upload: (attachments) => uploadComposerAttachments({
                token: session.token,
                client,
                attachments,
              }),
            });
            preparedEntries.set(entry.canonicalMessageId, preparedEntry);
          }
          const ready = await preparedEntry;
          const message = await client.sendMessage(session.token, recipientId, ready.envelope, {
            sessionId: ready.sessionId,
            attachments: ready.attachments,
            clientCreatedAt: ready.clientCreatedAt,
            clientMessageId,
          });
          sentAny = true;
          mergeMessageRef.current(message);
        });
        for (const outcome of outcomes) {
          if (outcome) await persistCloudGroupOutboxDelivery(outcome);
        }
        if (sentAny) await syncCloudCollaborationDiffRef.current?.();
      } catch (error) {
        // Keep the persisted recipients queued; focus/online/timer will resume.
        console.warn('[cloud-group-outbox] retry failed', error);
      } finally {
        draining = false;
        scheduleNext();
      }
    };

    const resume = () => { void drain(); };
    const resumeWhenVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') resume();
    };
    const unsubscribe = cloudGroupOutbox.subscribe(scheduleNext);
    void cloudGroupOutbox.restore().then(async (entries) => {
      for (const entry of entries) {
        await persistCloudGroupOutboxDelivery(entry).catch(() => {});
      }
      await drain();
    }).catch((error) => {
      console.warn('[cloud-group-outbox] restore failed', error);
    });
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resumeWhenVisible);
    return () => {
      cancelled = true;
      unsubscribe();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resumeWhenVisible);
    };
  }, [account, canonicalStateReady, client, cloudGroupOutbox, persistCloudGroupOutboxDelivery]);

  useEffect(() => {
    if (!account || typeof window === 'undefined') return undefined;
    const handleAcceptedContact = (event: Event) => {
      const detail = event instanceof CustomEvent && event.detail && typeof event.detail === 'object'
        ? event.detail as { message?: CloudMessage }
        : null;
      if (detail?.message) {
        mergeMessageRef.current(detail.message);
      }
    };
    window.addEventListener(CLOUD_CONTACT_ACCEPTED_SYNC_EVENT, handleAcceptedContact);
    return () => window.removeEventListener(CLOUD_CONTACT_ACCEPTED_SYNC_EVENT, handleAcceptedContact);
  }, [account]);

  useEffect(() => {
    if (!account) return;
    // Pin the WS lifecycle to `account` only. Earlier the deps included
    // `mergeMessage` and Cloud sync callbacks, whose
    // identities flip transitively when canonicalSessionState updates
    // (groupParticipantContacts → groupParticipantPeerIds → bootstrapPeerIds
    // → Cloud sync). Every canonical update therefore tore
    // down and reopened the WebSocket; when state churned faster than the
    // handshake (~200ms), the new socket got closed before "connected" and
    // the browser logged "WebSocket is closed before the connection is
    // established" / "network connection was lost" in a tight loop. The
    // loop in turn re-ran every cloud-side effect, including the canonical
    // command replay that throws and emits "[cloud-group] sync failed".
    if (!cloudRealtimeWebSocketEnabled()) return;
    // Hold the WS open for the lifetime of the account; route message
    // handling through refs so we always call the latest callbacks without
    // re-binding the socket.
    let ws: WebSocket | null = null;
    let cancelled = false;
    const accountIdAtOpen = account.accountId;
    const open = async () => {
      const session = await loadSession();
      if (!session?.token || cancelled) return;
      ws = new WebSocket(cloudWebSocketUrl(session.token));
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
          const subject: string | undefined = frame?.subject;
          if (subject?.startsWith('kordi.events.message.read.')) {
            void syncCloudCollaborationDiffRef.current?.();
            return;
          }
          if (!subject?.startsWith('kordi.events.message.arrived.')) return;
          const payload = frame?.payload;
          if (!payload || typeof payload !== 'object') return;
          const from = payload.from_account_id as string | undefined;
          const to = payload.to_account_id as string | undefined;
          if (!from || !to) return;
          mergeMessageRef.current({
            messageId: payload.message_id,
            fromAccountId: from,
            toAccountId: to,
            body: payload.body,
            createdAt: payload.created_at,
            deliveredAt: payload.delivered_at ?? payload.created_at ?? null,
            readAt: payload.read_at ?? null,
            direction: to === accountIdAtOpen ? 'incoming' : 'outgoing',
            sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
          });
          void syncCloudCollaborationDiffRef.current?.();
        } catch (error) {
          console.warn('[cloud-collaboration-ws] frame parse failed', error);
        }
      };
    };
    void open();
    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [account]);

  useEffect(() => {
    if (!account || !setCanonicalSessionState) return;
    if (cloudMessageIndex.deliveryByMessageId.size === 0) return;
    setCanonicalSessionState((current) => patchCanonicalDeliverySummaries(
      current,
      cloudMessageIndex.deliveryByMessageId,
    ));
  }, [account, cloudMessageIndex, setCanonicalSessionState]);

  useEffect(() => {
    if (
      !account
      || !canonicalSessionState
      || !setCanonicalSessionState
      || !authoritativeMessagesReady
      || !cloudUnreadContextKey
    ) return;
    const activeConversationIds = [
      activeConversationId,
      activeConversationId ? cloudSessionIdFromConversationId(activeConversationId) : null,
    ];
    const unreadBySessionId = cloudGroupUnreadCountsBySessionId({
      accountId: account.accountId,
      activeConversationIds,
      readCursorsBySessionId: cloudGroupReadCursorsBySessionId(canonicalSessionState),
      groupRows: cloudMessageIndex.groupRows,
    });
    setCanonicalSessionState((current) => {
      if (!current) return current;
      let changed = false;
      const sessions = current.sessions.map((session) => {
        const metadata = objectContent(session.metadata);
        const existingUnread = typeof metadata.cloudUnreadCount === 'number' && Number.isFinite(metadata.cloudUnreadCount)
          ? Math.max(0, Math.floor(metadata.cloudUnreadCount))
          : 0;
        const nextUnread = unreadBySessionId[session.id] ?? 0;
        if (existingUnread === nextUnread) return session;
        changed = true;
        if (nextUnread > 0) {
          return {
            ...session,
            metadata: {
              ...metadata,
              cloudUnreadCount: nextUnread,
            },
          };
        }
        const restMetadata = { ...metadata };
        delete restMetadata.cloudUnreadCount;
        return {
          ...session,
          metadata: restMetadata,
        };
      });
      return changed ? { ...current, sessions } : current;
    });
    setPublishedCloudUnreadContextKey((current) => (
      current === cloudUnreadContextKey ? current : cloudUnreadContextKey
    ));
  }, [
    account,
    activeConversationId,
    authoritativeMessagesReady,
    canonicalSessionState,
    cloudMessageIndex,
    cloudUnreadContextKey,
    setCanonicalSessionState,
  ]);

  useEffect(() => {
    if (!account || !canonicalSessionState?.profile.humanIdentityId || !setCanonicalSessionState || !initialMessagesSettled) return;
    void cloudGroupReplayCoordinator.request({
      entries: cloudMessageIndex.replayRows.map((row) => ({
        key: cloudGroupReplayKeyForRow(row),
        row,
      })),
      apply: async (row) => {
        await applyCloudGroupControl(row.wire, row.envelope);
      },
      onFailure: ({ attempt, retryDelayMs, error }) => {
        const failure = error instanceof Error ? error.message : String(error);
        console.warn('[cloud-group] sync failed; retry scheduled', { attempt, retryDelayMs, failure }, error);
      },
    });
  }, [
    account,
    applyCloudGroupControl,
    canonicalSessionState?.profile.humanIdentityId,
    cloudGroupReplayCoordinator,
    cloudMessageIndex,
    initialMessagesSettled,
    setCanonicalSessionState,
  ]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const syncKey = cloudProviderAuthSnapshotRouteSignature(account.accountId, defaultCloudAgentRuntimeRoute);
    if (!syncKey || syncedProviderAuthSnapshotKeysRef.current.has(syncKey)) return;
    syncedProviderAuthSnapshotKeysRef.current.add(syncKey);
    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (!session?.token || cancelled) return;
      const input = await buildDesktopCloudProviderAuthSnapshotPayload({
        provider: defaultCloudAgentRuntimeRoute?.authProvider ?? null,
        authChoice: defaultCloudAgentRuntimeRoute?.authChoice ?? null,
        model: defaultCloudAgentRuntimeRoute?.model ?? null,
      });
      if (!input || cancelled) return;
      await client.publishProviderAuthSnapshot(session.token, input);
    })().catch((error) => {
      syncedProviderAuthSnapshotKeysRef.current.delete(syncKey);
      console.warn('[cloud-provider-auth-sync] publish failed', error);
    });
    return () => {
      cancelled = true;
    };
  }, [account, client, defaultCloudAgentRuntimeRoute, initialMessagesSettled]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    for (const message of cloudMessageIndex.allMessages) {
      if (message.fromAccountId !== account.accountId && message.toAccountId !== account.accountId) continue;
      const cancel = parseCloudAgentCancel(message.body);
      if (!cancel) continue;
      processedCloudAgentMentionIdsRef.current.add(cancel.requestId);
      const turnId = cloudAgentTurnIdsByRequestIdRef.current.get(cancel.requestId);
      if (turnId) {
        void cancelDesktopChatTurn(turnId)
          .catch((error) => {
            console.warn('[cloud-agent-mention] local agent cancel failed', error);
          })
          .finally(() => {
            cloudAgentTurnIdsByRequestIdRef.current.delete(cancel.requestId);
          });
      }
      const currentCanonicalState = canonicalSessionStateRef.current;
      if (!currentCanonicalState || !setCanonicalSessionState) continue;
      const processingMessage = currentCanonicalState.messages
        .map((candidate) => cloudGroupAgentProcessingMessageForRequest([candidate], candidate.sessionId, cancel.requestId))
        .find((candidate): candidate is CanonicalSessionMessage => Boolean(candidate));
      if (!processingMessage) continue;
      if (currentCanonicalState.messages.some((candidate) => {
        const content = objectContent(candidate.content);
        return candidate.status === 'cancelled'
          && candidate.sourceTransport === 'cloud-group-agent'
          && cleanText(typeof content.requestId === 'string' ? content.requestId : null) === cancel.requestId;
      })) continue;
      const cancelCreatedAtMs = Date.parse(message.createdAt);
      const cancelDeliveredAtMs = Date.parse(message.deliveredAt ?? '');
      const cancelNoticeRequest = cloudGroupAgentCancelledNoticeRequest({
        processingMessage,
        requestId: cancel.requestId,
        conversationId: cloudGroupAgentConversationId(processingMessage.sessionId),
        cancelledByAccountId: message.fromAccountId,
        cancelledByRole: cloudGroupAgentCancelRoleForRequest({
          state: currentCanonicalState,
          requestId: cancel.requestId,
          processingMessage,
          cancelledByAccountId: message.fromAccountId,
        }),
        now: Number.isFinite(cancelCreatedAtMs)
          ? cancelCreatedAtMs
          : Number.isFinite(cancelDeliveredAtMs)
            ? cancelDeliveredAtMs
            : undefined,
      });
      setCanonicalSessionState((current) => {
        const nextState = upsertCanonicalRequestIntoLocalState(current, cancelNoticeRequest);
        if (!nextState) return nextState;
        const collapsedState = collapseCloudAgentOfflinePlaceholderForRequest(
          nextState,
          processingMessage,
          cancel.requestId,
        );
        canonicalSessionStateRef.current = collapsedState;
        return collapsedState;
      });
      void upsertCanonicalMessageFast(cancelNoticeRequest)
        .catch((error) => {
          console.warn('[cloud-agent-mention] group cancel notice failed', error);
        });
    }

    for (const [peerId, messages] of cloudMessageIndex.byPeerId) {
      for (const message of messages) {
        if (!shouldRunLocalCloudAgentForCloudMessage({
          account,
          isGroupControl: cloudMessageIndex.groupRowByWireMessageId.has(message.messageId),
          peerId,
          message,
          peerMessages: messages,
        })) continue;
        if (processedCloudAgentMentionIdsRef.current.has(message.messageId)) continue;

        processedCloudAgentMentionIdsRef.current.add(message.messageId);
        const contact = cloudLookupContacts.find((candidate) => (
          candidate.sourceParticipantId || candidate.id.replace(/^cloud:/, '')
        ) === peerId);
        const peerHumanName = contact?.name?.trim() || contact?.owner?.trim() || peerId;
        const activitySessionId = message.sessionId ?? cloudSessionIdForCollaborationSend(account.accountId, peerId, `cloud:${peerId}`);
        const targetCloudAgentId = cloudDirectMessageTargetCloudAgentId(message.body);
        const directDisplayMessage = { ...message, body: cloudDirectMessageDisplayText(message.body) };
        const prompt = promptTextForCloudAgentMention(directDisplayMessage.body);
        const contextMessages = [
          ...cloudAgentContextMessagesFromDefinition(cloudAgentDefinitionsById[targetCloudAgentId ?? ''] ?? null),
          ...cloudAgentNativeContextMessagesFromDirectCloudSession({
            messages,
            requestMessage: message,
            localAccountId: account.accountId,
            localHumanName: account.displayName || account.primaryEmail || 'Me',
            peerHumanName,
            localAgentName: 'My Kordi',
            peerAgentName: `${peerHumanName}'s Kordi`,
          }),
        ];
        const visibleTaskRecords = activitySessionId
          ? cloudVisibleTaskRecordsForSession(cloudSessionActivityRef.current, activitySessionId)
          : [];
        const runtimeSessionId = `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${account.accountId}:${peerId}`;
        const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
          setLocalAgentTurnsByRequestId((current) => ({ ...current, [message.messageId]: turn }));
        };
        void (async () => {
          let session: Awaited<ReturnType<typeof loadSession>>;
          try {
            session = await loadSession();
          } catch (error) {
            rememberLocalTurn(cloudAgentFailedTurnSnapshot({
              requestId: message.messageId,
              sessionId: runtimeSessionId,
              prompt,
              error,
            }));
            console.warn('[cloud-agent-mention] local session unavailable', error);
            return;
          }
          if (!session?.token) {
            rememberLocalTurn(cloudAgentFailedTurnSnapshot({
              requestId: message.messageId,
              sessionId: runtimeSessionId,
              prompt,
              error: new Error('Not signed in.'),
            }));
            return;
          }

          // Start these remote guards without awaiting them. Local provider
          // readiness and execution must not sit behind Cloud latency; the
          // guards only decide whether the completed response still needs to
          // be published.
          const responseGuardPromise = cloudAgentResponsePublicationIsBlocked({
            client,
            token: session.token,
            peerId,
            fallbackMessages: messages,
            account,
            requestMessageId: message.messageId,
          });

          let finalTurn: DesktopChatTurnSnapshot;
          try {
            const agentAttachments = message.attachments?.length
              ? await resolveCloudMessageAttachments({ token: session.token, client, attachments: message.attachments })
              : message.attachments ?? [];
            const agentAttachmentPaths = agentAttachments
              .map((attachment) => attachment.localPath?.trim() || '')
              .filter(Boolean);
            const startedTurn = await startDesktopChatMessage(
              runtimeSessionId,
              prompt,
              agentAttachmentPaths,
              cloudAgentRuntimeRouteForTargetCloudAgent({
                targetCloudAgentId,
                cloudAgentDefinitionsById,
                routesByRuntimeSessionId: cloudAgentRuntimeRoutesBySessionId,
                runtimeSessionId,
                fallbackRoute: defaultCloudAgentRuntimeRoute,
              }),
              contextMessages,
              visibleTaskRecords,
              activitySessionId,
            );
            rememberLocalTurn(startedTurn);
            cloudAgentTurnIdsByRequestIdRef.current.set(message.messageId, startedTurn.id);
            finalTurn = startedTurn.completed
              ? startedTurn
              : await waitForCloudAgentTurn(startedTurn.id, rememberLocalTurn);
            rememberLocalTurn(finalTurn);
          } catch (error) {
            finalTurn = cloudAgentFailedTurnSnapshot({
              requestId: message.messageId,
              sessionId: runtimeSessionId,
              prompt,
              error,
            });
            rememberLocalTurn(finalTurn);
            console.warn('[cloud-agent-mention] local agent response failed', error);
          } finally {
            cloudAgentTurnIdsByRequestIdRef.current.delete(message.messageId);
          }

          if (finalTurn.status === 'cancelled') {
            void syncCloudCollaborationDiff();
            return;
          }

          try {
            const [initialResponseBlocked, finalResponseBlocked] = await Promise.all([
              responseGuardPromise,
              cloudAgentResponsePublicationIsBlocked({
                client,
                token: session.token,
                peerId,
                fallbackMessages: messages,
                account,
                requestMessageId: message.messageId,
              }),
            ] as const);
            if (initialResponseBlocked || finalResponseBlocked) {
              void syncCloudCollaborationDiff();
              return;
            }
            if (activitySessionId) {
              await publishDerivedCloudSessionActivity({
                client,
                token: session.token,
                accountId: account.accountId,
                sessionId: activitySessionId,
                participantAccountIds: [peerId],
                participantProfiles: [
                  {
                    accountId: account.accountId,
                    displayName: account.displayName || account.primaryEmail || account.accountId,
                    avatarUrl: account.avatarUrl,
                    role: 'self',
                  },
                  {
                    accountId: peerId,
                    displayName: peerHumanName,
                    avatarUrl: contact?.profileImageUrl ?? null,
                    role: 'person',
                  },
                ],
                turn: finalTurn,
                mergeActivity: (snapshot) => setCloudSessionActivity((current) => mergeCloudSessionActivity(current, snapshot)),
              });
            }
            const responseSucceeded = finalTurn.succeeded && finalTurn.assistantText.trim().length > 0;
            const responseText = responseSucceeded
              ? finalTurn.assistantText.trim()
              : isCloudAgentNoProviderConfiguredError(finalTurn.error || finalTurn.message)
                ? cloudAgentNoProviderNoticeText()
                : `Failed: ${finalTurn.error || finalTurn.message || 'Cloud agent returned no text response'}`;
            const response = await client.sendMessage(
              session.token,
              peerId,
              encodeCloudAgentResponse({
                requestId: message.messageId,
                text: responseText,
                deliveryState: responseSucceeded ? 'complete' : 'failed',
              }),
              { sessionId: message.sessionId ?? null },
            );
            mergeMessage(response);
            void syncCloudCollaborationDiff();
          } catch (error) {
            // The local turn is already terminal and visible. A Cloud publish
            // failure must not rerun the model or return the UI to Processing.
            console.warn('[cloud-agent-mention] response publish failed', error);
          }
        })();
      }
    }
  }, [account, client, cloudAgentRuntimeRoutesBySessionId, cloudLookupContacts, cloudMessageIndex, defaultCloudAgentRuntimeRoute, initialMessagesSettled, mergeMessage, setCanonicalSessionState, syncCloudCollaborationDiff]);

  useEffect(() => {
    if (!account || !activeConversationId) return;
    const activeConversationIds = [
      activeConversationId,
      activeConversationId ? cloudSessionIdFromConversationId(activeConversationId) : null,
    ];
    const cloudGroupReadTargets = cloudGroupMessageReadTargets({
      accountId: account.accountId,
      activeConversationId,
      activeConversationIds,
      groupRows: cloudMessageIndex.groupRows,
    });
    if (cloudGroupReadTargets.peerIds.length > 0 || cloudGroupReadTargets.sessionIds.length > 0) {
      setMessagesByPeer((current) => markCloudMessagesReadLocally(current, account.accountId, {
        ...cloudGroupReadTargets,
        groupRowByWireMessageId: cloudMessageIndex.groupRowByWireMessageId,
      }));

      const canonicalReadSessionIds = [...new Set(activeConversationIds.filter((sessionId): sessionId is string => (
        typeof sessionId === 'string' && isSharedCloudSessionId(sessionId)
      )))];
      if (canonicalReadSessionIds.length > 0) {
        void Promise.all(canonicalReadSessionIds.map((sessionId) => markCanonicalSessionRead({ sessionId })))
          .then((deltas) => {
            setCanonicalSessionState?.((current) => deltas.reduce(
              (next, delta) => mergeCanonicalReadCursorDelta(next, delta),
              current,
            ));
          })
          .catch(() => {});
      }

      void loadSession()
        .then((session) => {
          if (!session?.token) return null;
          const readRequests = cloudGroupReadTargets.sessionIds.length > 0
            ? cloudGroupReadTargets.sessionIds.map((sessionId) => client.markSessionMessagesRead(session.token, sessionId))
            : cloudGroupReadTargets.peerIds.map((peerId) => client.markMessagesRead(session.token, peerId));
          return Promise.all(readRequests);
        })
        .then((result) => {
          if (result === null) return;
          void syncCloudCollaborationDiff();
        })
        .catch(() => {});
    }

    const peerId = cloudPeerAccountIdFromConversationId(activeConversationId);
    if (!peerId) return;
    const inboundIds = (messagesByPeer[peerId] ?? [])
      .filter((message) => message.toAccountId === account.accountId)
      .map((message) => message.messageId)
      .filter(Boolean);
    if (inboundIds.length === 0) return;
    setReadInboundMessageIdsByPeer((current) => {
      const existing = current[peerId] ?? new Set<string>();
      const next = new Set(existing);
      for (const id of inboundIds) next.add(id);
      if (next.size === existing.size) return current;
      return { ...current, [peerId]: next };
    });
    const readSignature = `${peerId}:${inboundIds.slice().sort().join(',')}`;
    if (readReceiptRequestRef.current === readSignature) return;
    readReceiptRequestRef.current = readSignature;
    void loadSession()
      .then((session) => {
        if (!session?.token) return null;
        return client.markMessagesRead(session.token, peerId);
      })
      .then((result) => {
        if (result === null) return;
        setMessagesByPeer((current) => markCloudMessagesReadLocally(current, account.accountId, { peerIds: [peerId] }));
        void syncCloudCollaborationDiff();
      })
      .catch(() => {
        readReceiptRequestRef.current = null;
      });
  }, [account, activeConversationId, client, cloudMessageIndex, messagesByPeer, setCanonicalSessionState, syncCloudCollaborationDiff]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const selfSessionIds = [...new Set(
      (messagesByPeer[account.accountId] ?? [])
        .map((message) => cleanText(message.sessionId))
        .filter(Boolean),
    )].sort();
    if (selfSessionIds.length === 0) return;
    const refreshKey = `${account.accountId}:${selfSessionIds.join('|')}`;
    if (cloudSelfAgentForkRefreshKeyRef.current === refreshKey) return;
    cloudSelfAgentForkRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (!session?.token) return;
      const results = await Promise.allSettled(
        selfSessionIds.map((sessionId) => client.listSessionForks(session.token, sessionId)),
      );
      const forks = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
      if (cancelled || forks.length === 0) return;
      setCloudSessionForksById((current) => {
        let changed = false;
        const next = { ...current };
        for (const fork of forks) {
          const existing = next[fork.forkSessionId];
          if (
            existing?.parentSessionId === fork.parentSessionId
            && existing?.parentMessageId === fork.parentMessageId
            && existing?.createdAt === fork.createdAt
          ) {
            continue;
          }
          next[fork.forkSessionId] = fork;
          changed = true;
        }
        return changed ? next : current;
      });
    })().catch((error) => {
      console.warn('[cloud-self-agent-sync] failed to refresh cloud fork lineage', error);
    });
    return () => {
      cancelled = true;
    };
  }, [account, client, initialMessagesSettled, messagesByPeer]);

  useEffect(() => {
    if (!account || !canonicalSessionState || !setCanonicalSessionState || !initialMessagesSettled) return;
    const selfMessages = messagesByPeer[account.accountId] ?? [];
    if (selfMessages.length === 0) return;
    const plan = planCloudSelfAgentCanonicalSync({
      account,
      messages: selfMessages,
      state: canonicalSessionState,
      forksBySessionId: cloudSessionForksById,
      groupRowByWireMessageId: cloudMessageIndex.groupRowByWireMessageId,
      cloudTitlesBySessionId: cloudSessionTitlesById,
    });
    if (plan.sessionRequests.length === 0 && plan.messageRequests.length === 0) return;
    let cancelled = false;
    void (async () => {
      let nextState: CanonicalSessionState | null = canonicalSessionState;
      const agentIdentity = await upsertCanonicalIdentityFast(plan.agentIdentityRequest);
      nextState = upsertCanonicalIdentityIntoLocalState(nextState, agentIdentity);
      for (const sessionRequest of plan.sessionRequests) {
        if (cancelled) return;
        const openResult = await openOrCreateCanonicalSessionFast(sessionRequest);
        nextState = mergeOpenCanonicalSessionFastResultIntoLocalState(nextState, openResult);
      }
      for (const messageRequest of plan.messageRequests) {
        if (cancelled) return;
        const persistedMessage = await upsertCanonicalMessageFast(messageRequest);
        nextState = mergeCanonicalMessageRow(nextState, persistedMessage);
      }
      if (!cancelled) setCanonicalSessionState(nextState);
    })().catch((error) => {
      console.warn('[cloud-self-agent-sync] failed to materialize cloud session locally', error);
    });
    return () => {
      cancelled = true;
    };
  }, [account, canonicalSessionState, cloudMessageIndex, cloudSessionForksById, cloudSessionTitlesById, initialMessagesSettled, messagesByPeer, setCanonicalSessionState]);

  useEffect(() => {
    if (!account || !canonicalSessionState || !initialMessagesSettled) return;
    const cloudBackedSessionIds = new Set(
      (messagesByPeer[account.accountId] ?? [])
        .map((message) => cleanText(message.sessionId))
        .filter(Boolean),
    );
    if (cloudBackedSessionIds.size === 0) return;

    const uploads = canonicalSessionState.sessions.flatMap((canonicalSession) => {
      if (!cloudBackedSessionIds.has(canonicalSession.id)) return [];
      if (!['self-agent', 'project'].includes(canonicalSession.kind)) return [];
      if (canonicalSession.id.startsWith(CLOUD_AGENT_RUNTIME_SESSION_PREFIX)) return [];
      const metadata = canonicalSession.metadata && typeof canonicalSession.metadata === 'object' && !Array.isArray(canonicalSession.metadata)
        ? canonicalSession.metadata as Record<string, unknown>
        : {};
      const titleSource = titleSourceFromMetadata(metadata, canonicalSession.title);
      if (titleSource === 'placeholder' || isGenericSessionTitle(canonicalSession.title)) return [];
      const titleRevisionValue = typeof metadata.sessionTitleRevision === 'number'
        ? metadata.sessionTitleRevision
        : 1;
      const titleRevision = titleSource === 'auto'
        ? Math.max(1, Math.min(2, Math.floor(titleRevisionValue)))
        : Math.max(1, Math.floor(titleRevisionValue));
      const titlePolicyVersion = typeof metadata.sessionTitlePolicyVersion === 'number'
        ? Math.max(1, Math.floor(metadata.sessionTitlePolicyVersion))
        : 1;
      const updatedAtMs = typeof metadata.sessionTitleUpdatedAtMs === 'number'
        ? metadata.sessionTitleUpdatedAtMs
        : canonicalSession.updatedAtMs;
      const titleGeneratedFromMessageId = typeof metadata.sessionTitleGeneratedFromMessageId === 'string'
        ? metadata.sessionTitleGeneratedFromMessageId.trim() || null
        : null;
      const updatedByAccountId = typeof metadata.sessionTitleUpdatedByAccountId === 'string'
        ? metadata.sessionTitleUpdatedByAccountId.trim() || null
        : null;
      const remote = cloudSessionTitlesById[canonicalSession.id];
      if (remote) {
        const remoteWins = incomingSessionTitleWins(
          { titleSource, titleRevision, updatedAtMs, updatedByAccountId },
          remote,
        );
        const identical = remote.title === canonicalSession.title
          && remote.titleSource === titleSource
          && remote.titleRevision === titleRevision
          && remote.titlePolicyVersion === titlePolicyVersion
          && remote.titleGeneratedFromMessageId === titleGeneratedFromMessageId;
        if (identical || remoteWins) return [];
      }
      const input = {
        title: canonicalSession.title.trim(),
        titleSource,
        titleRevision,
        titlePolicyVersion,
        titleGeneratedFromMessageId,
        updatedAtMs,
      };
      const signature = JSON.stringify(input);
      if (cloudSessionTitleUploadsRef.current.get(canonicalSession.id) === signature) return [];
      return [{ sessionId: canonicalSession.id, input, signature }];
    });
    if (uploads.length === 0) return;

    let cancelled = false;
    for (const upload of uploads) {
      cloudSessionTitleUploadsRef.current.set(upload.sessionId, upload.signature);
    }
    void (async () => {
      const authSession = await loadSession();
      if (!authSession?.token) {
        for (const upload of uploads) cloudSessionTitleUploadsRef.current.delete(upload.sessionId);
        return;
      }
      const results = await Promise.allSettled(uploads.map(async (upload) => ({
        upload,
        sessionTitle: await client.updateCloudSessionTitle(authSession.token, upload.sessionId, upload.input),
      })));
      if (cancelled) return;
      setCloudSessionTitlesById((current) => {
        let next = current;
        for (const [index, result] of results.entries()) {
          if (result.status === 'fulfilled') {
            next = {
              ...next,
              [result.value.sessionTitle.sessionId]: result.value.sessionTitle,
            };
          } else {
            const failedUpload = uploads[index];
            if (failedUpload) cloudSessionTitleUploadsRef.current.delete(failedUpload.sessionId);
          }
        }
        return next;
      });
    })().catch(() => {
      for (const upload of uploads) cloudSessionTitleUploadsRef.current.delete(upload.sessionId);
    });
    return () => {
      cancelled = true;
      for (const upload of uploads) {
        if (cloudSessionTitleUploadsRef.current.get(upload.sessionId) === upload.signature) {
          cloudSessionTitleUploadsRef.current.delete(upload.sessionId);
        }
      }
    };
  }, [account, canonicalSessionState, client, cloudSessionTitlesById, initialMessagesSettled, messagesByPeer]);

  useEffect(() => {
    if (!account) return;
    const runRefresh = () => {
      cloudFocusRefreshTimerRef.current = null;
      const now = Date.now();
      if (!shouldRunCloudFocusRefresh(now, lastCloudFocusRefreshAtRef.current)) return;
      lastCloudFocusRefreshAtRef.current = now;
      void syncCloudCollaborationDiff();
    };
    const refresh = () => {
      if (cloudFocusRefreshTimerRef.current !== null) window.clearTimeout(cloudFocusRefreshTimerRef.current);
      cloudFocusRefreshTimerRef.current = window.setTimeout(runRefresh, CLOUD_FOCUS_REFRESH_DELAY_MS);
    };
    const refreshWhenVisible = () => {
      if (typeof document === 'undefined' || shouldRefreshCloudForVisibility(document.visibilityState)) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      if (cloudFocusRefreshTimerRef.current !== null) {
        window.clearTimeout(cloudFocusRefreshTimerRef.current);
        cloudFocusRefreshTimerRef.current = null;
      }
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [account, syncCloudCollaborationDiff]);

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
    void syncCloudCollaborationDiffRef.current?.();
    return pin;
  }, [account, client]);

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
