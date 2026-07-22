import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { cloudAgentContextMessagesFromDefinition } from '@/features/chat/chatCreateFlows';
import { resolveReplicatedGroupTitle } from '@/features/chat/groupTitle';
import {
  deriveSessionTitle,
  incomingSessionTitleWins,
  isGenericSessionTitle,
  sessionTitleMetadata,
  titleSourceFromMetadata,
} from '@/features/chat/sessionTitlePolicy';

import {
  adoptCloudProfileIdentity,
  appendCanonicalMessage,
  buildDesktopCloudProviderAuthSnapshotPayload,
  cancelDesktopChatTurn,
  fetchDesktopChatTurnState,
  markCanonicalSessionRead,
  openOrCreateCanonicalSession,
  openOrCreateCanonicalSessionFast,
  removeCanonicalSessionParticipant,
  startDesktopChatMessage,
  upsertCanonicalIdentity,
  upsertCanonicalIdentityFast,
  upsertCanonicalMessage,
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
  DesktopBridgeSessionParticipant,
  DesktopBridgeState,
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
  type CloudAgentRun,
  type CloudAgentRunClaimInput,
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
  buildCloudDesktopBridgeState,
  cloudContactsToCanonicalIdentityRequests,
  cloudDirectPersonSessionId,
  cloudGroupParticipantContacts,
  cloudMessageMentionsContactAgent,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdForBridgeSend,
  cloudSessionIdFromConversationId,
  isCloudBridgeHostId,
} from './cloudBridgeState';
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
  cloudGroupAdminAccountIds,
  cloudGroupAgentMentionResponseState,
  cloudGroupAgentRequestingNoticeMessage,
  cloudGroupAgentRequestingNoticeRequest,
  cloudGroupForkPayloadFromSessionMetadata,
  cloudGroupAgentResponseTargetAccountIds,
  cloudGroupIdFromAgentConversationId,
  cloudGroupIdentityRequest,
  cloudGroupLocalAgentRequestAlreadyHandled,
  cloudGroupManualSessionTitleSnapshot,
  cloudGroupMemberJoinNoticeRequests,
  cloudGroupMessageReadTargets,
  cloudGroupOutgoingParticipantSnapshot,
  cloudGroupParticipantsForBridgeSessionParticipants,
  cloudGroupPeerIdsFromContactsAndRequests,
  cloudGroupPeerIdsFromMessages,
  cloudGroupParticipantsWithProfiles,
  cloudGroupSelfParticipant,
  cloudGroupSessionTitleSnapshotForControl,
  cloudGroupTitleForOutgoingControl,
  cloudGroupTitleUpdateNoticeRequest,
  cloudGroupUnreadCountsBySessionId,
  type CloudGroupReadCursor,
  cloudSessionTitleUpdateNoticeRequest,
  cloudSessionTitleUpdateTitle,
  cloudGroupUniqueParticipants,
  cloudGroupRelatedControlsForSend,
  encodeCloudGroupControl,
  firstCloudGroupSendFailure,
  firstRequiredCloudGroupSendFailure,
  fulfilledCloudGroupSends,
  parseCloudGroupControl,
  requiredCloudGroupControlTargetAccountIds,
  shouldApplyCloudGroupTitleUpdate,
  shouldCountCloudGroupMessageUnread,
  type CloudGroupControlEnvelope,
  type CloudGroupMemberJoin,
  type CloudGroupMemberLeave,
  type CloudGroupParticipant,
  type CloudGroupSessionTitleSnapshot,
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
  cloudDirectMessageTargetCloudAgentOwnerAccountId,
  cloudDirectMessageTargetsOwnedHostedCloudAgent,
} from './cloudDirectMessages';
import { cloudMessageActionAllowsAgentContext, cloudMessageActionAllowsAgentTrigger } from './cloudAgentTriggerPolicy';
import {
  uploadComposerAttachments,
  cloudMessageAttachmentToMessageAttachment,
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
  mergeCloudMessageMonotonicState,
  removeCloudSessionMessages,
  saveCloudSessionVisibility,
  syncCloudDiffOnce,
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
import { CLOUD_CONTACT_ACCEPTED_SYNC_EVENT, CLOUD_HOST_SENTINEL, useCloudContacts } from './useCloudContacts';

export const CLOUD_AGENT_MENTION_WINDOW_MS = 10 * 60_000;
export const CLOUD_AGENT_TURN_POLL_MS = 500;
export const CLOUD_AGENT_TURN_TIMEOUT_MS = 10 * 60_000;
export const CLOUD_MESSAGES_REFRESH_MS = 500;
export const CLOUD_GROUP_AGENT_STATUS_RECHECK_MS = 5_000;
export const CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS = 2 * 60_000;

const CLOUD_MESSAGE_SNAPSHOT_LIMIT = 500;

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

export type CloudUnreadReadinessStatus = 'pending' | 'ready' | 'error';

export type CloudUnreadReadinessSnapshot = {
  status: CloudUnreadReadinessStatus;
  contextKey: string | null;
};

type PendingCloudSyncRequest = {
  mode: 'diff' | 'full' | 'bootstrap';
  settleInitialMessages: boolean;
};

export function cloudBootstrapPeerIds(
  account: CloudAccount | null | undefined,
  contactPeerIds: string[],
  groupParticipantPeerIds: string[],
  requests: Parameters<typeof cloudGroupPeerIdsFromContactsAndRequests>[0]['requests'] = [],
): string[] {
  const messagePeerIds = [...new Set([...contactPeerIds, ...groupParticipantPeerIds])];
  if (!account) return messagePeerIds;
  const selfPeerId = account.accountId.trim();
  const expandedPeerIds = cloudGroupPeerIdsFromContactsAndRequests({
    accountId: account.accountId,
    contactPeerIds: messagePeerIds,
    requests,
  });
  return [...new Set([selfPeerId, ...expandedPeerIds].filter(Boolean))].sort();
}

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export function resolveCloudGroupAdminSnapshot(input: {
  envelope: Pick<CloudGroupControlEnvelope, 'kind' | 'actor' | 'participants' | 'createdByAccountId'>;
  identityIdByAccount: ReadonlyMap<string, string>;
  createdByIdentityId: string;
  existingAdminIdentityIds: string[];
  hasExistingSession: boolean;
  controlCreatedAtMs: number;
  storedAdminUpdatedAtMs: number;
}) {
  const actorIdentityId = input.identityIdByAccount.get(input.envelope.actor.accountId) ?? '';
  const actorCanChangeAdmins = !input.hasExistingSession
    ? input.envelope.kind === 'group-invite'
      && actorIdentityId === input.createdByIdentityId
    : actorIdentityId === input.createdByIdentityId;
  const applies = ['group-invite', 'group-update'].includes(input.envelope.kind)
    && actorCanChangeAdmins
    && input.controlCreatedAtMs >= input.storedAdminUpdatedAtMs;
  const advertisedAdminIdentityIds = cloudGroupAdminAccountIds(input.envelope)
    .map((accountId) => input.identityIdByAccount.get(accountId) ?? '')
    .filter(Boolean);
  return {
    applies,
    adminIdentityIds: [...new Set([
      input.createdByIdentityId,
      ...(applies ? advertisedAdminIdentityIds : input.existingAdminIdentityIds),
    ].filter(Boolean))],
  };
}

export function resolveAuthorizedCloudGroupSessionTitleSnapshot(input: {
  envelope: Pick<CloudGroupControlEnvelope, 'kind' | 'groupTitle' | 'actor' | 'sessionTitle'>;
  controlCreatedAtMs: number;
  identityIdByAccount: ReadonlyMap<string, string>;
  adminIdentityIds: readonly string[];
}): CloudGroupSessionTitleSnapshot | null {
  const snapshot = cloudGroupSessionTitleSnapshotForControl(
    input.envelope,
    input.controlCreatedAtMs,
  );
  if (!snapshot) return null;
  const updatedByIdentityId = input.identityIdByAccount.get(snapshot.updatedByAccountId)?.trim() ?? '';
  if (!updatedByIdentityId) return null;
  const adminIdentityIds = new Set(input.adminIdentityIds.map((identityId) => identityId.trim()).filter(Boolean));
  return adminIdentityIds.has(updatedByIdentityId) ? snapshot : null;
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
    // eslint-disable-next-line no-console
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
      bridgeConversationId: conversationId,
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

type CloudAgentMentionCandidate = {
  requestMessage: CanonicalSessionMessage;
  targetAccountId: string;
  targetHumanDisplayName: string;
  targetAgentDisplayName: string;
  targetCloudAgentId?: string | null;
  targetCloudAgentName?: string | null;
  targetCloudAgentOwnerName?: string | null;
};

function accountIdForHumanIdentity(state: CanonicalSessionState, identityId?: string | null): string | null {
  const identity = identityId ? state.identities.find((candidate) => candidate.id === identityId) : null;
  if (!identity || identity.kind !== 'human') return null;
  const metadata = objectContent(identity.metadata);
  return cleanText(identity.humanId)
    || cleanText(identity.bridgeNodeId)
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

function cloudGroupParticipantSnapshotForSession(
  state: CanonicalSessionState,
  sessionId: string,
  account: CloudAccount,
): CloudGroupParticipant[] {
  const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
  const participants = state.participants
    .filter((participant) => participant.sessionId === sessionId && participant.state !== 'left')
    .flatMap((participant): CloudGroupParticipant[] => {
      const identity = identityById.get(participant.identityId);
      if (!identity || identity.kind !== 'human') return [];
      const accountId = cleanText(identity.humanId) || cleanText(identity.bridgeNodeId);
      if (!accountId) return [];
      return [{
        accountId,
        displayName: cleanText(identity.displayName) || accountId,
        avatarUrl: identity.profileImageUrl ?? null,
        role: participant.role || 'person',
      }];
    });
  return cloudGroupUniqueParticipants([
    cloudGroupSelfParticipant(account, 'person'),
    ...participants,
  ]);
}

type CloudAgentMentionCandidateOptions = {
  /** Lower bound (inclusive) on `createdAtMs` — older messages are skipped. */
  recentSinceMs?: number;
  /**
   * Message IDs that should be kept even if they fall outside `recentSinceMs`.
   * Used to keep stale-but-still-noticed candidates so existing timers reconcile.
   */
  keepStaleIds?: ReadonlySet<string>;
};

export function cloudAgentMentionCandidates(
  state: CanonicalSessionState,
  accountId: string,
  options: CloudAgentMentionCandidateOptions = {},
): CloudAgentMentionCandidate[] {
  const { recentSinceMs, keepStaleIds } = options;
  const identityByHumanId = new Map<string, CanonicalIdentity>();
  const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
  for (const identity of state.identities) {
    const humanId = cleanText(identity.humanId) || cleanText(identity.bridgeNodeId);
    if (identity.kind === 'human' && humanId) identityByHumanId.set(humanId, identity);
  }

  return state.messages.flatMap((message): CloudAgentMentionCandidate[] => {
    if (message.sourceTransport === 'canonical-fork-snapshot') return [];
    if (message.senderRole !== 'user' || message.status === 'failed') return [];
    if (message.sessionId.trim().startsWith('session:direct-person:')) return [];
    if (
      recentSinceMs !== undefined
      && message.createdAtMs < recentSinceMs
      && !keepStaleIds?.has(message.id)
    ) return [];
    const content = objectContent(message.content);
    const mentions = Array.isArray(content.mentions) ? content.mentions : [];
    return mentions.flatMap((rawMention): CloudAgentMentionCandidate[] => {
      const mention = objectContent(rawMention);
      if (cleanText(typeof mention.targetKind === 'string' ? mention.targetKind : null) !== 'bridge-agent') return [];
      if (cleanText(typeof mention.bridgeHostId === 'string' ? mention.bridgeHostId : null) !== CLOUD_HOST_SENTINEL) return [];
      const targetAccountId = cleanText(typeof mention.humanId === 'string' ? mention.humanId : null)
        || cleanText(typeof mention.nodeId === 'string' ? mention.nodeId : null);
      const targetCloudAgentId = cleanText(typeof mention.agentId === 'string' ? mention.agentId : null).startsWith('cloud_agent_')
        ? cleanText(typeof mention.agentId === 'string' ? mention.agentId : null)
        : null;
      if (!targetAccountId || (targetAccountId === accountId && !targetCloudAgentId)) return [];
      const humanIdentity = identityByHumanId.get(targetAccountId);
      const agentIdentity = identityById.get(`agent:cloud:${targetAccountId}`);
      const targetHumanDisplayName = cleanText(humanIdentity?.displayName)
        || cleanText(typeof mention.ownerName === 'string' ? mention.ownerName : null)
        || cleanText(typeof mention.label === 'string' ? mention.label.replace(/'?sKordi$/u, '') : null)
        || targetAccountId;
      const targetAgentDisplayName = targetCloudAgentId
        ? cleanText(typeof mention.displayLabel === 'string' ? mention.displayLabel : null)
          || cleanText(typeof mention.label === 'string' ? mention.label : null)
          || 'Shared Agent'
        : cleanText(agentIdentity?.displayName) || `${targetHumanDisplayName}'s Kordi`;
      return [{
        requestMessage: message,
        targetAccountId,
        targetHumanDisplayName,
        targetAgentDisplayName,
        targetCloudAgentId,
        targetCloudAgentName: targetCloudAgentId ? targetAgentDisplayName : null,
        targetCloudAgentOwnerName: targetCloudAgentId ? targetHumanDisplayName : null,
      }];
    });
  });
}

function cloudGroupRequestSlotMatches(message: CanonicalSessionMessage, noticeId: string) {
  return message.id === noticeId;
}

function cloudAgentRequestReachedCloud(message: CanonicalSessionMessage): boolean {
  const content = objectContent(message.content);
  const deliveryState = cleanText(typeof content.deliveryState === 'string' ? content.deliveryState : null).toLowerCase();
  return ['sent', 'delivered', 'read'].includes(message.status.trim().toLowerCase())
    || ['sent', 'delivered', 'read'].includes(deliveryState);
}

function cloudGroupOfflinePlaceholderMatches(message: CanonicalSessionMessage, noticeId: string) {
  if (!cloudGroupRequestSlotMatches(message, noticeId) || message.sourceTransport !== 'cloud-group-agent-offline') return false;
  const content = objectContent(message.content);
  const deliveryState = cleanText(typeof content.deliveryState === 'string' ? content.deliveryState : null).toLowerCase();
  const status = message.status.trim().toLowerCase();
  return !['failed', 'cancelled'].includes(status) && !['failed', 'cancelled'].includes(deliveryState);
}

function cloudGroupAgentResponseMatches(
  message: CanonicalSessionMessage,
  candidate: CloudAgentMentionCandidate,
) {
  if (message.senderIdentityId !== `agent:cloud:${candidate.targetAccountId}`) return false;
  if (message.sourceTransport !== 'cloud-group-agent') return false;
  const content = objectContent(message.content);
  const linkedRequestId = cleanText(message.parentMessageId)
    || cleanText(typeof content.requestId === 'string' ? content.requestId : null)
    || cleanText(typeof content.replyToMessageId === 'string' ? content.replyToMessageId : null);
  return linkedRequestId === candidate.requestMessage.id;
}

function upsertCanonicalRequestIntoLocalState(
  current: CanonicalSessionState | null,
  request: AppendCanonicalMessageRequest,
): CanonicalSessionState | null {
  if (!current) return current;
  const id = request.id?.trim();
  if (!id) return current;
  const createdAtMs = request.createdAtMs ?? Date.now();
  const existingIndex = current.messages.findIndex((message) => message.id === id);
  const existing = existingIndex >= 0 ? current.messages[existingIndex] : null;
  const nextMessage: CanonicalSessionMessage = {
    id,
    sessionId: request.sessionId,
    senderIdentityId: request.senderIdentityId,
    senderRole: request.senderRole,
    messageKind: request.messageKind,
    contentText: request.contentText,
    content: request.content ?? {},
    parentMessageId: request.parentMessageId ?? null,
    delegatedExchangeId: request.delegatedExchangeId ?? null,
    status: request.status ?? 'sent',
    sequenceNum: existing?.sequenceNum ?? current.messages
      .filter((message) => message.sessionId === request.sessionId)
      .reduce((max, message) => Math.max(max, message.sequenceNum), 0) + 1,
    createdAtMs: existing?.createdAtMs ?? createdAtMs,
    updatedAtMs: createdAtMs,
    contentHash: existing?.contentHash ?? null,
    sourceTransport: request.sourceTransport ?? null,
    sourceEventId: request.sourceEventId ?? null,
  };
  const messages = existingIndex >= 0
    ? current.messages.map((message, index) => (index === existingIndex ? nextMessage : message))
    : [...current.messages, nextMessage];
  return { ...current, messages };
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

export const CLOUD_GROUP_AGENT_UNAVAILABLE_NOTICE = 'Cloud Agent did not reply yet. The owner device may be offline or still starting.';

function cloudGroupAgentUnavailableFallbackRequest(input: {
  sessionId: string;
  requestMessageId: string;
  targetAccountId: string;
  targetAgentDisplayName?: string | null;
  createdAtMs?: number | null;
}): AppendCanonicalMessageRequest {
  const createdAtMs = typeof input.createdAtMs === 'number' && Number.isFinite(input.createdAtMs)
    ? input.createdAtMs
    : Date.now();
  const requestMessageId = input.requestMessageId.trim();
  const targetAccountId = input.targetAccountId.trim();
  return {
    id: `msg:cloud-agent-offline:${requestMessageId}:${targetAccountId}`,
    sessionId: input.sessionId,
    senderIdentityId: `agent:cloud:${targetAccountId}`,
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      sender: input.targetAgentDisplayName?.trim() || 'Kordi',
      timestampMs: createdAtMs,
      deliveryState: 'failed',
      requestId: requestMessageId,
      replyToMessageId: requestMessageId,
      error: CLOUD_GROUP_AGENT_UNAVAILABLE_NOTICE,
    },
    parentMessageId: requestMessageId,
    status: 'failed',
    createdAtMs,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId: `cloud-group-agent-unavailable-timeout:${requestMessageId}:${targetAccountId}`,
  };
}

function cloudGroupTerminalTimeoutPlaceholderMatches(message: CanonicalSessionMessage, noticeId: string) {
  if (!cloudGroupRequestSlotMatches(message, noticeId)) return false;
  return message.sourceTransport === 'cloud-group-agent-offline'
    || message.sourceEventId?.startsWith('cloud-group-agent-unavailable-timeout:') === true
    || message.sourceEventId?.startsWith('cloud-group-agent-no-provider-timeout:') === true;
}

function removeCloudGroupOfflinePlaceholder(
  current: CanonicalSessionState | null,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter((message) => !cloudGroupOfflinePlaceholderMatches(message, noticeId));
  return nextMessages.length === current.messages.length ? current : { ...current, messages: nextMessages };
}

function cloudGroupPendingAgentRowMatches(
  message: CanonicalSessionMessage,
  requestId: string,
  targetAccountId: string,
) {
  const trimmedRequestId = requestId.trim();
  const trimmedTargetAccountId = targetAccountId.trim();
  if (!trimmedRequestId || !trimmedTargetAccountId) return false;
  if (message.senderIdentityId !== `agent:cloud:${trimmedTargetAccountId}`) return false;
  if (!message.sourceTransport?.startsWith('cloud-group-agent')) return false;
  const content = objectContent(message.content);
  const linkedRequestId = cleanText(message.parentMessageId)
    || cleanText(typeof content.requestId === 'string' ? content.requestId : null)
    || cleanText(typeof content.replyToMessageId === 'string' ? content.replyToMessageId : null);
  if (linkedRequestId !== trimmedRequestId) return false;
  const status = message.status.trim().toLowerCase();
  const deliveryState = cleanText(typeof content.deliveryState === 'string' ? content.deliveryState : null).toLowerCase();
  return status === 'processing'
    || deliveryState === 'processing'
    || message.sourceTransport === 'cloud-group-agent-offline'
    || message.sourceEventId?.startsWith('cloud-group-agent-unavailable-timeout:') === true
    || message.sourceEventId?.startsWith('cloud-group-agent-no-provider-timeout:') === true;
}

function removeCloudGroupTimeoutPlaceholderForTerminalResponse(
  current: CanonicalSessionState | null,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter((message) => !cloudGroupTerminalTimeoutPlaceholderMatches(message, noticeId));
  return nextMessages.length === current.messages.length ? current : { ...current, messages: nextMessages };
}

function removeCloudGroupPendingRowsForTerminalResponse(
  current: CanonicalSessionState | null,
  requestId: string,
  targetAccountId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter((message) => !cloudGroupPendingAgentRowMatches(message, requestId, targetAccountId));
  return nextMessages.length === current.messages.length ? current : { ...current, messages: nextMessages };
}

function removeCanonicalMessageById(
  current: CanonicalSessionState | null,
  messageId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter((message) => message.id !== messageId);
  return nextMessages.length === current.messages.length ? current : { ...current, messages: nextMessages };
}

/**
 * After writing a cancel notice for a request, the offline-tier "Requesting…"
 * placeholder for the same request must disappear in the same render — otherwise
 * the two coexist briefly, the cancel notice is rendered below the placeholder,
 * and when the offline-timer effect tidies the placeholder on the next tick the
 * cancel notice visually shifts up. Users perceive this as the cancel notice
 * appearing, disappearing, then reappearing.
 *
 * Derive the offline placeholder id from the processing message's senderIdentityId
 * (`agent:cloud:<targetAccountId>`) and apply the existing removal helper to the
 * post-cancel state so a single setCanonicalSessionState call carries both.
 */
function collapseCloudAgentOfflinePlaceholderForRequest(
  nextState: CanonicalSessionState,
  processingMessage: CanonicalSessionMessage,
  requestId: string,
): CanonicalSessionState {
  const prefix = 'agent:cloud:';
  const senderIdentityId = processingMessage.senderIdentityId;
  if (!senderIdentityId.startsWith(prefix)) return nextState;
  const targetAccountId = senderIdentityId.slice(prefix.length).trim();
  if (!targetAccountId) return nextState;
  const offlinePlaceholderId = `msg:cloud-agent-offline:${requestId.trim()}:${targetAccountId}`;
  return removeCloudGroupOfflinePlaceholder(nextState, offlinePlaceholderId) ?? nextState;
}

function setCloudGroupRequestPlaceholderProcessing(
  current: CanonicalSessionState | null,
  candidate: CloudAgentMentionCandidate,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  let changed = false;
  const updatedAtMs = Date.now();
  const nextMessages = current.messages.flatMap((message): CanonicalSessionMessage[] => {
    if (cloudGroupRequestSlotMatches(message, noticeId)) {
      const content = objectContent(message.content);
      const deliveryState = cleanText(typeof content.deliveryState === 'string' ? content.deliveryState : null).toLowerCase();
      if (message.status === 'processing' && deliveryState === 'processing' && message.contentText === 'processing...') return [message];
      changed = true;
      return [{
        ...message,
        contentText: 'processing...',
        content: {
          ...content,
          deliveryState: 'processing',
          timestampMs: typeof content.timestampMs === 'number' ? content.timestampMs : updatedAtMs,
        },
        status: 'processing',
        updatedAtMs,
      }];
    }
    if (cloudGroupAgentResponseMatches(message, candidate)) {
      changed = true;
      return [];
    }
    return [message];
  });
  return changed ? { ...current, messages: nextMessages } : current;
}

function appendCloudGroupRequestingPlaceholder(
  current: CanonicalSessionState | null,
  candidate: CloudAgentMentionCandidate,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current || current.messages.some((message) => message.id === noticeId)) return current;
  const createdAtMs = Date.now();
  return {
    ...current,
    messages: [
      ...current.messages,
      cloudGroupAgentRequestingNoticeMessage({
        sessionId: candidate.requestMessage.sessionId,
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        targetAgentDisplayName: candidate.targetAgentDisplayName,
        createdAtMs,
        sequenceNum: candidate.requestMessage.sequenceNum + 1,
      }),
    ],
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isRecentCloudAgentMention(createdAt: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= CLOUD_AGENT_MENTION_WINDOW_MS;
}

export function cloudAgentResponseExistsForRequest({
  account,
  requestMessageId,
  peerMessages,
}: {
  account: CloudAccount;
  requestMessageId: string;
  peerMessages: readonly CloudMessage[];
}): boolean {
  return peerMessages.some((candidate) => (
    candidate.fromAccountId === account.accountId
    && parseCloudAgentResponse(candidate.body)?.requestId === requestMessageId
  ));
}

export function cloudGroupAgentResponseExistsForRequest({
  localAccountId,
  requestMessageId,
  messages = [],
  groupRows = [],
}: {
  localAccountId: string;
  requestMessageId: string;
  messages?: readonly CloudMessage[];
  groupRows?: readonly IndexedCloudGroupRow[];
}): boolean {
  const trimmedLocalAccountId = localAccountId.trim();
  const trimmedRequestMessageId = requestMessageId.trim();
  if (!trimmedLocalAccountId || !trimmedRequestMessageId) return false;
  const parsedRows = messages.flatMap((wire) => {
    const envelope = parseCloudGroupControl(wire.body);
    return envelope ? [{ wire, envelope, canonicalMessageId: cleanText(envelope.message?.id) || null }] : [];
  });
  return [...groupRows, ...parsedRows].some(({ envelope }) => {
    if (envelope?.kind !== 'group-message' || !envelope.message) return false;
    if (envelope.message.senderKind !== 'agent') return false;
    if (envelope.message.senderAccountId !== trimmedLocalAccountId) return false;
    if (envelope.message.deliveryState === 'processing') return false;
    const linkedRequestId = cleanText(envelope.message.requestId) || cleanText(envelope.message.replyToMessageId);
    return linkedRequestId === trimmedRequestMessageId;
  });
}

export function cloudAgentRunStatusAlreadyOwnsRequest(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'leased' || status === 'running' || status === 'completed';
}

export function cloudFallbackClaimErrorIsRetryable(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '').trim().toLowerCase()
    : '';
  return code === 'network_error'
    || code === 'owner_online'
    || code === 'agent_not_available'
    || code === 'rate_limited'
    || code === 'server_error';
}

type CloudFallbackClaimAttemptResult = 'claimed' | 'already-claimed' | 'in-flight' | 'retryable-failure' | 'terminal-failure' | 'not-signed-in';

function cloudAgentRunAlreadyOwnsRequest(run: CloudAgentRun | null | undefined): boolean {
  return cloudAgentRunStatusAlreadyOwnsRequest(run?.status);
}

async function cloudFallbackRunAlreadyOwnsRequest({
  client,
  token,
  requestMessageId,
}: {
  client: CloudAuthClient;
  token: string;
  requestMessageId: string;
}): Promise<boolean> {
  const run = await client.lookupCloudAgentRunForRequest(token, requestMessageId).catch(() => null);
  return cloudAgentRunAlreadyOwnsRequest(run);
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

export function shouldRunLocalCloudAgentForCloudMessage({
  account,
  isGroupControl,
  peerId,
  message,
  peerMessages,
}: {
  account: CloudAccount;
  isGroupControl?: boolean;
  peerId: string;
  message: CloudMessage;
  peerMessages: readonly CloudMessage[];
}): boolean {
  if (peerId === account.accountId) return false;
  if (message.fromAccountId !== account.accountId && message.toAccountId !== account.accountId) return false;
  if ((isGroupControl ?? Boolean(parseCloudGroupControl(message.body))) || parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) return false;
  if (!cloudMessageActionAllowsAgentTrigger(cloudDirectMessageAction(message.body))) return false;
  const targetsHostedCloudAgent = cloudDirectMessageTargetsOwnedHostedCloudAgent(message.body, account.accountId);
  if (!targetsHostedCloudAgent && !cloudMessageMentionsLocalAgent(message.body, account, {
    allowFirstPerson: message.fromAccountId === account.accountId,
  })) return false;
  if (!isRecentCloudAgentMention(message.createdAt)) return false;
  return !cloudAgentResponseExistsForRequest({ account, requestMessageId: message.messageId, peerMessages });
}

function cloudContactPeerAccountId(contact: Contact): string {
  return contact.bridgePeerNodeId?.trim() || contact.id.replace(/^cloud:/, '').trim();
}

const MAX_CLOUD_FALLBACK_HISTORY_MESSAGES = 12;

function cloudFallbackHistoryParticipantName(contact: Contact | undefined, ownerAccountId: string): string {
  return contact?.name?.trim() || ownerAccountId.trim() || 'Peer';
}

function cloudFallbackHistoryLine({
  account,
  contact,
  isGroupControl,
  message,
  ownerAccountId,
}: {
  account: CloudAccount;
  contact: Contact | undefined;
  isGroupControl: boolean;
  message: CloudMessage;
  ownerAccountId: string;
}): string | null {
  if (isGroupControl || parseCloudAgentCancel(message.body)) return null;
  if (!cloudMessageActionAllowsAgentContext(cloudDirectMessageAction(message.body))) return null;
  const agentResponse = parseCloudAgentResponse(message.body);
  const displayBody = cloudDirectMessageDisplayText(message.body);
  const text = agentResponse?.text
    ?? (message.fromAccountId === account.accountId && cloudMessageMentionsContactAgent({ ...message, body: displayBody }, contact)
      ? promptTextForCloudAgentMention(displayBody)
      : displayBody);
  const cleanText = text.trim();
  if (!cleanText) return null;
  const peerName = cloudFallbackHistoryParticipantName(contact, ownerAccountId);
  const label = agentResponse
    ? `${peerName}'s Kordi`
    : message.fromAccountId === account.accountId
      ? 'Me'
      : peerName;
  return `${label}: ${cleanText}`;
}

function cloudFallbackRunPromptForMessage({
  account,
  contact,
  message,
  ownerAccountId,
  peerMessages,
  groupControlMessageIds,
}: {
  account: CloudAccount;
  contact: Contact | undefined;
  message: CloudMessage;
  ownerAccountId: string;
  peerMessages: readonly CloudMessage[];
  groupControlMessageIds: ReadonlySet<string>;
}): string {
  const currentPrompt = promptTextForCloudAgentMention(cloudDirectMessageDisplayText(message.body));
  const requestIndex = peerMessages.findIndex((candidate) => candidate.messageId === message.messageId);
  const previousMessages = (requestIndex >= 0 ? peerMessages.slice(0, requestIndex) : peerMessages)
    .filter((candidate) => candidate.messageId !== message.messageId);
  const history = previousMessages
    .map((candidate) => cloudFallbackHistoryLine({
      account,
      contact,
      isGroupControl: groupControlMessageIds.has(candidate.messageId),
      message: candidate,
      ownerAccountId,
    }))
    .filter((line): line is string => Boolean(line))
    .slice(-MAX_CLOUD_FALLBACK_HISTORY_MESSAGES);
  if (history.length === 0) return currentPrompt;
  return `Conversation history:\n${history.join('\n')}\n\nCurrent request:\n${currentPrompt}`;
}

function cloudGroupFallbackHistoryLine(envelope: CloudGroupControlEnvelope): string | null {
  if (envelope.kind !== 'group-message' || !envelope.message) return null;
  const message = envelope.message;
  if (!cloudMessageActionAllowsAgentContext(message.messageAction)) return null;
  if (message.deliveryState === 'processing' || isCloudAgentProcessingPlaceholderText(message.text)) return null;
  const text = message.senderKind === 'agent' ? message.text.trim() : promptTextForCloudAgentMention(message.text).trim();
  if (!text) return null;
  const participantName = envelope.participants.find((participant) => participant.accountId === message.senderAccountId)?.displayName?.trim();
  const label = message.senderDisplayName?.trim()
    || (message.senderKind === 'agent' && participantName ? `${participantName}'s Kordi` : participantName)
    || 'Cloud participant';
  return `${label}: ${text}`;
}

function cloudGroupFallbackRunPromptForMessage({
  groupRows,
  groupId,
  requestMessageId,
  requestCreatedAtMs,
  requestText,
}: {
  groupRows: readonly IndexedCloudGroupRow[];
  groupId: string;
  requestMessageId: string;
  requestCreatedAtMs: number;
  requestText: string;
}): string {
  const currentPrompt = promptTextForCloudAgentMention(requestText);
  const seenMessageIds = new Set<string>();
  const history = groupRows
    .flatMap(({ envelope }) => {
      if (envelope?.kind !== 'group-message' || envelope.groupId !== groupId || !envelope.message) return [];
      if (envelope.message.id === requestMessageId) return [];
      if (envelope.message.createdAtMs > requestCreatedAtMs) return [];
      if (envelope.message.forkSnapshot === true) return [];
      if (!cloudMessageActionAllowsAgentContext(envelope.message.messageAction)) return [];
      if (seenMessageIds.has(envelope.message.id)) return [];
      seenMessageIds.add(envelope.message.id);
      const line = cloudGroupFallbackHistoryLine(envelope);
      return line ? [line] : [];
    })
    .slice(-MAX_CLOUD_FALLBACK_HISTORY_MESSAGES);
  if (history.length === 0) return currentPrompt;
  return `Group chat history:\n${history.join('\n')}\n\nCurrent request:\n${currentPrompt}`;
}

export function cloudFallbackRunClaimsForMessages({
  account,
  contacts,
  messageIndex,
  messagesByPeer = {},
}: {
  account: CloudAccount;
  contacts: Contact[];
  messageIndex?: CloudMessageIndex;
  messagesByPeer?: Record<string, CloudMessage[]>;
}): CloudAgentRunClaimInput[] {
  const index = messageIndex ?? buildCloudMessageIndex(account.accountId, messagesByPeer);
  const contactByPeerId = new Map(contacts.map((contact) => [cloudContactPeerAccountId(contact), contact]));
  const claims: CloudAgentRunClaimInput[] = [];
  const groupRowByWireMessageId = index.groupRowByWireMessageId;
  const groupControlMessageIds = new Set(groupRowByWireMessageId.keys());
  const terminalGroupResponseKeys = new Set<string>();
  for (const { envelope } of index.groupRows) {
    const groupMessage = envelope.kind === 'group-message' ? envelope.message : null;
    if (!groupMessage || groupMessage.senderKind !== 'agent' || groupMessage.deliveryState === 'processing') continue;
    const linkedRequestId = cleanText(groupMessage.requestId) || cleanText(groupMessage.replyToMessageId);
    if (linkedRequestId) terminalGroupResponseKeys.add(`${envelope.groupId}\u0000${groupMessage.senderAccountId}\u0000${linkedRequestId}`);
  }
  const terminalDirectRequestIdsByPeerId = new Map<string, Set<string>>();
  for (const [peerId, peerMessages] of index.byPeerId) {
    const requestIds = new Set<string>();
    for (const message of peerMessages) {
      if (groupControlMessageIds.has(message.messageId)) continue;
      const requestId = parseCloudAgentCancel(message.body)?.requestId
        || parseCloudAgentResponse(message.body)?.requestId;
      if (requestId) requestIds.add(requestId);
    }
    terminalDirectRequestIdsByPeerId.set(peerId, requestIds);
  }

  for (const [peerId, peerMessages] of index.byPeerId) {
    const ownerAccountId = peerId.trim();
    if (!ownerAccountId || ownerAccountId === account.accountId) continue;
    const contact = contactByPeerId.get(ownerAccountId);
    for (const message of peerMessages) {
      if (message.fromAccountId !== account.accountId || message.toAccountId !== ownerAccountId) continue;
      const groupEnvelope = groupRowByWireMessageId.get(message.messageId)?.envelope;
      if (groupEnvelope?.kind === 'group-message' && groupEnvelope.message?.senderAccountId === account.accountId) {
        const groupMessage = groupEnvelope.message;
        if (!cloudMessageActionAllowsAgentTrigger(groupMessage.messageAction)) continue;
        const groupRequestMessage = { ...message, body: groupMessage.text };
        if (!cloudMessageMentionsContactAgent(groupRequestMessage, contact)) continue;
        const alreadyTerminal = terminalGroupResponseKeys.has(`${groupEnvelope.groupId}\u0000${ownerAccountId}\u0000${groupMessage.id}`);
        if (alreadyTerminal) continue;
        claims.push({
          requestMessageId: groupMessage.id,
          sessionId: groupEnvelope.groupId,
          ownerAccountId,
          requesterAccountId: account.accountId,
          prompt: cloudGroupFallbackRunPromptForMessage({
            groupRows: index.groupRows,
            groupId: groupEnvelope.groupId,
            requestMessageId: groupMessage.id,
            requestCreatedAtMs: groupMessage.createdAtMs,
            requestText: groupMessage.text,
          }),
          idempotencyKey: `cloud-agent-fallback-group:${groupEnvelope.groupId}:${groupMessage.id}:${ownerAccountId}`,
        });
        continue;
      }
      if (groupEnvelope || parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) continue;
      if (!cloudMessageActionAllowsAgentTrigger(cloudDirectMessageAction(message.body))) continue;
      const targetCloudAgentId = cloudDirectMessageTargetCloudAgentId(message.body);
      const targetsHostedCloudAgent = targetCloudAgentId && cloudDirectMessageTargetCloudAgentOwnerAccountId(message.body) === ownerAccountId;
      if (!targetsHostedCloudAgent && !cloudMessageMentionsContactAgent(message, contact)) continue;
      const alreadyTerminal = terminalDirectRequestIdsByPeerId.get(peerId)?.has(message.messageId) === true;
      if (alreadyTerminal) continue;
      claims.push({
        requestMessageId: message.messageId,
        sessionId: message.sessionId?.trim() || cloudDirectPersonSessionId(account.accountId, ownerAccountId),
        ownerAccountId,
        requesterAccountId: account.accountId,
        prompt: cloudFallbackRunPromptForMessage({
          account,
          contact,
          message,
          ownerAccountId,
          peerMessages,
          groupControlMessageIds,
        }),
        idempotencyKey: `cloud-agent-fallback:${message.messageId}:${ownerAccountId}`,
        ...(targetCloudAgentId ? { targetCloudAgentId } : {}),
      });
    }
  }

  return claims;
}

function isCloudAgentProcessingPlaceholderText(text: string): boolean {
  return /^processing[.\s…]*$/iu.test(text.trim());
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

function cloudMessageAttachmentsEqual(left: CloudMessage['attachments'] = [], right: CloudMessage['attachments'] = []): boolean {
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((attachment, index) => {
    const other = (right ?? [])[index];
    return Boolean(other)
      && attachment.attachmentId === other.attachmentId
      && attachment.name === other.name
      && attachment.kind === other.kind
      && (attachment.mimeType ?? null) === (other.mimeType ?? null)
      && (attachment.sizeBytes ?? null) === (other.sizeBytes ?? null)
      && (attachment.localPath ?? null) === (other.localPath ?? null);
  });
}

function cloudMessagesEqual(message: CloudMessage, other: CloudMessage | undefined): boolean {
  if (!other) return false;
  return message.messageId === other.messageId
    && message.fromAccountId === other.fromAccountId
    && message.toAccountId === other.toAccountId
    && message.body === other.body
    && message.createdAt === other.createdAt
    && message.deliveredAt === other.deliveredAt
    && message.readAt === other.readAt
    && message.direction === other.direction
    && (message.sessionId ?? null) === (other.sessionId ?? null)
    && cloudMessageAttachmentsEqual(message.attachments, other.attachments);
}

function cloudMessageListsEqual(left: CloudMessage[] = [], right: CloudMessage[] = []): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((message, index) => cloudMessagesEqual(message, right[index]));
}

export function cloudMessagesByPeerEqual(
  left: Record<string, CloudMessage[]>,
  right: Record<string, CloudMessage[]>,
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && cloudMessageListsEqual(left[key], right[key]));
}

export function mergeCloudMessagesByPeerSnapshot(
  current: Record<string, CloudMessage[]>,
  incoming: Record<string, CloudMessage[]>,
): Record<string, CloudMessage[]> {
  const peerIds = uniqueSortedPeerIds([...Object.keys(current), ...Object.keys(incoming)]);
  const merged: Record<string, CloudMessage[]> = {};
  let changed = peerIds.length !== Object.keys(current).length;
  for (const peerId of peerIds) {
    const currentMessages = current[peerId] ?? [];
    const byMessageId = new Map<string, CloudMessage>();
    for (const message of currentMessages) byMessageId.set(message.messageId, message);
    for (const message of incoming[peerId] ?? []) {
      const previous = byMessageId.get(message.messageId);
      if (!previous) {
        byMessageId.set(message.messageId, message);
        continue;
      }
      const candidate = mergeCloudMessageMonotonicState(previous, message);
      byMessageId.set(message.messageId, cloudMessagesEqual(previous, candidate) ? previous : candidate);
    }
    const messages = [...byMessageId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (messages.length > 0) {
      const unchanged = cloudMessageListsEqual(currentMessages, messages);
      merged[peerId] = unchanged ? currentMessages : messages;
      if (!unchanged) changed = true;
    }
  }
  return changed ? merged : current;
}

export function markCloudMessagesReadLocally(
  current: Record<string, CloudMessage[]>,
  accountId: string,
  targets: {
    peerIds?: string[];
    sessionIds?: string[];
    groupRowByWireMessageId?: ReadonlyMap<string, IndexedCloudGroupRow>;
  },
  readAt: string = new Date().toISOString(),
): Record<string, CloudMessage[]> {
  const localAccountId = cleanText(accountId);
  const peerIds = new Set((targets.peerIds ?? []).map(cleanText).filter(Boolean));
  const sessionIds = new Set((targets.sessionIds ?? []).map(cleanText).filter(Boolean));
  if (!localAccountId || (peerIds.size === 0 && sessionIds.size === 0)) return current;

  let changed = false;
  const next: Record<string, CloudMessage[]> = {};
  for (const [peerId, messages] of Object.entries(current)) {
    let nextMessages: CloudMessage[] | null = null;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.toAccountId !== localAccountId || message.direction !== 'incoming' || message.readAt) continue;
      const peerMatches = peerIds.has(peerId) || peerIds.has(message.fromAccountId);
      const indexedGroupId = targets.groupRowByWireMessageId?.get(message.messageId)?.envelope.groupId;
      const messageSessionId = peerMatches || sessionIds.size === 0
        ? ''
        : cleanText(message.sessionId)
          || cleanText(indexedGroupId)
          || (targets.groupRowByWireMessageId ? '' : cleanText(parseCloudGroupControl(message.body)?.groupId));
      const sessionMatches = Boolean(messageSessionId && sessionIds.has(messageSessionId));
      if (!peerMatches && !sessionMatches) continue;
      changed = true;
      nextMessages ??= messages.slice();
      nextMessages[index] = { ...message, readAt };
    }
    next[peerId] = nextMessages ?? messages;
  }
  return changed ? next : current;
}

export const CLOUD_MESSAGE_DISCOVERY_MAX_PASSES = 50;
export const CLOUD_FOCUS_REFRESH_THROTTLE_MS = 5000;
export const CLOUD_FOCUS_REFRESH_DELAY_MS = 500;

export function shouldRefreshCloudForVisibility(visibilityState: DocumentVisibilityState) {
  return visibilityState === 'visible';
}

export function shouldRunCloudFocusRefresh(
  nowMs: number,
  lastRefreshAtMs: number,
  throttleMs = CLOUD_FOCUS_REFRESH_THROTTLE_MS,
) {
  return lastRefreshAtMs <= 0 || nowMs - lastRefreshAtMs >= throttleMs;
}

export function cloudSessionForksByIdEqual(
  left: Record<string, CloudSessionForkSummary>,
  right: Record<string, CloudSessionForkSummary>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index]) return false;
    const leftFork = left[key];
    const rightFork = right[key];
    if (
      leftFork.forkSessionId !== rightFork.forkSessionId
      || leftFork.parentSessionId !== rightFork.parentSessionId
      || leftFork.parentMessageId !== rightFork.parentMessageId
      || leftFork.createdByAccountId !== rightFork.createdByAccountId
      || leftFork.createdAt !== rightFork.createdAt
    ) {
      return false;
    }
  }
  return true;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function uniqueSortedPeerIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

function peerIdListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function cloudUnreadReadinessContextKey(
  accountId: string,
  generation: number,
  peerKey: string,
) {
  return JSON.stringify([accountId.trim(), generation, peerKey]);
}

export function cloudAccountGenerationKey(accountId: string, generation: number) {
  return JSON.stringify([accountId.trim(), generation]);
}

export function transitionCloudUnreadReadiness(
  current: CloudUnreadReadinessSnapshot,
  status: CloudUnreadReadinessStatus,
  contextKey: string,
): CloudUnreadReadinessSnapshot {
  if (status !== 'ready' && current.status === 'ready' && current.contextKey === contextKey) {
    return current;
  }
  if (current.status === status && current.contextKey === contextKey) return current;
  return { status, contextKey };
}

export function cloudMessagesAuthoritativeForContext({
  accountId,
  contactsSettled,
  generation,
  peerKey,
  readiness,
}: {
  accountId: string | null | undefined;
  contactsSettled: boolean;
  generation: number;
  peerKey: string;
  readiness: CloudUnreadReadinessSnapshot;
}): boolean {
  if (!accountId) return true;
  if (!contactsSettled) return false;
  return readiness.status === 'ready'
    && readiness.contextKey === cloudUnreadReadinessContextKey(accountId, generation, peerKey);
}

export function cloudUnreadReadyForContext({
  accountId,
  contactsSettled,
  generation,
  peerKey,
  readiness,
  publishedContextKey,
}: {
  accountId: string | null | undefined;
  contactsSettled: boolean;
  generation: number;
  peerKey: string;
  readiness: CloudUnreadReadinessSnapshot;
  publishedContextKey: string | null;
}): boolean {
  return cloudUnreadStatusForContext({
    accountId,
    contactsSettled,
    generation,
    peerKey,
    readiness,
    publishedContextKey,
  }) === 'ready';
}

export function cloudUnreadStatusForContext({
  accountId,
  contactsSettled,
  generation,
  peerKey,
  readiness,
  publishedContextKey,
}: {
  accountId: string | null | undefined;
  contactsSettled: boolean;
  generation: number;
  peerKey: string;
  readiness: CloudUnreadReadinessSnapshot;
  publishedContextKey: string | null;
}): CloudUnreadReadinessStatus {
  if (!accountId) return 'ready';
  if (!contactsSettled) return 'pending';
  const contextKey = cloudUnreadReadinessContextKey(accountId, generation, peerKey);
  if (readiness.contextKey !== contextKey) return 'pending';
  if (readiness.status !== 'ready') return readiness.status;
  return publishedContextKey === contextKey ? 'ready' : 'pending';
}

export async function loadCloudMessagesByPeerUntilStable({
  accountId,
  initialPeerIds,
  existingMessagesByPeer,
  listMessages,
  maxPasses = CLOUD_MESSAGE_DISCOVERY_MAX_PASSES,
}: {
  accountId: string;
  initialPeerIds: string[];
  existingMessagesByPeer: Record<string, CloudMessage[]>;
  listMessages(peerId: string): Promise<CloudMessage[]>;
  maxPasses?: number;
}): Promise<{ messagesByPeer: Record<string, CloudMessage[]>; peerIds: string[]; complete: boolean }> {
  const byPeer: Record<string, CloudMessage[]> = {};
  let peerIds = uniqueSortedPeerIds(initialPeerIds);
  let hadError = false;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const missingPeerIds = peerIds.filter((peerId) => !(peerId in byPeer));
    if (missingPeerIds.length === 0) {
      return { messagesByPeer: byPeer, peerIds, complete: !hadError };
    }

    const entries = await Promise.all(missingPeerIds.map(async (peerId) => {
      try {
        return [peerId, await listMessages(peerId)] as const;
      } catch {
        hadError = true;
        return [peerId, existingMessagesByPeer[peerId] ?? []] as const;
      }
    }));
    for (const [peerId, messages] of entries) byPeer[peerId] = messages;

    const expandedPeerIds = uniqueSortedPeerIds(cloudGroupPeerIdsFromMessages({
      accountId,
      contactPeerIds: peerIds,
      messages: Object.values(byPeer).flat(),
    }));
    if (peerIdListsEqual(expandedPeerIds, peerIds)) {
      return { messagesByPeer: byPeer, peerIds, complete: !hadError };
    }
    peerIds = expandedPeerIds;
  }

  return { messagesByPeer: byPeer, peerIds, complete: false };
}

export function createAccountScopedSingleFlight() {
  const inFlightByAccount = new Map<string, Promise<void>>();
  return (accountId: string, task: () => Promise<void>): Promise<void> => {
    const key = accountId.trim();
    const existing = inFlightByAccount.get(key);
    if (existing) return existing;

    let tracked: Promise<void>;
    try {
      tracked = task().finally(() => {
        if (inFlightByAccount.get(key) === tracked) inFlightByAccount.delete(key);
      });
    } catch (error) {
      return Promise.reject(error);
    }
    inFlightByAccount.set(key, tracked);
    return tracked;
  };
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

  const ensureSessionRequest = (sessionId: string, seed: string, generatedFromMessageId?: string | null, updatedAtMs?: number) => {
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
    const shouldUpdateExistingTitle = cloudWinsExisting
      || (Boolean(generatedTitle) && existingSource === 'placeholder');
    const metadata = {
      cloudSelfAgentSession: true,
      ...(shouldUpdateExistingTitle || !existingSession
        ? cloudTitleMetadata ?? sessionTitleMetadata(generatedTitle ? 'auto' : 'placeholder', { generatedFromMessageId, updatedAtMs })
        : {}),
      ...(fork
        ? {
            fork: {
              forkedFromSessionId: fork.parentSessionId,
              ...(fork.parentMessageId ? { forkedFromMessageId: fork.parentMessageId } : {}),
            },
          }
        : {}),
    };
    const existingFork = existingMetadata.fork && typeof existingMetadata.fork === 'object' && !Array.isArray(existingMetadata.fork)
      ? existingMetadata.fork as Record<string, unknown>
      : null;
    const existingHasFork = Boolean(fork)
      && existingFork?.forkedFromSessionId === fork?.parentSessionId
      && (!fork?.parentMessageId || existingFork?.forkedFromMessageId === fork.parentMessageId);
    if (existingSession && (!fork || existingHasFork) && !shouldUpdateExistingTitle) return;
    sessionRequestsById.set(sessionId, {
      id: sessionId,
      kind: 'self-agent',
      title: shouldUpdateExistingTitle ? title : cleanText(existingSession?.title) || title,
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
        );
      } else {
        ensureSessionRequest(
          sessionId,
          sourceTransport === 'canonical-fork-snapshot'
            ? ''
            : cleanText(userTextByCloudMessageId.get(responseRequestId)) || '',
          responseRequestId,
          createdAtMs,
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
      bridgeNodeId: null,
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
  bridgeParticipants?: DesktopBridgeSessionParticipant[];
  fork?: CloudGroupControlEnvelope['fork'];
  message?: CloudGroupControlEnvelope['message'];
  attachments?: AttachmentItem[];
  retryFailed?: boolean;
};

export type SendCloudBridgeMessageOptions = {
  clientMessageId?: string | null;
};

export type UseCloudBridgeStateResult = {
  cloudBridgeState: DesktopBridgeState | null;
  setCloudBridgeState: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  mergedBridgeState: DesktopBridgeState | null;
  prepareCloudForwardAttachments(attachments: MessageAttachment[]): Promise<AttachmentItem[]>;
  sendCloudBridgeMessage(
    conversationId: string,
    text: string,
    attachments?: AttachmentItem[],
    options?: SendCloudBridgeMessageOptions,
  ): Promise<void>;
  sendCloudGroupControl(input: SendCloudGroupControlInput): Promise<void>;
  recordCloudSessionFork(input: { sourceSessionId: string; forkSessionId: string; parentMessageId?: string | null }): Promise<void>;
  updateCloudSessionPin(input: { sessionId: string; messageId: string | null; scope: 'private' | 'shared' }): Promise<CloudSessionPin>;
  hideCloudSession(sessionId: string): Promise<void>;
  unhideCloudSession(sessionId: string): Promise<void>;
  deleteCloudSession(sessionId: string): Promise<void>;
  cancelCloudBridgeAgentRequest(conversationId: string, requestId: string): Promise<void>;
  refreshCloudBridgeMessages(): Promise<void>;
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
  state: DesktopBridgeState | null,
  route: DesktopChatMessageRoute | null,
): DesktopBridgeState | null {
  if (!state) return state;
  return {
    ...state,
    hosts: state.hosts.map((host) => {
      if (!isCloudBridgeHostId(host.id)) return host;
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

export function cloudBridgePreviousStateForContext(
  state: DesktopBridgeState | null,
  stateContextKey: string | null,
  currentContextKey: string | null,
) {
  return currentContextKey && stateContextKey === currentContextKey ? state : null;
}

export function suppressCloudBridgeUnreadCounts(
  state: DesktopBridgeState | null,
): DesktopBridgeState | null {
  if (!state) return state;
  let changed = false;
  const conversations = state.conversations.map((conversation) => {
    if (conversation.unreadCount === 0) return conversation;
    changed = true;
    return { ...conversation, unreadCount: 0 };
  });
  return changed ? { ...state, conversations } : state;
}

export function useCloudBridgeState({
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
}): UseCloudBridgeStateResult {
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
  const cloudGroupOfflineTimersRef = useRef<Map<string, number>>(new Map());
  const cloudProfileCacheRef = useRef<Map<string, CloudPublicProfile>>(new Map());
  const bootstrapPeerIdsRef = useRef<string[]>([]);
  const [readInboundMessageIdsByPeer, setReadInboundMessageIdsByPeer] = useState<Record<string, Set<string>>>({});
  const [localAgentTurnsByRequestId, setLocalAgentTurnsByRequestId] = useState<Record<string, DesktopChatTurnSnapshot>>({});
  const [cloudBridgeOverride, setCloudBridgeOverrideState] = useState<DesktopBridgeState | null>(null);
  const [cloudSelfAgentSyncStatusBySessionId, setCloudSelfAgentSyncStatusBySessionId] = useState<Record<string, CloudSelfAgentSyncStatus>>({});
  const cloudBridgeStateRef = useRef<DesktopBridgeState | null>(null);
  const cloudBridgeStateContextKeyRef = useRef<string | null>(null);
  const cloudBridgeOverrideContextKeyRef = useRef<string | null>(null);
  const readReceiptRequestRef = useRef<string | null>(null);
  const persistedActiveReadSignatureRef = useRef<string | null>(null);
  const processedCloudAgentMentionIdsRef = useRef<Set<string>>(new Set());
  const claimedCloudFallbackRunKeysRef = useRef<Set<string>>(new Set());
  const claimingCloudFallbackRunKeysRef = useRef<Set<string>>(new Set());
  const syncedProviderAuthSnapshotKeysRef = useRef<Set<string>>(new Set());
  const cloudAgentTurnIdsByRequestIdRef = useRef<Map<string, string>>(new Map());
  const cloudSelfAgentForkRefreshKeyRef = useRef<string | null>(null);
  const syncingSelfAgentHistoryRef = useRef(false);
  const pendingCloudSyncRequestRef = useRef<PendingCloudSyncRequest | null>(null);
  const startupFullSnapshotContextRef = useRef<string | null>(null);
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
    pendingCloudSyncRequestRef.current = null;
    startupFullSnapshotContextRef.current = null;
    claimedCloudFallbackRunKeysRef.current.clear();
    claimingCloudFallbackRunKeysRef.current.clear();
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
    cloudBridgeStateRef.current = null;
    cloudBridgeStateContextKeyRef.current = null;
    cloudBridgeOverrideContextKeyRef.current = null;
    setCloudBridgeOverrideState(null);
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

  useEffect(() => () => {
    for (const timerId of cloudGroupOfflineTimersRef.current.values()) window.clearTimeout(timerId);
    cloudGroupOfflineTimersRef.current.clear();
  }, []);

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
      .map((contact) => contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, ''))
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
  const cloudBridgeContacts = contacts.contacts;
  const groupParticipantPeerIds = useMemo(
    () => groupParticipantContacts
      .map((contact) => contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, ''))
      .filter((value): value is string => Boolean(value)),
    [groupParticipantContacts],
  );
  const cloudLookupContacts = useMemo(
    () => [...contacts.contacts, ...groupParticipantContacts],
    [contacts.contacts, groupParticipantContacts],
  );
  const contactPeerIds = useMemo(
    () => contacts.contacts
      .map((contact) => contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, ''))
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
  const cloudBridgeAccountContextKey = account
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
  useEffect(() => {
    bootstrapPeerIdsRef.current = bootstrapPeerIds;
  }, [bootstrapPeerKey]);
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
        // eslint-disable-next-line no-console
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
        bridgePeerNodeId: contact.bridgePeerNodeId ?? null,
        bridgeHumanId: contact.bridgeHumanId ?? null,
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

  const markCloudUnreadReadiness = useCallback((
    status: CloudUnreadReadinessStatus,
    generation: number,
    peerKey: string,
  ) => {
    const accountId = account?.accountId;
    if (!accountId || !cloudSyncCoordinator.isCurrentGeneration(generation)) return;
    const contextKey = cloudUnreadReadinessContextKey(accountId, generation, peerKey);
    setCloudUnreadReadiness((current) => transitionCloudUnreadReadiness(
      current,
      status,
      contextKey,
    ));
  }, [account?.accountId, cloudSyncCoordinator]);

  const refreshCloudBridgeMessagesOnce = useCallback(async (
    generation: number,
    settleUnreadReadiness: boolean = true,
  ) => {
    if (!cloudSyncCoordinator.isCurrentGeneration(generation)) return;
    const retainedPeerIds = Object.keys(messagesByPeerRef.current);
    const initialPeerIds = [...new Set([...bootstrapPeerIdsRef.current, ...retainedPeerIds])];
    if (!account || initialPeerIds.length === 0) {
      if (!cloudSyncCoordinator.isCurrentGeneration(generation)) return;
      messagesByPeerRef.current = {};
      setMessagesByPeer((current) => (Object.keys(current).length === 0 ? current : {}));
      if (settleUnreadReadiness) {
        markCloudUnreadReadiness('ready', generation, bootstrapPeerKey);
      }
      return;
    }
    const session = await loadSession();
    if (!cloudSyncCoordinator.isCurrentGeneration(generation)) return;
    if (!session?.token) {
      if (settleUnreadReadiness) {
        markCloudUnreadReadiness('error', generation, bootstrapPeerKey);
      }
      return;
    }

    const loaded = await loadCloudMessagesByPeerUntilStable({
      accountId: account.accountId,
      initialPeerIds,
      existingMessagesByPeer: messagesByPeerRef.current,
      listMessages: async (peerId) => (
        await client.listMessages(session.token, peerId, CLOUD_MESSAGE_SNAPSHOT_LIMIT)
      ).map(cloudMessageMetadataOnly),
    });

    if (cancelledRef.current || !cloudSyncCoordinator.isCurrentGeneration(generation)) return;
    messagesByPeerRef.current = mergeCloudMessagesByPeerSnapshot(
      messagesByPeerRef.current,
      loaded.messagesByPeer,
    );
    setMessagesByPeer((current) => {
      const merged = mergeCloudMessagesByPeerSnapshot(current, loaded.messagesByPeer);
      return cloudMessagesByPeerEqual(current, merged) ? current : merged;
    });
    if (settleUnreadReadiness) {
      markCloudUnreadReadiness(loaded.complete ? 'ready' : 'error', generation, bootstrapPeerKey);
    }
  }, [account, bootstrapPeerKey, client, cloudSyncCoordinator, markCloudUnreadReadiness]);

  const syncCloudBridgeDiffOnceForGeneration = useCallback(async (
    generation: number,
    settleInitialMessages: boolean,
  ) => {
    if (!account || !cloudSyncCoordinator.isCurrentGeneration(generation)) return;
    const session = await loadSession();
    if (!cloudSyncCoordinator.isCurrentGeneration(generation)) return;
    if (!session?.token) {
      if (settleInitialMessages) {
        markCloudUnreadReadiness('error', generation, bootstrapPeerKey);
      }
      return;
    }
    let messagesByPeer = messagesByPeerRef.current;
    let sessionActivity = cloudSessionActivityRef.current;
    let sessionForksById = cloudSessionForksByIdRef.current;
    let sessionPinsById = cloudSessionPinsByIdRef.current;
    let sessionTitlesById = cloudSessionTitlesByIdRef.current;
    let cloudAgentsById = cloudAgentDefinitionsByIdRef.current;
    let hiddenSessionIds = cloudHiddenSessionIdsRef.current;
    let deletedSessionIds = cloudDeletedSessionIdsRef.current;
    let fallbackRequired = false;
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await syncCloudDiffOnce({
        accountId: account.accountId,
        messagesByPeer,
        sessionActivity,
        sessionForksById,
        sessionPinsById,
        sessionTitlesById,
        cloudAgentsById,
        hiddenSessionIds,
        deletedSessionIds,
        shouldSaveCursor: () => cloudSyncCoordinator.isCurrentGeneration(generation),
        fetchEvents: (cursor) => client.syncCloudEvents(session.token, cursor, 500),
      });
      if (!cloudSyncCoordinator.isCurrentGeneration(generation)) return;
      if (result.fallbackRequired) {
        fallbackRequired = true;
        break;
      }
      messagesByPeer = result.messagesByPeer;
      sessionActivity = result.sessionActivity;
      sessionForksById = result.sessionForksById;
      sessionPinsById = result.sessionPinsById;
      sessionTitlesById = result.sessionTitlesById;
      cloudAgentsById = result.cloudAgentsById;
      hiddenSessionIds = result.hiddenSessionIds;
      deletedSessionIds = result.deletedSessionIds;
      if (!result.hasMore) break;
    }
    if (cancelledRef.current || !cloudSyncCoordinator.isCurrentGeneration(generation)) return;
    if (fallbackRequired) {
      await Promise.all([
        refreshCloudBridgeMessagesOnce(generation, settleInitialMessages),
        refreshCloudAgents(generation),
      ]);
      return;
    }
    messagesByPeerRef.current = mergeCloudMessagesByPeerSnapshot(
      messagesByPeerRef.current,
      messagesByPeer,
    );
    setMessagesByPeer((current) => {
      const merged = mergeCloudMessagesByPeerSnapshot(current, messagesByPeer);
      return cloudMessagesByPeerEqual(current, merged) ? current : merged;
    });
    setCloudSessionActivity((current) => mergeCloudSessionActivity(current, sessionActivity));
    setCloudSessionForksById((current) => (
      cloudSessionForksByIdEqual(current, sessionForksById) ? current : sessionForksById
    ));
    setCloudSessionPinsById((current) => (
      JSON.stringify(current) === JSON.stringify(sessionPinsById) ? current : sessionPinsById
    ));
    setCloudSessionTitlesById((current) => (
      JSON.stringify(current) === JSON.stringify(sessionTitlesById) ? current : sessionTitlesById
    ));
    setCloudAgentDefinitionsById((current) => (
      JSON.stringify(current) === JSON.stringify(cloudAgentsById) ? current : cloudAgentsById
    ));
    setCloudHiddenSessionIds((current) => setsEqual(current, hiddenSessionIds) ? current : new Set(hiddenSessionIds));
    setCloudDeletedSessionIds((current) => setsEqual(current, deletedSessionIds) ? current : new Set(deletedSessionIds));
  }, [account, bootstrapPeerKey, client, cloudSyncCoordinator, markCloudUnreadReadiness, refreshCloudAgents, refreshCloudBridgeMessagesOnce]);

  const runCoordinatedCloudSync = useCallback(async (generation: number) => {
    const request = pendingCloudSyncRequestRef.current;
    pendingCloudSyncRequestRef.current = null;
    if (!request) return;
    try {
      if (request.mode === 'bootstrap') {
        // Establish the newest server state before replaying historical events,
        // keep unread badges hidden throughout catch-up, and publish only after
        // a final authoritative snapshot has reconciled cross-device reads.
        await refreshCloudBridgeMessagesOnce(generation, false);
        await syncCloudBridgeDiffOnceForGeneration(generation, false);
        await refreshCloudBridgeMessagesOnce(generation, true);
      } else if (request.mode === 'full') {
        await refreshCloudBridgeMessagesOnce(generation);
      } else {
        await syncCloudBridgeDiffOnceForGeneration(generation, request.settleInitialMessages);
      }
    } catch (error) {
      if (request.mode !== 'diff' || request.settleInitialMessages) {
        markCloudUnreadReadiness('error', generation, bootstrapPeerKey);
      }
      throw error;
    }
  }, [bootstrapPeerKey, markCloudUnreadReadiness, refreshCloudBridgeMessagesOnce, syncCloudBridgeDiffOnceForGeneration]);

  const requestCloudSync = useCallback((request: PendingCloudSyncRequest) => {
    const pending = pendingCloudSyncRequestRef.current;
    const mode = pending?.mode === 'bootstrap' || request.mode === 'bootstrap'
      ? 'bootstrap'
      : pending?.mode === 'full' || request.mode === 'full'
        ? 'full'
        : 'diff';
    const nextRequest = {
      mode,
      settleInitialMessages: Boolean(pending?.settleInitialMessages || request.settleInitialMessages),
    } satisfies PendingCloudSyncRequest;
    pendingCloudSyncRequestRef.current = nextRequest;
    if (nextRequest.mode !== 'diff') {
      markCloudUnreadReadiness(
        'pending',
        cloudSyncCoordinator.currentGeneration(),
        bootstrapPeerKey,
      );
    }
    return cloudSyncCoordinator.request(runCoordinatedCloudSync);
  }, [bootstrapPeerKey, cloudSyncCoordinator, markCloudUnreadReadiness, runCoordinatedCloudSync]);

  const refreshCloudBridgeMessages = useCallback(() => requestCloudSync({
    mode: 'full',
    settleInitialMessages: true,
  }), [requestCloudSync]);

  const bootstrapCloudBridgeMessages = useCallback(() => requestCloudSync({
    mode: 'bootstrap',
    settleInitialMessages: true,
  }), [requestCloudSync]);

  const syncCloudBridgeDiff = useCallback((options: { settleInitialMessages?: boolean } = {}) => requestCloudSync({
    mode: 'diff',
    settleInitialMessages: options.settleInitialMessages ?? true,
  }), [requestCloudSync]);

  const claimCloudFallbackRun = useCallback(async (
    claim: CloudAgentRunClaimInput,
    tokenOverride?: string | null,
  ): Promise<CloudFallbackClaimAttemptResult> => {
    if (claimedCloudFallbackRunKeysRef.current.has(claim.idempotencyKey)) return 'already-claimed';
    if (claimingCloudFallbackRunKeysRef.current.has(claim.idempotencyKey)) return 'in-flight';
    const token = tokenOverride?.trim() || (await loadSession())?.token?.trim();
    if (!token) return 'not-signed-in';
    claimingCloudFallbackRunKeysRef.current.add(claim.idempotencyKey);
    try {
      const run = await client.claimCloudAgentRun(token, claim);
      if (!cloudAgentRunAlreadyOwnsRequest(run)) return 'terminal-failure';
      claimedCloudFallbackRunKeysRef.current.add(claim.idempotencyKey);
      return 'claimed';
    } catch (error) {
      // Transient owner-presence and invite-propagation races are expected.
      // Keep them eligible for the bounded status recheck instead of suppressing
      // this request for the remainder of the app session.
      const retryable = cloudFallbackClaimErrorIsRetryable(error);
      // eslint-disable-next-line no-console
      console.warn('[cloud-agent-fallback] claim failed', error);
      return retryable ? 'retryable-failure' : 'terminal-failure';
    } finally {
      claimingCloudFallbackRunKeysRef.current.delete(claim.idempotencyKey);
    }
  }, [client]);

  useEffect(() => {
    if (!account) {
      setMessagesByPeer({});
      setCloudSessionActivity(EMPTY_CLOUD_SESSION_ACTIVITY);
      setCloudSessionForksById({});
      setCloudSessionPinsById({});
      setCloudAgentDefinitionsById({});
      setReadInboundMessageIdsByPeer({});
      setLocalAgentTurnsByRequestId({});
      setCloudBridgeOverrideState(null);
      setCloudUnreadReadiness({ status: 'ready', contextKey: null });
      setPublishedCloudUnreadContextKey(null);
      cloudSelfAgentForkRefreshKeyRef.current = null;
      return;
    }
    if (!contacts.initialLoadSettled) return;
    if (!cloudUnreadContextKey) return;
    if (startupFullSnapshotContextRef.current !== cloudUnreadContextKey) {
      startupFullSnapshotContextRef.current = cloudUnreadContextKey;
      void refreshCloudAgents(cloudSyncCoordinator.currentGeneration());
      void bootstrapCloudBridgeMessages().catch(() => {
        if (startupFullSnapshotContextRef.current === cloudUnreadContextKey) {
          startupFullSnapshotContextRef.current = null;
        }
      });
    }
    const interval = window.setInterval(() => {
      void syncCloudBridgeDiff();
    }, CLOUD_MESSAGES_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [account, bootstrapCloudBridgeMessages, cloudSyncCoordinator, cloudUnreadContextKey, contacts.initialLoadSettled, refreshCloudAgents, syncCloudBridgeDiff]);

  useEffect(() => {
    if (!account || !canonicalSessionState || !setCanonicalSessionState) {
      for (const timerId of cloudGroupOfflineTimersRef.current.values()) window.clearTimeout(timerId);
      cloudGroupOfflineTimersRef.current.clear();
      return;
    }

    // Long sessions can carry thousands of messages; the candidate walk used to
    // visit every one on every state change. Restrict it to the recency window
    // and only keep stale messages that still carry an offline / requesting
    // notice (their `requestMessageId` is embedded in the notice id).
    const cloudAgentOfflineNoticeIdPattern = /^msg:cloud-agent-offline:(.+?):/;
    const keepStaleIds = new Set<string>();
    for (const message of canonicalSessionState.messages) {
      const match = cloudAgentOfflineNoticeIdPattern.exec(message.id);
      if (match) keepStaleIds.add(match[1]);
    }

    const candidates = cloudAgentMentionCandidates(canonicalSessionState, account.accountId, {
      recentSinceMs: Date.now() - CLOUD_AGENT_MENTION_WINDOW_MS,
      keepStaleIds,
    });
    const activeKeys = new Set<string>();

    for (const candidate of candidates) {
      const noticeId = `msg:cloud-agent-processing:${candidate.requestMessage.id}:${candidate.targetAccountId}`;
      const key = `${candidate.requestMessage.id}\u001f${candidate.targetAccountId}`;
      const existingNotice = canonicalSessionState.messages.find((message) => message.id === noticeId);
      const hasRequestingNotice = existingNotice?.sourceTransport === 'cloud-group-agent-offline' && existingNotice.status !== 'failed';
      if (Date.now() - candidate.requestMessage.createdAtMs > CLOUD_AGENT_MENTION_WINDOW_MS && !hasRequestingNotice) continue;
      activeKeys.add(key);
      const responseState = cloudGroupAgentMentionResponseState({
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        messages: canonicalSessionState.messages,
      });
      const requestReachedCloud = cloudAgentRequestReachedCloud(candidate.requestMessage);
      const hasOfflineNotice = existingNotice?.status === 'failed';
      if (responseState || hasOfflineNotice) {
        const timerId = cloudGroupOfflineTimersRef.current.get(key);
        if (timerId !== undefined) window.clearTimeout(timerId);
        cloudGroupOfflineTimersRef.current.delete(key);
        setCanonicalSessionState((current) => {
          if (responseState === 'processing') {
            return setCloudGroupRequestPlaceholderProcessing(current, candidate, noticeId);
          }
          if (responseState === 'terminal') {
            return removeCloudGroupPendingRowsForTerminalResponse(current, candidate.requestMessage.id, candidate.targetAccountId);
          }
          return current;
        });
        continue;
      }
      if (cloudGroupOfflineTimersRef.current.has(key)) continue;

      const requestDeadlineMs = candidate.requestMessage.createdAtMs + CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS;
      const persistUnavailableNotice = async () => {
        const failedNoticeRequest = cloudGroupAgentUnavailableFallbackRequest({
          sessionId: candidate.requestMessage.sessionId,
          requestMessageId: candidate.requestMessage.id,
          targetAccountId: candidate.targetAccountId,
          targetAgentDisplayName: candidate.targetAgentDisplayName,
          createdAtMs: Date.now(),
        });
        setCanonicalSessionState((current) => upsertCanonicalRequestIntoLocalState(current, failedNoticeRequest));
        await upsertCanonicalMessageFast(failedNoticeRequest);
      };
      const scheduleStatusCheck = (delayMs: number) => {
        const timeoutId = window.setTimeout(() => {
          cloudGroupOfflineTimersRef.current.delete(key);
          void checkRequestStatus().catch((error) => {
            // eslint-disable-next-line no-console
            console.warn('[cloud-group-agent-requesting] status check failed', error);
            if (Date.now() < requestDeadlineMs) {
              scheduleStatusCheck(CLOUD_GROUP_AGENT_STATUS_RECHECK_MS);
            } else {
              void persistUnavailableNotice().catch((persistError) => {
                // eslint-disable-next-line no-console
                console.warn('[cloud-group-agent-requesting] failed to persist unavailable notice', persistError);
              });
            }
          });
        }, delayMs);
        cloudGroupOfflineTimersRef.current.set(key, timeoutId);
      };
      const checkRequestStatus = async () => {
        const latestState = canonicalSessionStateRef.current;
        const latestResponseState = latestState ? cloudGroupAgentMentionResponseState({
          requestMessageId: candidate.requestMessage.id,
          targetAccountId: candidate.targetAccountId,
          messages: latestState.messages,
        }) : null;
        if (latestResponseState === 'terminal') {
          setCanonicalSessionState((current) => removeCloudGroupPendingRowsForTerminalResponse(current, candidate.requestMessage.id, candidate.targetAccountId));
          return;
        }
        if (latestResponseState === 'processing') {
          setCanonicalSessionState((current) => setCloudGroupRequestPlaceholderProcessing(current, candidate, noticeId));
          return;
        }

        const session = await loadSession();
        if (session?.token && await cloudFallbackRunAlreadyOwnsRequest({
          client,
          token: session.token,
          requestMessageId: candidate.requestMessage.id,
        })) {
          setCanonicalSessionState((current) => setCloudGroupRequestPlaceholderProcessing(current, candidate, noticeId));
          return;
        }

        const exactClaim = account ? cloudFallbackRunClaimsForMessages({
          account,
          contacts: contacts.contacts,
          messageIndex: cloudMessageIndexRef.current,
        }).find((claim) => (
          claim.requestMessageId === candidate.requestMessage.id
          && claim.ownerAccountId === candidate.targetAccountId
        )) : null;
        let claimResult: CloudFallbackClaimAttemptResult = 'retryable-failure';
        if (exactClaim) {
          // The lookup above found no active run. Release the local success
          // cache so a previously failed/cancelled run can be retried.
          claimedCloudFallbackRunKeysRef.current.delete(exactClaim.idempotencyKey);
          claimResult = await claimCloudFallbackRun(exactClaim, session?.token);
        }
        if (claimResult === 'claimed' || claimResult === 'already-claimed') {
          setCanonicalSessionState((current) => setCloudGroupRequestPlaceholderProcessing(current, candidate, noticeId));
          return;
        }

        const remainingMs = requestDeadlineMs - Date.now();
        if (remainingMs > 0) {
          scheduleStatusCheck(Math.min(CLOUD_GROUP_AGENT_STATUS_RECHECK_MS, remainingMs));
          return;
        }
        await persistUnavailableNotice();
      };
      const remainingBeforeFirstCheckMs = Math.max(0, requestDeadlineMs - Date.now());
      scheduleStatusCheck(Math.min(CLOUD_GROUP_AGENT_STATUS_RECHECK_MS, remainingBeforeFirstCheckMs));

      if (hasRequestingNotice && requestReachedCloud) {
        // Reaching Cloud only proves delivery, not target availability. Keep the
        // existing placeholder but arm the timeout above so it cannot remain as
        // "Processing…" forever if the target instance never sends a terminal
        // agent response.
        continue;
      }

      const requestingNoticeRequest = cloudGroupAgentRequestingNoticeRequest({
        sessionId: candidate.requestMessage.sessionId,
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        targetAgentDisplayName: candidate.targetAgentDisplayName,
        createdAtMs: Date.now(),
      });
      setCanonicalSessionState((current) => upsertCanonicalRequestIntoLocalState(
        appendCloudGroupRequestingPlaceholder(current, candidate, noticeId),
        requestingNoticeRequest,
      ));
      void upsertCanonicalMessageFast(requestingNoticeRequest)
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.warn('[cloud-group-agent-requesting] failed to persist processing notice', error);
        });
      continue;
    }

    for (const [key, timerId] of cloudGroupOfflineTimersRef.current.entries()) {
      if (activeKeys.has(key)) continue;
      window.clearTimeout(timerId);
      cloudGroupOfflineTimersRef.current.delete(key);
      const [requestMessageId, targetAccountId] = key.split('\u001f');
      if (requestMessageId && targetAccountId) {
        setCanonicalSessionState((current) => removeCloudGroupOfflinePlaceholder(
          current,
          `msg:cloud-agent-offline:${requestMessageId}:${targetAccountId}`,
        ));
      }
    }
  }, [account, canonicalSessionState, claimCloudFallbackRun, client, contacts.contacts, setCanonicalSessionState]);

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
      await syncCloudBridgeDiff();
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
        // eslint-disable-next-line no-console
        console.warn('[cloud-self-agent-sync] failed to sync local history', error);
      })
      .finally(() => {
        syncingSelfAgentHistoryRef.current = false;
      });
  }, [account, canonicalSessionState, client, mergeMessage, syncCloudBridgeDiff]);

  const applyCloudGroupControl = useCallback(async (cloudMessage: CloudMessage, envelope: CloudGroupControlEnvelope) => {
    // Read state from refs, not closure, so this useCallback's identity stays
    // stable across canonical updates. Earlier the function was rebuilt on
    // every canonicalSessionState change, which made the replay useEffect
    // (deps include applyCloudGroupControl) re-fire on every setState. The
    // ~11 internal setCanonicalSessionState calls per envelope then compounded
    // and React tripped "Maximum update depth exceeded" — visible on the
    // user1 window and via the WS reconnect loop on all three.
    const canonicalState = canonicalSessionStateRef.current;
    if (!account || !canonicalState || !setCanonicalSessionState) return;
    const localHumanIdentityId = canonicalState.profile.humanIdentityId?.trim();
    if (!localHumanIdentityId) return;

    const rawParticipants = [envelope.actor, ...envelope.participants, cloudGroupSelfParticipant(account, 'self')];
    const profileAccountIds = [...new Set(rawParticipants.map((participant) => participant.accountId.trim()).filter(Boolean))];
    const missingProfileAccountIds = profileAccountIds.filter((accountId) => !cloudProfileCacheRef.current.has(accountId));
    if (missingProfileAccountIds.length > 0) {
      const session = await loadSession();
      if (session?.token) {
        await Promise.all(missingProfileAccountIds.map(async (accountId) => {
          try {
            const profile = accountId === account.accountId
              ? {
                  accountId: account.accountId,
                  displayName: account.displayName,
                  avatarUrl: account.avatarUrl,
                  nodeId: account.nodeId,
                  isContact: false,
                  isSelf: true,
                }
              : await client.getProfile(session.token, accountId);
            cloudProfileCacheRef.current.set(accountId, profile);
          } catch {
            // Group sync must still work if a profile lookup races account/session refresh.
          }
        }));
      }
    }
    const hydratedParticipants = cloudGroupParticipantsWithProfiles(
      rawParticipants,
      profileAccountIds
        .map((accountId) => cloudProfileCacheRef.current.get(accountId))
        .filter((profile): profile is CloudPublicProfile => Boolean(profile)),
    );

    const participantByAccount = new Map<string, CloudGroupParticipant>();
    for (const participant of hydratedParticipants) {
      const normalized = participant.accountId.trim() ? participant : null;
      if (!normalized || participantByAccount.has(normalized.accountId)) continue;
      participantByAccount.set(normalized.accountId, normalized);
    }

    const identityIdByAccount = new Map<string, string>();
    let nextState: CanonicalSessionState | null = canonicalState;
    for (const participant of participantByAccount.values()) {
      const request = cloudGroupIdentityRequest(participant, account, localHumanIdentityId);
      identityIdByAccount.set(participant.accountId, request.id ?? '');
      const identity = await upsertCanonicalIdentityFast(request);
      nextState = upsertCanonicalIdentityIntoLocalState(nextState, identity);
    }

    const groupSpaceId = envelope.groupSpaceId?.trim() || envelope.groupId;
    const envelopeSession = canonicalState.sessions.find((session) => session.id === envelope.groupId) ?? null;
    const groupRootSession = canonicalState.sessions.find((session) => session.id === groupSpaceId) ?? null;
    const envelopeSessionMetadata = objectContent(envelopeSession?.metadata);
    const groupRootMetadata = objectContent(groupRootSession?.metadata);
    const storedCreatorIdentityId = cleanText(
      typeof envelopeSessionMetadata.groupCreatorIdentityId === 'string'
        ? envelopeSessionMetadata.groupCreatorIdentityId
        : typeof groupRootMetadata.groupCreatorIdentityId === 'string'
          ? groupRootMetadata.groupCreatorIdentityId
          : groupRootSession?.createdByIdentityId || envelopeSession?.createdByIdentityId || null,
    );
    const createdByIdentityId = storedCreatorIdentityId
      || identityIdByAccount.get(envelope.createdByAccountId)
      || identityIdByAccount.get(envelope.actor.accountId)
      || localHumanIdentityId;
    const participantIdentityIds = [...identityIdByAccount.entries()]
      .filter(([, identityId]) => identityId !== createdByIdentityId)
      .map(([, identityId]) => identityId);
    const sessionTitleUpdateTitle = cloudSessionTitleUpdateTitle(envelope);
    const incomingGroupTitle = shouldApplyCloudGroupTitleUpdate(envelope) ? envelope.groupTitle : null;
    const isSelfAuthoredControl = envelope.actor.accountId === account.accountId;
    const participantNames = [...participantByAccount.values()].map((participant) => participant.displayName);
    const forkMetadata = envelope.fork ? {
      forkedFromSessionId: envelope.fork.parentSessionId,
      forkedFromMessageId: envelope.fork.parentMessageId ?? null,
      forkMode: 'cloud-group',
      contextPolicy: 'prefix-through-message',
      boundary: 'inherited-history-reference-only',
      createdAtMs: envelope.fork.createdAtMs ?? null,
    } : null;
    const parsedControlCreatedAtMs = Date.parse(cloudMessage.createdAt);
    const controlCreatedAtMs = Number.isFinite(parsedControlCreatedAtMs) ? parsedControlCreatedAtMs : Date.now();
    const storedGroupTitleCandidates = [
      { sessionId: groupSpaceId, metadata: groupRootMetadata },
      { sessionId: envelope.groupId, metadata: envelopeSessionMetadata },
    ];
    const groupTitleResolution = resolveReplicatedGroupTitle({
      candidates: storedGroupTitleCandidates.map(({ sessionId, metadata }) => ({
        sessionId,
        groupSpaceId,
        customName: typeof metadata.customName === 'string' ? metadata.customName : null,
        groupNameUpdatedAtMs: typeof metadata.groupNameUpdatedAtMs === 'number' ? metadata.groupNameUpdatedAtMs : null,
      })),
      groupSpaceId,
      incomingTitle: incomingGroupTitle,
      incomingUpdatedAtMs: controlCreatedAtMs,
    });
    const envelopeAdminUpdatedAtMs = typeof envelopeSessionMetadata.groupAdminUpdatedAtMs === 'number'
      && Number.isFinite(envelopeSessionMetadata.groupAdminUpdatedAtMs)
      ? envelopeSessionMetadata.groupAdminUpdatedAtMs
      : 0;
    const rootAdminUpdatedAtMs = typeof groupRootMetadata.groupAdminUpdatedAtMs === 'number'
      && Number.isFinite(groupRootMetadata.groupAdminUpdatedAtMs)
      ? groupRootMetadata.groupAdminUpdatedAtMs
      : 0;
    const storedAdminMetadata = rootAdminUpdatedAtMs >= envelopeAdminUpdatedAtMs
      ? groupRootMetadata
      : envelopeSessionMetadata;
    const storedAdminValue = Array.isArray(storedAdminMetadata.adminIdentityIds)
      ? storedAdminMetadata.adminIdentityIds
      : Array.isArray(envelopeSessionMetadata.adminIdentityIds)
        ? envelopeSessionMetadata.adminIdentityIds
        : groupRootMetadata.adminIdentityIds;
    const storedAdminIdentityIds = Array.isArray(storedAdminValue)
      ? storedAdminValue
          .filter((identityId): identityId is string => typeof identityId === 'string')
          .map((identityId) => identityId.trim())
          .filter(Boolean)
      : [];
    const storedAdminUpdatedAtMs = Math.max(envelopeAdminUpdatedAtMs, rootAdminUpdatedAtMs);
    const adminSnapshot = resolveCloudGroupAdminSnapshot({
      envelope,
      identityIdByAccount,
      createdByIdentityId,
      existingAdminIdentityIds: storedAdminIdentityIds,
      hasExistingSession: Boolean(envelopeSession),
      controlCreatedAtMs,
      storedAdminUpdatedAtMs,
    });
    const appliesAdminSnapshot = adminSnapshot.applies;
    const adminIdentityIds = adminSnapshot.adminIdentityIds;
    const actorIdentityId = identityIdByAccount.get(envelope.actor.accountId) ?? createdByIdentityId;
    const authorizedSessionTitle = resolveAuthorizedCloudGroupSessionTitleSnapshot({
      envelope,
      controlCreatedAtMs,
      identityIdByAccount,
      adminIdentityIds,
    });
    const groupMetadata = {
      ...groupRootMetadata,
      ...envelopeSessionMetadata,
      schemaVersion: 1,
      kind: 'chat-group',
      customName: groupTitleResolution.title || null,
      ...(groupTitleResolution.updatedAtMs > 0 ? { groupNameUpdatedAtMs: groupTitleResolution.updatedAtMs } : {}),
      groupId: groupSpaceId,
      groupSpaceId,
      groupCreatorIdentityId: createdByIdentityId,
      adminIdentityIds,
      ...(appliesAdminSnapshot ? { groupAdminUpdatedAtMs: controlCreatedAtMs } : {}),
      initialContactIds: [...participantByAccount.keys()].map((accountId) => `cloud:${accountId}`),
      initialParticipantNames: participantNames,
      memberApprovalPolicy: 'under-50-open',
      createdFrom: envelope.kind === 'session-fork' || forkMetadata ? 'cloud-group-fork-sync' : 'cloud-group-sync',
      ...(authorizedSessionTitle
        ? {
            sessionTitleSource: authorizedSessionTitle.titleSource,
            sessionTitleRevision: authorizedSessionTitle.titleRevision,
            sessionTitlePolicyVersion: authorizedSessionTitle.titlePolicyVersion,
            sessionTitleUpdatedAtMs: authorizedSessionTitle.updatedAtMs,
            sessionTitleUpdatedByAccountId: authorizedSessionTitle.updatedByAccountId,
          }
        : {}),
      ...(forkMetadata ? { fork: forkMetadata } : {}),
    };
    const openResult = await openOrCreateCanonicalSessionFast({
      id: envelope.groupId,
      kind: 'group',
      title: authorizedSessionTitle?.title ?? 'New chat',
      status: 'active',
      createdByIdentityId,
      primaryIdentityId: null,
      relationshipIdentityId: null,
      participantIdentityIds,
      metadata: groupMetadata,
    });
    nextState = mergeOpenCanonicalSessionFastResultIntoLocalState(nextState, openResult);
    if (!nextState) return;

    const appliedSessionTitle = Boolean(
      sessionTitleUpdateTitle
      && authorizedSessionTitle
      && openResult.session.title === authorizedSessionTitle.title
      && envelopeSession?.title !== openResult.session.title,
    );
    const sessionTitleIsSelfAuthored = authorizedSessionTitle?.updatedByAccountId === account.accountId;
    if (appliedSessionTitle && authorizedSessionTitle && !sessionTitleIsSelfAuthored) {
      const titleAuthorAccountId = authorizedSessionTitle.updatedByAccountId;
      const noticeRequest = cloudSessionTitleUpdateNoticeRequest({
        envelope,
        actorIdentityId: identityIdByAccount.get(titleAuthorAccountId) ?? actorIdentityId,
        actorDisplayName: participantByAccount.get(titleAuthorAccountId)?.displayName ?? 'Someone',
        createdAtMs: controlCreatedAtMs,
        cloudMessageId: cloudMessage.messageId,
      });
      if (noticeRequest && !nextState.messages.some((message) => message.id === noticeRequest.id)) {
        nextState = await appendCanonicalMessage(noticeRequest);
      }
    }

    if (groupTitleResolution.appliesIncoming) {
      // openOrCreateCanonicalSession above already applied the replicated Cloud
      // group metadata. Do not route incoming Cloud sync through the local UI
      // admin guard; otherwise valid remote updates warn/fail on peers whose
      // local admin identity ids differ from the sender's local identity id.
      if (!isSelfAuthoredControl) {
        const noticeRequest = cloudGroupTitleUpdateNoticeRequest({
          envelope,
          actorIdentityId,
          createdAtMs: controlCreatedAtMs,
          cloudMessageId: cloudMessage.messageId,
        });
        if (noticeRequest && !nextState.messages.some((message) => message.id === noticeRequest.id)) {
          nextState = await appendCanonicalMessage(noticeRequest);
        }
      }
    }

    const memberJoinNoticeRequests = cloudGroupMemberJoinNoticeRequests({
      envelope,
      actorIdentityId,
      identityIdByAccount,
    });
    for (const noticeRequest of memberJoinNoticeRequests) {
      const persistedNotice = await upsertCanonicalMessageFast(noticeRequest);
      nextState = mergeCanonicalMessageRow(nextState, persistedNotice) ?? nextState;
    }

    for (const memberLeave of envelope.memberLeaves ?? []) {
      const removedIdentityId = identityIdByAccount.get(memberLeave.accountId)
        ?? `human:${memberLeave.accountId}`;
      const isStillActive = nextState.participants.some((participant) => (
        participant.sessionId === envelope.groupId
        && participant.identityId === removedIdentityId
        && participant.state === 'active'
      ));
      if (!isStillActive) continue;
      nextState = await removeCanonicalSessionParticipant({
        sessionId: envelope.groupId,
        identityId: removedIdentityId,
        removedByIdentityId: actorIdentityId,
      });
    }

    if (envelope.kind !== 'group-message' || !envelope.message) {
      setCanonicalSessionState(nextState);
      return;
    }
    const senderHumanIdentityId = identityIdByAccount.get(envelope.message.senderAccountId);
    if (!senderHumanIdentityId) {
      setCanonicalSessionState(nextState);
      return;
    }
    // When the local agent owner broadcasts a response, the fresh Cloud
    // envelope id differs from the stable processing-slot id. Match that slot
    // here so a processing replay remains idempotent and a terminal replay can
    // replace it in place instead of creating a duplicate row.
    const isOwnAgentResponseRoundTrip = envelope.message
      && envelope.message.senderKind === 'agent'
      && envelope.message.senderAccountId === account.accountId
      && Boolean((envelope.message.replyToMessageId || envelope.message.requestId)?.trim());
    const senderIsAgent = envelope.message.senderKind === 'agent';
    const senderIdentityId = senderIsAgent ? `agent:cloud:${envelope.message.senderAccountId}` : senderHumanIdentityId;
    const messageReplyToId = envelope.message.replyToMessageId?.trim()
      || envelope.message.requestId?.trim()
      || null;
    const agentDeliveryState = senderIsAgent
      ? (envelope.message.deliveryState?.trim() || (isCloudAgentProcessingPlaceholderText(envelope.message.text) ? 'processing' : 'complete'))
      : null;
    const ownAgentProcessingId = isOwnAgentResponseRoundTrip
      ? `msg:cloud-agent-processing:${(envelope.message!.replyToMessageId || envelope.message!.requestId || '').trim()}:${account.accountId}`
      : null;
    const incomingSourceTransport = envelope.message.forkSnapshot
      ? 'cloud-group-fork-snapshot'
      : senderIsAgent ? 'cloud-group-agent' : 'cloud-group';
    const incomingSourceEventId = `${incomingSourceTransport}:${cloudMessage.messageId}`;
    const existingCloudGroupMessages = [canonicalState, nextState]
      .filter((state): state is CanonicalSessionState => Boolean(state))
      .flatMap((state) => state.messages);
    const existingCloudGroupMessage = existingCloudGroupMessages.find((candidate) => (
      candidate.sourceTransport === incomingSourceTransport
        && candidate.sourceEventId === incomingSourceEventId
    )) ?? existingCloudGroupMessages.find((candidate) => (
        candidate.id === envelope.message?.id
        || (ownAgentProcessingId !== null && candidate.id === ownAgentProcessingId)
    )) ?? null;
    // A stable processing slot is the row that a terminal agent envelope must
    // replace. Treating that placeholder as an already-applied terminal event
    // drops the reply during cold sync and leaves only the disappearing spinner.
    const messageAlreadyExists = cloudGroupIncomingMessageAlreadyApplied(
      existingCloudGroupMessage,
      agentDeliveryState,
    );
    if (senderIsAgent) {
      const owner = participantByAccount.get(envelope.message.senderAccountId);
      const senderIdentity = await upsertCanonicalIdentityFast({
        id: senderIdentityId,
        kind: 'agent',
        displayName: envelope.message.senderDisplayName?.trim() || `${owner?.displayName || 'Cloud user'}'s Kordi`,
        ownerIdentityId: senderHumanIdentityId,
        source: 'bridge',
        sourceHostId: 'cloud',
        bridgeNodeId: `cloud-agent:${envelope.message.senderAccountId}`,
        humanId: envelope.message.senderAccountId,
        agentId: `cloud-agent:${envelope.message.senderAccountId}`,
        avatarKey: `cloud-agent:${envelope.message.senderAccountId}`,
        profileImageUrl: null,
        metadata: { accountId: envelope.message.senderAccountId, cloudGroupAgent: true },
      });
      nextState = upsertCanonicalIdentityIntoLocalState(nextState, senderIdentity);
    }
    const cloudAttachments = cloudMessage.attachments?.length ? cloudMessage.attachments : envelope.message.attachments ?? [];
    const mappedAttachments = cloudAttachments.map(cloudMessageAttachmentToMessageAttachment);

    if (messageAlreadyExists && existingCloudGroupMessage && mappedAttachments.some((attachment) => attachment.localPath)) {
      const content = objectContent(existingCloudGroupMessage.content);
      const existingAttachments = Array.isArray(content.attachments) ? content.attachments : [];
      const shouldUpdateCachedAttachments = existingAttachments.some((attachment) => {
        const record = objectContent(attachment);
        return typeof record.attachmentId === 'string'
          && !record.localPath
          && mappedAttachments.some((mapped) => mapped.attachmentId === record.attachmentId && mapped.localPath);
      });
      if (shouldUpdateCachedAttachments) {
        const mergedAttachments = existingAttachments.map((attachment) => {
          const record = objectContent(attachment);
          const attachmentId = typeof record.attachmentId === 'string' ? record.attachmentId : null;
          const cached = attachmentId ? mappedAttachments.find((mapped) => mapped.attachmentId === attachmentId && mapped.localPath) : null;
          return cached ? { ...record, localPath: cached.localPath } : attachment;
        });
        const attachmentUpdateRequest = {
          id: existingCloudGroupMessage.id,
          sessionId: existingCloudGroupMessage.sessionId,
          senderIdentityId: existingCloudGroupMessage.senderIdentityId,
          senderRole: existingCloudGroupMessage.senderRole,
          messageKind: existingCloudGroupMessage.messageKind,
          contentText: existingCloudGroupMessage.contentText,
          content: { ...content, attachments: mergedAttachments },
          createdAtMs: existingCloudGroupMessage.createdAtMs,
          parentMessageId: existingCloudGroupMessage.parentMessageId ?? null,
          status: existingCloudGroupMessage.status,
          sourceTransport: existingCloudGroupMessage.sourceTransport,
          sourceEventId: existingCloudGroupMessage.sourceEventId,
        } satisfies AppendCanonicalMessageRequest;
        const persistedMessage = await upsertCanonicalMessageFast(attachmentUpdateRequest);
        nextState = mergeCanonicalMessageRow(nextState, persistedMessage);
        setCanonicalSessionState(nextState);
      }
    }

    const responseProcessingSlot = senderIsAgent && messageReplyToId && agentDeliveryState !== 'processing'
      ? [canonicalState, nextState]
          .map((state) => state ? cloudGroupAgentProcessingSlotForResponse(
            state.messages,
            envelope.groupId,
            messageReplyToId,
            envelope.message!.senderAccountId,
          ) : null)
          .find((message): message is CanonicalSessionMessage => Boolean(message)) ?? null
      : null;

    if (messageAlreadyExists && responseProcessingSlot && responseProcessingSlot.id !== existingCloudGroupMessage?.id) {
      nextState = removeCanonicalMessageById(nextState, responseProcessingSlot.id) ?? nextState;
      setCanonicalSessionState(nextState);
    }

    if (!messageAlreadyExists) {
      const stableAgentNoticeId = senderIsAgent && messageReplyToId
        ? `msg:cloud-agent-processing:${messageReplyToId}:${envelope.message.senderAccountId}`
        : null;
      const terminalStableAgentNoticeId = stableAgentNoticeId && agentDeliveryState !== 'processing'
        ? stableAgentNoticeId
        : null;
      // If the slot already holds a CANCELLED or COMPLETED row, do not let
      // a late-arriving processing envelope demote it back to "Processing…".
      // This handles the owner-cancel race (cancel envelope reaches the
      // sender before the owner's initial processing envelope) and protects
      // a real completed reply from being clobbered. The 'failed' state is
      // intentionally NOT blocked here — it's used for the asker's offline
      // timeout marker, which should be replaceable when the target turns
      // out to be slow rather than offline and a real processing/response
      // envelope finally arrives.
      const existingStableRow = stableAgentNoticeId
        ? [canonicalState, nextState]
            .map((state) => state?.messages.find((message) => message.id === stableAgentNoticeId) ?? null)
            .find((message): message is CanonicalSessionMessage => Boolean(message)) ?? null
        : null;
      const existingStableRowContent = existingStableRow ? objectContent(existingStableRow.content) : null;
      const existingStableRowDeliveryState = cleanText(
        typeof existingStableRowContent?.deliveryState === 'string'
          ? existingStableRowContent.deliveryState
          : null,
      ).toLowerCase();
      const existingStableRowStatus = (existingStableRow?.status || '').trim().toLowerCase();
      const existingStableRowTerminalLocked = existingStableRow
        ? ['cancelled', 'complete'].includes(existingStableRowStatus)
          || ['cancelled', 'complete'].includes(existingStableRowDeliveryState)
          || (existingStableRow.sourceTransport === 'cloud-group-agent' && existingStableRowDeliveryState === 'failed')
        : false;
      if (existingStableRowTerminalLocked && agentDeliveryState === 'processing') {
        setCanonicalSessionState(nextState);
        return;
      }
      const replacementAgentSlot = existingStableRow ?? responseProcessingSlot;
      const agentStatus = senderIsAgent && agentDeliveryState === 'processing'
        ? 'processing'
        : senderIsAgent && agentDeliveryState === 'failed'
          ? 'failed'
          : senderIsAgent && agentDeliveryState === 'cancelled'
            ? 'cancelled'
            : envelope.message.senderAccountId === account.accountId ? 'sent' : 'received';
      const messageRequest = {
        id: replacementAgentSlot?.id ?? terminalStableAgentNoticeId ?? envelope.message.id,
        sessionId: envelope.groupId,
        senderIdentityId,
        senderRole: senderIsAgent ? 'external-agent' : (envelope.message.senderAccountId === account.accountId ? 'user' : 'person'),
        messageKind: senderIsAgent ? 'agent-turn' : 'text',
        contentText: senderIsAgent && agentDeliveryState === 'failed' ? '' : envelope.message.text,
        content: senderIsAgent ? {
          sender: envelope.message.senderDisplayName?.trim() || 'Kordi',
          timestampMs: envelope.message.createdAtMs,
          deliveryState: agentDeliveryState,
          bridgeConversationId: cloudGroupAgentConversationId(envelope.groupId),
          requestId: messageReplyToId,
          replyToMessageId: messageReplyToId,
          ...(agentDeliveryState === 'failed' ? { error: envelope.message.text || 'Message failed' } : {}),
        } : (mappedAttachments.length > 0 || envelope.message.messageAction) ? {
          ...(mappedAttachments.length > 0 ? { attachments: mappedAttachments } : {}),
          ...(envelope.message.messageAction ? {
            messageAction: envelope.message.messageAction,
            replyToMessageId: envelope.message.messageAction.kind === 'quote'
              ? envelope.message.messageAction.source.sourceMessageId
              : undefined,
          } : {}),
        } : undefined,
        createdAtMs: envelope.message.createdAtMs,
        parentMessageId: senderIsAgent ? messageReplyToId : (envelope.message.messageAction?.kind === 'quote' ? envelope.message.messageAction.source.sourceMessageId : null),
        status: agentStatus,
        sourceTransport: incomingSourceTransport,
        sourceEventId: incomingSourceEventId,
      };
      // Replay can overlap with the local owner writing the same stable agent
      // slot. Always use the compact idempotent path so a stale renderer
      // snapshot cannot turn that overlap into a duplicate primary-key insert.
      const persistedMessage = await upsertCanonicalMessageFast(messageRequest);
      nextState = mergeCanonicalMessageRow(nextState, persistedMessage) ?? nextState;
      // Race guard: if the local offline-timer effect added the offline-tier
      // placeholder AFTER we captured canonicalSessionState above (which can
      // happen when the response arrives in the same cloud-poll batch as the
      // mention), replacementAgentSlot was absent and we just wrote a
      // separate row under envelope.message.id. Strip any orphan offline-tier
      // placeholder for this request from `nextState` before applying it so
      // the agent reply slot ends up with a single row instead of two
      // ("Processing…" + the real response).
      if (senderIsAgent && messageReplyToId) {
        const offlinePlaceholderId = `msg:cloud-agent-offline:${messageReplyToId}:${envelope.message.senderAccountId}`;
        if (agentDeliveryState === 'processing') {
          nextState = removeCloudGroupOfflinePlaceholder(nextState, offlinePlaceholderId) ?? nextState;
        } else {
          nextState = removeCloudGroupPendingRowsForTerminalResponse(nextState, messageReplyToId, envelope.message.senderAccountId) ?? nextState;
        }
      }
      setCanonicalSessionState(nextState);
    }

    if (messageAlreadyExists && senderIsAgent && messageReplyToId && agentDeliveryState !== 'processing') {
      const offlinePlaceholderId = `msg:cloud-agent-offline:${messageReplyToId}:${envelope.message.senderAccountId}`;
      const cleanedState = removeCloudGroupPendingRowsForTerminalResponse(nextState, messageReplyToId, envelope.message.senderAccountId)
        ?? removeCloudGroupTimeoutPlaceholderForTerminalResponse(nextState, offlinePlaceholderId)
        ?? nextState;
      if (cleanedState !== nextState) {
        nextState = cleanedState;
        setCanonicalSessionState(nextState);
      }
    }

    const groupMessageMentionsLocalAgent = cloudGroupMessageTargetsLocalAgent(envelope.message, account);
    if (
      !senderIsAgent
      && groupMessageMentionsLocalAgent
      && isRecentCloudAgentMention(cloudMessage.createdAt)
      && !processedCloudAgentMentionIdsRef.current.has(envelope.message.id)
    ) {
      const currentCloudMessageIndex = cloudMessageIndexRef.current;
      if (cloudGroupLocalAgentRequestAlreadyHandled({
        localAccountId: account.accountId,
        requestMessageId: envelope.message.id,
        groupRows: currentCloudMessageIndex.groupRows,
      }) || cloudGroupAgentResponseExistsForRequest({
        localAccountId: account.accountId,
        requestMessageId: envelope.message.id,
        groupRows: currentCloudMessageIndex.groupRows,
      })) {
        processedCloudAgentMentionIdsRef.current.add(envelope.message.id);
        return;
      }
      processedCloudAgentMentionIdsRef.current.add(envelope.message.id);
      void (async () => {
        const session = await loadSession();
        if (!session?.token) throw new Error('Not signed in.');
        const targetAccountIds = cloudGroupAgentResponseTargetAccountIds({
          localAccountId: account.accountId,
          envelope,
          requestCloudMessage: cloudMessage,
        });
        const latestTargetMessages = (await Promise.all(
          targetAccountIds.map((targetAccountId) => client.listMessages(session.token, targetAccountId, 100).catch(() => [])),
        )).flat();
        if (await cloudFallbackRunAlreadyOwnsRequest({ client, token: session.token, requestMessageId: envelope.message!.id })
          || cloudGroupAgentResponseExistsForRequest({
            localAccountId: account.accountId,
            requestMessageId: envelope.message!.id,
            messages: latestTargetMessages,
            groupRows: currentCloudMessageIndex.groupRows,
          })) {
          void syncCloudBridgeDiff();
          return;
        }
        const hostedAgentName = cleanText(envelope.message!.targetCloudAgentName);
        const hostedAgentOwnerName = cleanText(envelope.message!.targetCloudAgentOwnerName)
          || cleanText(account.displayName)
          || cleanText(account.primaryEmail)
          || 'Cloud user';
        const agentIdentityId = `agent:cloud:${account.accountId}`;
        const agentDisplayName = hostedAgentName || `${hostedAgentOwnerName}'s Kordi`;
        const agentIdentity = await upsertCanonicalIdentityFast({
          id: agentIdentityId,
          kind: 'agent',
          displayName: agentDisplayName,
          ownerIdentityId: localHumanIdentityId,
          source: 'local',
          sourceHostId: 'cloud',
          bridgeNodeId: `cloud-agent:${account.accountId}`,
          humanId: account.accountId,
          agentId: `cloud-agent:${account.accountId}`,
          avatarKey: `cloud-agent:${account.accountId}`,
          profileImageUrl: null,
          metadata: { accountId: account.accountId, cloudGroupAgent: true },
        });
        setCanonicalSessionState((current) => upsertCanonicalIdentityIntoLocalState(current, agentIdentity));
        const processingMessageId = `msg:cloud-agent-processing:${envelope.message!.id}:${account.accountId}`;
        const processingCreatedAtMs = Date.now();
        const processingRequest = {
          id: processingMessageId,
          sessionId: envelope.groupId,
          senderIdentityId: agentIdentityId,
          senderRole: 'owned-agent',
          messageKind: 'agent-turn',
          contentText: 'processing...',
          content: {
            sender: agentDisplayName,
            timestampMs: processingCreatedAtMs,
            deliveryState: 'processing',
            bridgeConversationId: cloudGroupAgentConversationId(envelope.groupId),
            requestId: envelope.message!.id,
            replyToMessageId: envelope.message!.id,
          },
          createdAtMs: processingCreatedAtMs,
          parentMessageId: envelope.message!.id,
          status: 'processing',
          sourceTransport: 'cloud-group-agent',
          sourceEventId: `cloud-group-agent:${processingMessageId}`,
        } satisfies AppendCanonicalMessageRequest;
        await upsertCanonicalMessageFast(processingRequest);
        setCanonicalSessionState((current) => upsertCanonicalRequestIntoLocalState(current, processingRequest));
        const processingBody = encodeCloudGroupControl({
          kind: 'group-message',
          groupId: envelope.groupId,
          groupSpaceId,
          groupTitle: null,
          createdByAccountId: envelope.createdByAccountId,
          actor: cloudGroupSelfParticipant(account, 'person'),
          participants: [...participantByAccount.values()],
          message: {
            id: processingMessageId,
            senderAccountId: account.accountId,
            text: 'processing...',
            createdAtMs: processingCreatedAtMs,
            senderKind: 'agent',
            senderDisplayName: agentDisplayName,
            deliveryState: 'processing',
            replyToMessageId: envelope.message!.id,
            requestId: envelope.message!.id,
          },
        });
        const processingSent = await Promise.allSettled(
          targetAccountIds.map((targetAccountId) => client.sendMessage(session.token, targetAccountId, processingBody, {
            sessionId: envelope.groupId,
            clientCreatedAt: new Date(processingCreatedAtMs).toISOString(),
          })),
        );
        processingSent.forEach((result) => {
          if (result.status === 'fulfilled') mergeMessage(result.value);
        });
        const prompt = promptTextForCloudAgentMention(envelope.message!.text);
        const contextMessages = [
          ...cloudAgentContextMessagesFromDefinition(cloudAgentDefinitionsById[envelope.message!.targetCloudAgentId ?? ''] ?? null),
          ...cloudGroupNativeContextMessages({
            groupRows: currentCloudMessageIndex.groupRows,
            groupId: envelope.groupId,
            requestMessageId: envelope.message!.id,
            requestCreatedAtMs: envelope.message!.createdAtMs,
          }),
        ];
        const visibleTaskRecords = cloudVisibleTaskRecordsForSession(cloudSessionActivityRef.current, envelope.groupId);
        const agentAttachmentPaths = mappedAttachments
          .map((attachment) => attachment.localPath?.trim() || '')
          .filter(Boolean);
        const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
          setLocalAgentTurnsByRequestId((current) => ({ ...current, [envelope.message!.id]: turn }));
        };
        const runtimeSessionId = `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${account.accountId}:${envelope.groupId}`;
        const runtimeRoute = cloudAgentRuntimeRouteForTargetCloudAgent({
          targetCloudAgentId: envelope.message!.targetCloudAgentId,
          cloudAgentDefinitionsById,
          routesByRuntimeSessionId: cloudAgentRuntimeRoutesBySessionId,
          runtimeSessionId,
          fallbackRoute: defaultCloudAgentRuntimeRoute,
        });
        const startedTurn = await startDesktopChatMessage(
          runtimeSessionId,
          prompt,
          agentAttachmentPaths,
          runtimeRoute,
          contextMessages,
          visibleTaskRecords,
          envelope.groupId,
        );
        rememberLocalTurn(startedTurn);
        cloudAgentTurnIdsByRequestIdRef.current.set(envelope.message!.id, startedTurn.id);
        const finalTurn = startedTurn.completed ? startedTurn : await waitForCloudAgentTurn(startedTurn.id, rememberLocalTurn);
        rememberLocalTurn(finalTurn);
        cloudAgentTurnIdsByRequestIdRef.current.delete(envelope.message!.id);
        if (finalTurn.status === 'cancelled') return;
        await publishDerivedCloudSessionActivity({
          client,
          token: session.token,
          accountId: account.accountId,
          sessionId: envelope.groupId,
          participantAccountIds: [...participantByAccount.keys()],
          participantProfiles: [...participantByAccount.values()].map((participant) => ({
            accountId: participant.accountId,
            displayName: participant.displayName,
            avatarUrl: participant.avatarUrl,
            role: participant.role,
          })),
          turn: finalTurn,
          mergeActivity: (snapshot) => setCloudSessionActivity((current) => mergeCloudSessionActivity(current, snapshot)),
        });
        // When the local agent turn fails (e.g. provider overload after retries),
        // surface the failure as a structured `failed` agent-turn instead of
        // wrapping the error as `Failed: <error>` plain text. The receive-side
        // handler at line 1030 already understands `deliveryState: 'failed'` —
        // it writes `contentText: ''` + `content.error` so the read model
        // renders only the red error block. Mirror that here so the agent
        // owner's view matches the peers' view.
        const succeeded = finalTurn.succeeded && finalTurn.assistantText.trim().length > 0;
        const failureMessage = succeeded
          ? null
          : isCloudAgentNoProviderConfiguredError(finalTurn.error || finalTurn.message)
            ? cloudAgentNoProviderNoticeText()
            : (finalTurn.error?.trim()
                || finalTurn.message?.trim()
                || 'Cloud agent returned no text response');
        const responseDeliveryState: 'complete' | 'failed' = succeeded ? 'complete' : 'failed';
        const responseContentText = succeeded ? finalTurn.assistantText.trim() : '';
        const responseEnvelopeText = succeeded ? finalTurn.assistantText.trim() : (failureMessage ?? '');
        const finalLatestTargetMessages = (await Promise.all(
          targetAccountIds.map((targetAccountId) => client.listMessages(session.token, targetAccountId, 100).catch(() => [])),
        )).flat();
        if (await cloudFallbackRunAlreadyOwnsRequest({ client, token: session.token, requestMessageId: envelope.message!.id })
          || cloudGroupAgentResponseExistsForRequest({
            localAccountId: account.accountId,
            requestMessageId: envelope.message!.id,
            messages: finalLatestTargetMessages,
            groupRows: currentCloudMessageIndex.groupRows,
          })) {
          void syncCloudBridgeDiff();
          return;
        }
        const responseMessageId = `msg:cloud-agent:${finalTurn.id}`;
        const responseCreatedAtMs = Date.now();
        // Overwrite the local "Processing…" row in place rather than appending
        // a new row at responseMessageId. The previous behavior left a stale
        // processing row that stayed visible as "Processing…" forever — user1's
        // DB had accumulated 10+ of these. Reusing processingMessageId via
        // upsert keeps the agent-owner side as exactly one row per request.
        // The broadcast envelope still carries responseMessageId so peers can
        // dedup separately from the intermediate processing envelope; the
        // own-round-trip guard in the receive-side handler suppresses
        // duplicate writes when this envelope comes back via cloud polling.
        const responseRequest = {
          id: processingMessageId,
          sessionId: envelope.groupId,
          senderIdentityId: agentIdentityId,
          senderRole: 'owned-agent',
          messageKind: 'agent-turn',
          contentText: responseContentText,
          content: {
            sender: agentDisplayName,
            timestampMs: responseCreatedAtMs,
            deliveryState: responseDeliveryState,
            bridgeConversationId: cloudGroupAgentConversationId(envelope.groupId),
            requestId: envelope.message!.id,
            replyToMessageId: envelope.message!.id,
            ...(failureMessage ? { error: failureMessage } : {}),
          },
          createdAtMs: responseCreatedAtMs,
          parentMessageId: envelope.message!.id,
          status: responseDeliveryState,
          sourceTransport: 'cloud-group-agent',
          sourceEventId: `cloud-group-agent:${responseMessageId}`,
        } satisfies AppendCanonicalMessageRequest;
        await upsertCanonicalMessageFast(responseRequest);
        const offlinePlaceholderId = `msg:cloud-agent-offline:${envelope.message!.id}:${account.accountId}`;
        setCanonicalSessionState((current) => {
          const responseStateBeforeCleanup = upsertCanonicalRequestIntoLocalState(current, responseRequest);
          if (!responseStateBeforeCleanup) return responseStateBeforeCleanup;
          return removeCloudGroupPendingRowsForTerminalResponse(responseStateBeforeCleanup, envelope.message!.id, account.accountId)
            ?? removeCloudGroupTimeoutPlaceholderForTerminalResponse(responseStateBeforeCleanup, offlinePlaceholderId)
            ?? responseStateBeforeCleanup;
        });
        const responseBody = encodeCloudGroupControl({
          kind: 'group-message',
          groupId: envelope.groupId,
          groupSpaceId,
          groupTitle: null,
          createdByAccountId: envelope.createdByAccountId,
          actor: cloudGroupSelfParticipant(account, 'person'),
          participants: [...participantByAccount.values()],
          message: {
            id: responseMessageId,
            senderAccountId: account.accountId,
            text: responseEnvelopeText,
            createdAtMs: responseCreatedAtMs,
            senderKind: 'agent',
            senderDisplayName: agentDisplayName,
            deliveryState: responseDeliveryState,
            replyToMessageId: envelope.message!.id,
            requestId: envelope.message!.id,
          },
        });
        const sent = await Promise.allSettled(
          targetAccountIds.map((targetAccountId) => client.sendMessage(session.token, targetAccountId, responseBody, {
            sessionId: envelope.groupId,
            clientCreatedAt: new Date(responseCreatedAtMs).toISOString(),
          })),
        );
        sent.forEach((result) => {
          if (result.status === 'fulfilled') mergeMessage(result.value);
        });
        void syncCloudBridgeDiff();
      })().catch((error) => {
        cloudAgentTurnIdsByRequestIdRef.current.delete(envelope.message!.id);
        if (isCloudAgentNoProviderConfiguredError(error)) {
          const responseCreatedAtMs = Date.now();
          const processingMessageId = `msg:cloud-agent-processing:${envelope.message!.id}:${account.accountId}`;
          const responseMessageId = `msg:cloud-agent-no-provider:${envelope.message!.id}:${account.accountId}`;
          const hostedAgentName = cleanText(envelope.message!.targetCloudAgentName);
          const hostedAgentOwnerName = cleanText(envelope.message!.targetCloudAgentOwnerName)
            || cleanText(account.displayName)
            || cleanText(account.primaryEmail)
            || 'Cloud user';
          const agentDisplayName = hostedAgentName || `${hostedAgentOwnerName}'s Kordi`;
          void (async () => {
            const failedResponseRequest = {
              id: processingMessageId,
              sessionId: envelope.groupId,
              senderIdentityId: `agent:cloud:${account.accountId}`,
              senderRole: 'owned-agent',
              messageKind: 'agent-turn',
              contentText: '',
              content: {
                sender: agentDisplayName,
                timestampMs: responseCreatedAtMs,
                deliveryState: 'failed',
                bridgeConversationId: cloudGroupAgentConversationId(envelope.groupId),
                requestId: envelope.message!.id,
                replyToMessageId: envelope.message!.id,
                error: cloudAgentNoProviderNoticeText(),
              },
              createdAtMs: responseCreatedAtMs,
              parentMessageId: envelope.message!.id,
              status: 'failed',
              sourceTransport: 'cloud-group-agent',
              sourceEventId: `cloud-group-agent-no-provider:${envelope.message!.id}:${account.accountId}`,
            } satisfies AppendCanonicalMessageRequest;
            await upsertCanonicalMessageFast(failedResponseRequest);
            setCanonicalSessionState((current) => upsertCanonicalRequestIntoLocalState(current, failedResponseRequest));
            const session = await loadSession();
            if (!session?.token) return;
            const targetAccountIds = cloudGroupAgentResponseTargetAccountIds({
              localAccountId: account.accountId,
              envelope,
              requestCloudMessage: cloudMessage,
            });
            const responseBody = encodeCloudGroupControl({
              kind: 'group-message',
              groupId: envelope.groupId,
              groupSpaceId,
              groupTitle: null,
              createdByAccountId: envelope.createdByAccountId,
              actor: cloudGroupSelfParticipant(account, 'person'),
              participants: [...participantByAccount.values()],
              message: {
                id: responseMessageId,
                senderAccountId: account.accountId,
                text: cloudAgentNoProviderNoticeText(),
                createdAtMs: responseCreatedAtMs,
                senderKind: 'agent',
                senderDisplayName: agentDisplayName,
                deliveryState: 'failed',
                replyToMessageId: envelope.message!.id,
                requestId: envelope.message!.id,
              },
            });
            const sent = await Promise.allSettled(
              targetAccountIds.map((targetAccountId) => client.sendMessage(session.token, targetAccountId, responseBody, {
                sessionId: envelope.groupId,
                clientCreatedAt: new Date(responseCreatedAtMs).toISOString(),
              })),
            );
            sent.forEach((result) => {
              if (result.status === 'fulfilled') mergeMessage(result.value);
            });
            void syncCloudBridgeDiff();
          })().catch((saveError) => {
            processedCloudAgentMentionIdsRef.current.delete(envelope.message!.id);
            // eslint-disable-next-line no-console
            console.warn('[cloud-group-agent-mention] no-provider notice failed', saveError);
          });
          return;
        }
        processedCloudAgentMentionIdsRef.current.delete(envelope.message!.id);
        // eslint-disable-next-line no-console
        console.warn('[cloud-group-agent-mention] local agent response failed', error);
      });
    }
  }, [
    account,
    activeConversationId,
    client,
    cloudAgentDefinitionsById,
    cloudAgentRuntimeRoutesBySessionId,
    defaultCloudAgentRuntimeRoute,
    mergeMessage,
    syncCloudBridgeDiff,
    setCanonicalSessionState,
  ]);

  const mergeMessageRef = useRef(mergeMessage);
  const syncCloudBridgeDiffRef = useRef(syncCloudBridgeDiff);
  useEffect(() => { mergeMessageRef.current = mergeMessage; }, [mergeMessage]);
  useEffect(() => { syncCloudBridgeDiffRef.current = syncCloudBridgeDiff; }, [syncCloudBridgeDiff]);

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
        if (sentAny) await syncCloudBridgeDiffRef.current?.();
      } catch (error) {
        // Keep the persisted recipients queued; focus/online/timer will resume.
        // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
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
            void syncCloudBridgeDiffRef.current?.();
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
          void syncCloudBridgeDiffRef.current?.();
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[cloud-bridge-ws] frame parse failed', error);
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
        // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
      console.warn('[cloud-provider-auth-sync] publish failed', error);
    });
    return () => {
      cancelled = true;
    };
  }, [account, client, defaultCloudAgentRuntimeRoute, initialMessagesSettled]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const claims = cloudFallbackRunClaimsForMessages({ account, contacts: contacts.contacts, messageIndex: cloudMessageIndex })
      .filter((claim) => !claimedCloudFallbackRunKeysRef.current.has(claim.idempotencyKey));
    if (claims.length === 0) return;
    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (!session?.token) return;
      for (const claim of claims) {
        if (cancelled) return;
        await claimCloudFallbackRun(claim, session.token);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, claimCloudFallbackRun, cloudMessageIndex, contacts.contacts, initialMessagesSettled]);

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
            // eslint-disable-next-line no-console
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
          // eslint-disable-next-line no-console
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
          candidate.bridgePeerNodeId || candidate.id.replace(/^cloud:/, '')
        ) === peerId);
        const peerHumanName = contact?.name?.trim() || contact?.owner?.trim() || peerId;
        const activitySessionId = message.sessionId ?? cloudSessionIdForBridgeSend(account.accountId, peerId, `cloud:${peerId}`);
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
            // eslint-disable-next-line no-console
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
            // eslint-disable-next-line no-console
            console.warn('[cloud-agent-mention] local agent response failed', error);
          } finally {
            cloudAgentTurnIdsByRequestIdRef.current.delete(message.messageId);
          }

          if (finalTurn.status === 'cancelled') {
            void syncCloudBridgeDiff();
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
              void syncCloudBridgeDiff();
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
            void syncCloudBridgeDiff();
          } catch (error) {
            // The local turn is already terminal and visible. A Cloud publish
            // failure must not rerun the model or return the UI to Processing.
            // eslint-disable-next-line no-console
            console.warn('[cloud-agent-mention] response publish failed', error);
          }
        })();
      }
    }
  }, [account, client, cloudAgentRuntimeRoutesBySessionId, cloudLookupContacts, cloudMessageIndex, defaultCloudAgentRuntimeRoute, initialMessagesSettled, mergeMessage, setCanonicalSessionState, syncCloudBridgeDiff]);

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
          void syncCloudBridgeDiff();
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
        void syncCloudBridgeDiff();
      })
      .catch(() => {
        readReceiptRequestRef.current = null;
      });
  }, [account, activeConversationId, client, cloudMessageIndex, messagesByPeer, setCanonicalSessionState, syncCloudBridgeDiff]);

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
      // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
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
      void syncCloudBridgeDiff();
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
  }, [account, syncCloudBridgeDiff]);

  const cloudBridgeState = useMemo(() => {
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
    const previousState = cloudBridgePreviousStateForContext(
      cloudBridgeStateRef.current,
      cloudBridgeStateContextKeyRef.current,
      cloudBridgeAccountContextKey,
    );
    const generated = buildCloudDesktopBridgeState({
      account,
      contacts: cloudBridgeContacts,
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
    const currentOverride = cloudBridgePreviousStateForContext(
      cloudBridgeOverride,
      cloudBridgeOverrideContextKeyRef.current,
      cloudBridgeAccountContextKey,
    );
    const routed = applyCloudAgentRuntimeRouteToState(currentOverride ?? generated, activeRuntimeRoute);
    return initialMessagesSettled ? routed : suppressCloudBridgeUnreadCounts(routed);
  }, [
    account,
    activeConversationId,
    cloudAgentRuntimeRoutesBySessionId,
    defaultCloudAgentRuntimeRoute,
    canonicalSessionState,
    cloudBridgeOverride,
    cloudBridgeContacts,
    cloudDeletedSessionIds,
    cloudHiddenSessionIds,
    cloudBridgeAccountContextKey,
    localAgentTurnsByRequestId,
    initialMessagesSettled,
    cloudMessageIndex,
    currentAccountMessagesByPeer,
    readInboundMessageIdsByPeer,
  ]);

  useEffect(() => {
    cloudBridgeStateRef.current = cloudBridgeState;
    cloudBridgeStateContextKeyRef.current = cloudBridgeAccountContextKey;
  }, [cloudBridgeAccountContextKey, cloudBridgeState]);

  const setCloudBridgeState = useCallback<Dispatch<SetStateAction<DesktopBridgeState | null>>>((action) => {
    const current = cloudBridgePreviousStateForContext(
      cloudBridgeStateRef.current,
      cloudBridgeStateContextKeyRef.current,
      cloudBridgeAccountContextKey,
    );
    const next = typeof action === 'function'
      ? (action as (value: DesktopBridgeState | null) => DesktopBridgeState | null)(current)
      : action;
    cloudBridgeOverrideContextKeyRef.current = cloudBridgeAccountContextKey;
    setCloudBridgeOverrideState(next);
  }, [cloudBridgeAccountContextKey]);

  const mergedBridgeState = cloudBridgeState;
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

  const sendCloudBridgeMessage = useCallback(async (
    conversationId: string,
    text: string,
    attachments: AttachmentItem[] = [],
    options: SendCloudBridgeMessageOptions = {},
  ) => {
    const peerId = cloudPeerAccountIdFromConversationId(conversationId);
    const trimmed = text.trim();
    if (!peerId || (!trimmed && attachments.length === 0)) throw new Error('Unable to resolve cloud conversation.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const uploadedAttachments = attachments.length > 0
      ? await uploadComposerAttachments({ token: session.token, client, attachments })
      : [];
    const cloudSessionId = cloudSessionIdForBridgeSend(account?.accountId, peerId, conversationId);
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
      || input.bridgeParticipants !== undefined;
    const inputParticipants = input.participants?.length
      ? input.participants
      : cloudGroupParticipantsForBridgeSessionParticipants(account, input.bridgeParticipants ?? []);
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
          // eslint-disable-next-line no-console
          console.warn('[cloud-group-outbox] failed to persist delivery status', error);
        });
      }
      if (sentAny) {
        await Promise.all([
          claimFreshCloudGroupFallback(sentMessages, canonicalMessageId, session.token),
          syncCloudBridgeDiff().catch(() => {}),
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
          syncCloudBridgeDiff(),
        ]);
        return;
      }
      await syncCloudBridgeDiff();
      return;
    }
    const firstFailure = firstCloudGroupSendFailure(results);
    throw firstFailure instanceof Error ? firstFailure : new Error(String(firstFailure || 'Group message failed.'));
  }, [account, claimFreshCloudGroupFallback, client, cloudGroupOutbox, cloudMessageIndex, mergeMessage, persistCloudGroupOutboxDelivery, syncCloudBridgeDiff]);

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
        || cleanText(creatorIdentity?.bridgeNodeId)
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
        // eslint-disable-next-line no-console
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
    void syncCloudBridgeDiffRef.current?.();
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

  const cancelCloudBridgeAgentRequest = useCallback(async (conversationId: string, requestId: string) => {
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
      await syncCloudBridgeDiff();
      setCloudBridgeOverrideState(null);
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
    await syncCloudBridgeDiff();
    setCloudBridgeOverrideState(null);
  }, [account, canonicalSessionState?.messages, client, cloudMessageIndex, mergeMessage, setCanonicalSessionState, syncCloudBridgeDiff]);

  return {
    cloudBridgeState,
    setCloudBridgeState,
    mergedBridgeState,
    prepareCloudForwardAttachments,
    sendCloudBridgeMessage,
    sendCloudGroupControl,
    recordCloudSessionFork,
    updateCloudSessionPin,
    hideCloudSession,
    unhideCloudSession,
    deleteCloudSession,
    cancelCloudBridgeAgentRequest,
    refreshCloudBridgeMessages,
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
    refreshCloudContacts: contacts.refresh,
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
