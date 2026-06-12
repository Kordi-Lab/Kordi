import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AttachmentItem } from '@/features/chat/composerController.types';

import {
  adoptCloudProfileIdentity,
  appendCanonicalMessage,
  buildDesktopCloudProviderAuthSnapshotPayload,
  cancelDesktopChatTurn,
  fetchDesktopChatTurnState,
  fetchCanonicalSessionState,
  openOrCreateCanonicalSession,
  renameCanonicalSession,
  startDesktopChatMessage,
  upsertCanonicalIdentity,
  upsertCanonicalMessage,
  type DesktopChatContextMessage,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import type {
  AppendCanonicalMessageRequest,
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
  OpenCanonicalSessionRequest,
  UpsertCanonicalIdentityRequest,
  Contact,
  DesktopBridgeSessionParticipant,
  DesktopBridgeState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
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
  type CloudSessionForkSummary,
  type CloudSessionPin,
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
  cloudAgentRuntimeSessionId,
} from './cloudAgentRuntime';
import { cloudProviderAuthSnapshotRouteSignature } from './providerAuthSnapshot';
import {
  cloudGroupAgentConversationId,
  cloudGroupAgentMentionResponseState,
  cloudGroupAgentRequestingNoticeMessage,
  cloudGroupAgentRequestingNoticeRequest,
  cloudGroupForkPayloadFromSessionMetadata,
  cloudGroupAgentResponseTargetAccountIds,
  cloudGroupControlMessagesForAccount,
  cloudGroupControlReplayKey,
  cloudGroupDeliveryStateFromMessages,
  cloudGroupReadReceiptSummaryFromMessages,
  cloudGroupIdFromAgentConversationId,
  cloudGroupIdentityRequest,
  cloudGroupLocalAgentRequestAlreadyHandled,
  cloudGroupMessageReadTargets,
  cloudGroupParticipantsForBridgeSessionParticipants,
  cloudGroupPeerIdsFromContactsAndRequests,
  cloudGroupPeerIdsFromMessages,
  cloudGroupParticipantsWithProfiles,
  cloudGroupSelfParticipant,
  cloudGroupTitleForOutgoingControl,
  cloudGroupTitleUpdateNoticeRequest,
  cloudGroupUnreadCountsBySessionId,
  cloudSessionTitleUpdateNoticeRequest,
  cloudSessionTitleUpdateTitle,
  cloudGroupUniqueParticipants,
  cloudGroupRelatedControlsForSend,
  cloudGroupNonGenericTitle,
  encodeCloudGroupControl,
  firstCloudGroupSendFailure,
  fulfilledCloudGroupSends,
  parseCloudGroupControl,
  shouldApplyCloudGroupTitleUpdate,
  shouldCountCloudGroupMessageUnread,
  type CloudGroupControlEnvelope,
  type CloudGroupParticipant,
} from './cloudGroupMessages';
import { uploadComposerAttachments, cloudMessageAttachmentToMessageAttachment, resolveCloudMessageAttachments } from './cloudAttachments';
import { loadCloudSessionVisibility, removeCloudSessionMessages, saveCloudSessionVisibility, syncCloudDiffOnce, type CloudSessionPinsById } from './cloudDiffSync';
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
export const CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS = 5_000;

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

export type CloudGroupAgentCancelRole = 'sender' | 'agent owner' | 'participant';

export function cloudGroupAgentCancelledNoticeRequest({
  processingMessage,
  requestId,
  conversationId,
  cancelledByAccountId,
  cancelledByRole,
  now = Date.now(),
}: {
  processingMessage: CanonicalSessionMessage;
  requestId: string;
  conversationId: string;
  cancelledByAccountId: string;
  cancelledByRole: CloudGroupAgentCancelRole;
  now?: number;
}): AppendCanonicalMessageRequest {
  const content = objectContent(processingMessage.content);
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
      timestampMs: now,
      deliveryState: 'cancelled',
      bridgeConversationId: conversationId,
      requestId: trimmedRequestId,
      replyToMessageId: trimmedRequestId,
      cancelledByAccountId: trimmedCancelledByAccountId,
      cancelledByRole: role,
    },
    createdAtMs: now,
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
      if (!targetAccountId || targetAccountId === accountId) return [];
      const humanIdentity = identityByHumanId.get(targetAccountId);
      const agentIdentity = identityById.get(`agent:cloud:${targetAccountId}`);
      const targetHumanDisplayName = cleanText(humanIdentity?.displayName)
        || cleanText(typeof mention.label === 'string' ? mention.label.replace(/'?sKordi$/u, '') : null)
        || targetAccountId;
      const targetAgentDisplayName = cleanText(agentIdentity?.displayName) || `${targetHumanDisplayName}'s Kordi`;
      return [{ requestMessage: message, targetAccountId, targetHumanDisplayName, targetAgentDisplayName }];
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

function cloudGroupAgentNoProviderFallbackRequest(input: {
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
      error: cloudAgentNoProviderNoticeText(),
    },
    parentMessageId: requestMessageId,
    status: 'failed',
    createdAtMs,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: `cloud-group-agent-no-provider-timeout:${requestMessageId}:${targetAccountId}`,
  };
}

function removeCloudGroupOfflinePlaceholder(
  current: CanonicalSessionState | null,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter((message) => !cloudGroupOfflinePlaceholderMatches(message, noticeId));
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
  peerMessages: CloudMessage[];
}): boolean {
  return peerMessages.some((candidate) => (
    candidate.fromAccountId === account.accountId
    && parseCloudAgentResponse(candidate.body)?.requestId === requestMessageId
  ));
}

export function cloudGroupAgentResponseExistsForRequest({
  localAccountId,
  requestMessageId,
  messages,
}: {
  localAccountId: string;
  requestMessageId: string;
  messages: CloudMessage[];
}): boolean {
  const trimmedLocalAccountId = localAccountId.trim();
  const trimmedRequestMessageId = requestMessageId.trim();
  if (!trimmedLocalAccountId || !trimmedRequestMessageId) return false;
  return messages.some((candidate) => {
    const envelope = parseCloudGroupControl(candidate.body);
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

export function shouldRunLocalCloudAgentForCloudMessage({
  account,
  peerId,
  message,
  peerMessages,
}: {
  account: CloudAccount;
  peerId: string;
  message: CloudMessage;
  peerMessages: CloudMessage[];
}): boolean {
  if (peerId === account.accountId) return false;
  if (message.fromAccountId !== account.accountId && message.toAccountId !== account.accountId) return false;
  if (parseCloudGroupControl(message.body) || parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) return false;
  if (!cloudMessageMentionsLocalAgent(message.body, account, {
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
  message,
  ownerAccountId,
}: {
  account: CloudAccount;
  contact: Contact | undefined;
  message: CloudMessage;
  ownerAccountId: string;
}): string | null {
  if (parseCloudGroupControl(message.body) || parseCloudAgentCancel(message.body)) return null;
  const agentResponse = parseCloudAgentResponse(message.body);
  const text = agentResponse?.text
    ?? (message.fromAccountId === account.accountId && cloudMessageMentionsContactAgent(message, contact)
      ? promptTextForCloudAgentMention(message.body)
      : message.body);
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
}: {
  account: CloudAccount;
  contact: Contact | undefined;
  message: CloudMessage;
  ownerAccountId: string;
  peerMessages: CloudMessage[];
}): string {
  const currentPrompt = promptTextForCloudAgentMention(message.body);
  const requestIndex = peerMessages.findIndex((candidate) => candidate.messageId === message.messageId);
  const previousMessages = (requestIndex >= 0 ? peerMessages.slice(0, requestIndex) : peerMessages)
    .filter((candidate) => candidate.messageId !== message.messageId);
  const history = previousMessages
    .map((candidate) => cloudFallbackHistoryLine({ account, contact, message: candidate, ownerAccountId }))
    .filter((line): line is string => Boolean(line))
    .slice(-MAX_CLOUD_FALLBACK_HISTORY_MESSAGES);
  if (history.length === 0) return currentPrompt;
  return `Conversation history:\n${history.join('\n')}\n\nCurrent request:\n${currentPrompt}`;
}

function cloudGroupFallbackHistoryLine(envelope: CloudGroupControlEnvelope): string | null {
  if (envelope.kind !== 'group-message' || !envelope.message) return null;
  const message = envelope.message;
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
  cloudMessages,
  groupId,
  requestMessageId,
  requestCreatedAtMs,
  requestText,
}: {
  cloudMessages: CloudMessage[];
  groupId: string;
  requestMessageId: string;
  requestCreatedAtMs: number;
  requestText: string;
}): string {
  const currentPrompt = promptTextForCloudAgentMention(requestText);
  const seenMessageIds = new Set<string>();
  const history = cloudMessages
    .flatMap((cloudMessage) => {
      const envelope = parseCloudGroupControl(cloudMessage.body);
      if (envelope?.kind !== 'group-message' || envelope.groupId !== groupId || !envelope.message) return [];
      if (envelope.message.id === requestMessageId) return [];
      if (envelope.message.createdAtMs > requestCreatedAtMs) return [];
      if (envelope.message.forkSnapshot === true) return [];
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
  messagesByPeer,
}: {
  account: CloudAccount;
  contacts: Contact[];
  messagesByPeer: Record<string, CloudMessage[]>;
}): CloudAgentRunClaimInput[] {
  const contactByPeerId = new Map(contacts.map((contact) => [cloudContactPeerAccountId(contact), contact]));
  const claims: CloudAgentRunClaimInput[] = [];
  const allCloudMessages = Object.values(messagesByPeer).flat().sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const [peerId, peerMessages] of Object.entries(messagesByPeer)) {
    const ownerAccountId = peerId.trim();
    if (!ownerAccountId || ownerAccountId === account.accountId) continue;
    const contact = contactByPeerId.get(ownerAccountId);
    for (const message of peerMessages) {
      if (message.fromAccountId !== account.accountId || message.toAccountId !== ownerAccountId) continue;
      const groupEnvelope = parseCloudGroupControl(message.body);
      if (groupEnvelope?.kind === 'group-message' && groupEnvelope.message?.senderAccountId === account.accountId) {
        const groupMessage = groupEnvelope.message;
        const groupRequestMessage = { ...message, body: groupMessage.text };
        if (!cloudMessageMentionsContactAgent(groupRequestMessage, contact)) continue;
        const alreadyTerminal = allCloudMessages.some((candidate) => {
          const envelope = parseCloudGroupControl(candidate.body);
          return envelope?.kind === 'group-message'
            && envelope.groupId === groupEnvelope.groupId
            && envelope.message?.senderKind === 'agent'
            && envelope.message.senderAccountId === ownerAccountId
            && (envelope.message.requestId === groupMessage.id || envelope.message.replyToMessageId === groupMessage.id)
            && envelope.message.deliveryState !== 'processing';
        });
        if (alreadyTerminal) continue;
        claims.push({
          requestMessageId: groupMessage.id,
          sessionId: groupEnvelope.groupId,
          ownerAccountId,
          requesterAccountId: account.accountId,
          prompt: cloudGroupFallbackRunPromptForMessage({
            cloudMessages: allCloudMessages,
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
      if (!cloudMessageMentionsContactAgent(message, contact)) continue;
      const alreadyTerminal = peerMessages.some((candidate) => (
        parseCloudAgentCancel(candidate.body)?.requestId === message.messageId
        || parseCloudAgentResponse(candidate.body)?.requestId === message.messageId
      ));
      if (alreadyTerminal) continue;
      claims.push({
        requestMessageId: message.messageId,
        sessionId: message.sessionId?.trim() || cloudDirectPersonSessionId(account.accountId, ownerAccountId),
        ownerAccountId,
        requesterAccountId: account.accountId,
        prompt: cloudFallbackRunPromptForMessage({ account, contact, message, ownerAccountId, peerMessages }),
        idempotencyKey: `cloud-agent-fallback:${message.messageId}:${ownerAccountId}`,
      });
    }
  }

  return claims;
}

function isCloudAgentProcessingPlaceholderText(text: string): boolean {
  return /^processing[.\s…]*$/iu.test(text.trim());
}

function cloudGroupNativeContextMessages({
  cloudMessages,
  groupId,
  requestMessageId,
  requestCreatedAtMs,
}: {
  cloudMessages: CloudMessage[];
  groupId: string;
  requestMessageId: string;
  requestCreatedAtMs: number;
}): DesktopChatContextMessage[] {
  return compactCloudAgentNativeContextMessages(cloudMessages.flatMap((cloudMessage) => {
    const envelope = parseCloudGroupControl(cloudMessage.body);
    if (envelope?.kind !== 'group-message' || envelope.groupId !== groupId || !envelope.message) return [];
    const message = envelope.message;
    if (message.id === requestMessageId) return [];
    if (message.createdAtMs > requestCreatedAtMs) return [];
    if (message.forkSnapshot === true) return [];
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

function cloudMessageListsEqual(left: CloudMessage[] = [], right: CloudMessage[] = []): boolean {
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    return Boolean(other)
      && message.messageId === other.messageId
      && message.fromAccountId === other.fromAccountId
      && message.toAccountId === other.toAccountId
      && message.body === other.body
      && message.createdAt === other.createdAt
      && message.deliveredAt === other.deliveredAt
      && message.readAt === other.readAt
      && message.direction === other.direction
      && (message.sessionId ?? null) === (other.sessionId ?? null)
      && cloudMessageAttachmentsEqual(message.attachments, other.attachments);
  });
}

export function cloudMessagesByPeerEqual(
  left: Record<string, CloudMessage[]>,
  right: Record<string, CloudMessage[]>,
): boolean {
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
  for (const peerId of peerIds) {
    const byMessageId = new Map<string, CloudMessage>();
    for (const message of current[peerId] ?? []) byMessageId.set(message.messageId, message);
    for (const message of incoming[peerId] ?? []) {
      const previous = byMessageId.get(message.messageId);
      byMessageId.set(message.messageId, previous ? { ...previous, ...message } : message);
    }
    const messages = [...byMessageId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (messages.length > 0) merged[peerId] = messages;
  }
  return merged;
}

export const CLOUD_MESSAGE_DISCOVERY_MAX_PASSES = 50;
export const CLOUD_MESSAGES_LOCAL_CACHE_PREFIX = 'kordi.cloud.messagesByPeer.v1:';

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

function cloudMessagesCacheKey(accountId: string): string {
  return `${CLOUD_MESSAGES_LOCAL_CACHE_PREFIX}${accountId.trim()}`;
}

function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalizeCachedCloudMessage(value: unknown): CloudMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const messageId = cleanText(typeof record.messageId === 'string' ? record.messageId : null);
  const fromAccountId = cleanText(typeof record.fromAccountId === 'string' ? record.fromAccountId : null);
  const toAccountId = cleanText(typeof record.toAccountId === 'string' ? record.toAccountId : null);
  const createdAt = cleanText(typeof record.createdAt === 'string' ? record.createdAt : null);
  if (!messageId || !fromAccountId || !toAccountId || !createdAt) return null;
  const direction = record.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const attachments = Array.isArray(record.attachments) ? record.attachments as CloudMessage['attachments'] : undefined;
  return {
    messageId,
    fromAccountId,
    toAccountId,
    body: typeof record.body === 'string' ? record.body : '',
    createdAt,
    deliveredAt: typeof record.deliveredAt === 'string' ? record.deliveredAt : null,
    readAt: typeof record.readAt === 'string' ? record.readAt : null,
    direction,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function loadCachedCloudMessagesByPeer(accountId: string | null | undefined, storage: Storage | null = browserLocalStorage()): Record<string, CloudMessage[]> {
  const trimmedAccountId = accountId?.trim() ?? '';
  if (!trimmedAccountId || !storage) return {};
  try {
    const raw = storage.getItem(cloudMessagesCacheKey(trimmedAccountId));
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const byPeer: Record<string, CloudMessage[]> = {};
    for (const [peerId, messages] of Object.entries(parsed)) {
      const trimmedPeerId = peerId.trim();
      if (!trimmedPeerId || !Array.isArray(messages)) continue;
      const normalized = messages.map(normalizeCachedCloudMessage).filter((item): item is CloudMessage => Boolean(item));
      if (normalized.length > 0) byPeer[trimmedPeerId] = normalized;
    }
    return byPeer;
  } catch {
    return {};
  }
}

export function saveCachedCloudMessagesByPeer(accountId: string | null | undefined, messagesByPeer: Record<string, CloudMessage[]>, storage: Storage | null = browserLocalStorage()): void {
  const trimmedAccountId = accountId?.trim() ?? '';
  if (!trimmedAccountId || !storage) return;
  const byPeer: Record<string, CloudMessage[]> = {};
  for (const [peerId, messages] of Object.entries(messagesByPeer)) {
    const trimmedPeerId = peerId.trim();
    if (!trimmedPeerId || messages.length === 0) continue;
    byPeer[trimmedPeerId] = messages;
  }
  try {
    if (Object.keys(byPeer).length === 0) storage.removeItem(cloudMessagesCacheKey(trimmedAccountId));
    else storage.setItem(cloudMessagesCacheKey(trimmedAccountId), JSON.stringify(byPeer));
  } catch {
    // Best effort local backup. Cloud remains authoritative if disk storage is unavailable.
  }
}

export function cachedCloudMessagesByPeerHasMessages(accountId: string | null | undefined, storage: Storage | null = browserLocalStorage()): boolean {
  return Object.values(loadCachedCloudMessagesByPeer(accountId, storage)).some((messages) => messages.length > 0);
}

export function cloudInitialMessagesSettledForPeerKey({
  accountReady,
  contactsSettled,
  currentPeerKey,
  settledPeerKey,
}: {
  accountReady: boolean;
  contactsSettled: boolean;
  currentPeerKey: string;
  settledPeerKey: string | null;
}): boolean {
  if (!accountReady) return true;
  if (!contactsSettled) return false;
  return Boolean(settledPeerKey) && settledPeerKey === currentPeerKey;
}

export async function loadCloudMessagesByPeerUntilStable({
  accountId,
  initialPeerIds,
  existingMessagesByPeer,
  listMessages,
  resolveMessageAttachments = async (messages) => messages,
  maxPasses = CLOUD_MESSAGE_DISCOVERY_MAX_PASSES,
}: {
  accountId: string;
  initialPeerIds: string[];
  existingMessagesByPeer: Record<string, CloudMessage[]>;
  listMessages(peerId: string): Promise<CloudMessage[]>;
  resolveMessageAttachments?: (messages: CloudMessage[], peerId: string) => Promise<CloudMessage[]>;
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
        const messages = await listMessages(peerId);
        return [peerId, await resolveMessageAttachments(messages, peerId)] as const;
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
};

function normalizeCloudSelfAgentRestoreMessage(message: CloudMessage): CloudSelfAgentRestoreMessage | null {
  const sessionId = cleanText(message.sessionId);
  if (!sessionId) return null;
  const response = parseCloudAgentResponse(message.body);
  if (!response && (parseCloudAgentCancel(message.body) || parseCloudGroupControl(message.body))) return null;
  const text = cleanText(response?.text ?? message.body);
  if (!text) return null;
  return {
    message,
    sessionId,
    role: response ? 'agent' : 'user',
    text,
    createdAtMs: cloudSelfAgentCreatedAtMs(message),
    responseRequestId: response?.requestId ?? null,
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
}: {
  account: CloudAccount;
  messages: CloudMessage[];
  state: CanonicalSessionState;
  forksBySessionId?: Record<string, CloudSessionForkSummary>;
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
    .map(normalizeCloudSelfAgentRestoreMessage)
    .filter((message): message is CloudSelfAgentRestoreMessage => Boolean(message));
  const forkSnapshotCloudMessageIds = restoredForkSnapshotCloudMessageIds(normalizedMessages, forksBySessionId);

  const userTextByCloudMessageId = new Map<string, string>();
  const requestLocalMessageIdByCloudMessageId = new Map<string, string>();
  const plannedCanonicalMessageIdByDuplicateKey = new Map<string, string>();
  const sessionRequestsById = new Map<string, OpenCanonicalSessionRequest>();
  const existingSessionById = new Map(state.sessions.map((session) => [session.id, session]));
  const messageRequests: AppendCanonicalMessageRequest[] = [];

  const ensureSessionRequest = (sessionId: string, title: string) => {
    if (sessionRequestsById.has(sessionId)) return;
    const fork = forksBySessionId[sessionId];
    const existingSession = existingSessionById.get(sessionId);
    const metadata = {
      cloudSelfAgentSession: true,
      ...(fork
        ? {
            fork: {
              forkedFromSessionId: fork.parentSessionId,
              ...(fork.parentMessageId ? { forkedFromMessageId: fork.parentMessageId } : {}),
            },
          }
        : {}),
    };
    const existingMetadata = existingSession?.metadata && typeof existingSession.metadata === 'object' && !Array.isArray(existingSession.metadata)
      ? existingSession.metadata as Record<string, unknown>
      : {};
    const existingFork = existingMetadata.fork && typeof existingMetadata.fork === 'object' && !Array.isArray(existingMetadata.fork)
      ? existingMetadata.fork as Record<string, unknown>
      : null;
    const existingHasFork = Boolean(fork)
      && existingFork?.forkedFromSessionId === fork?.parentSessionId
      && (!fork?.parentMessageId || existingFork?.forkedFromMessageId === fork.parentMessageId);
    if (existingSession && (!fork || existingHasFork)) return;
    sessionRequestsById.set(sessionId, {
      id: sessionId,
      kind: 'self-agent',
      title: cleanText(existingSession?.title) || title,
      status: 'active',
      createdByIdentityId: localHumanIdentityId,
      primaryIdentityId: agentIdentityId,
      participantIdentityIds: [agentIdentityId],
      metadata,
    });
  };

  for (const restoreMessage of normalizedMessages) {
    const { message, sessionId, role, text, createdAtMs, responseRequestId } = restoreMessage;
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
        ensureSessionRequest(sessionId, text || 'My Kordi');
      } else {
        ensureSessionRequest(sessionId, cleanText(userTextByCloudMessageId.get(responseRequestId)) || cleanText(existingSessionById.get(sessionId)?.title) || 'My Kordi');
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
    const parentMessageId = responseRequestId ? requestLocalMessageIdByCloudMessageId.get(responseRequestId) ?? null : null;
    const title = cleanText(userTextByCloudMessageId.get(responseRequestId ?? message.messageId))
      || cleanText(existingSessionById.get(sessionId)?.title)
      || 'My Kordi';
    ensureSessionRequest(sessionId, title);
    plannedCanonicalMessageIdByDuplicateKey.set(duplicateKey, canonicalMessageId);
    messageRequests.push({
      id: canonicalMessageId,
      sessionId,
      senderIdentityId: responseRequestId ? agentIdentityId : localHumanIdentityId,
      senderRole: responseRequestId ? 'owned-agent' : 'user',
      messageKind: responseRequestId ? 'agent-turn' : 'text',
      contentText: text,
      content: responseRequestId ? { cloudRequestMessageId: responseRequestId } : null,
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
  bridgeParticipants?: DesktopBridgeSessionParticipant[];
  fork?: CloudGroupControlEnvelope['fork'];
  message?: CloudGroupControlEnvelope['message'];
  attachments?: AttachmentItem[];
};

export type UseCloudBridgeStateResult = {
  cloudBridgeState: DesktopBridgeState | null;
  setCloudBridgeState: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  mergedBridgeState: DesktopBridgeState | null;
  sendCloudBridgeMessage(conversationId: string, text: string, attachments?: AttachmentItem[]): Promise<void>;
  sendCloudGroupControl(input: SendCloudGroupControlInput): Promise<void>;
  recordCloudSessionFork(input: { sourceSessionId: string; forkSessionId: string; parentMessageId?: string | null }): Promise<void>;
  updateCloudSessionPin(input: { sessionId: string; messageId: string | null; scope: 'private' | 'shared' }): Promise<CloudSessionPin>;
  hideCloudSession(sessionId: string): Promise<void>;
  unhideCloudSession(sessionId: string): Promise<void>;
  deleteCloudSession(sessionId: string): Promise<void>;
  cancelCloudBridgeAgentRequest(conversationId: string, requestId: string): Promise<void>;
  refreshCloudBridgeMessages(): Promise<void>;
  cloudSessionActivity: CloudSessionActivityStore;
  refreshCloudSessionActivity(sessionId: string): Promise<void>;
  publishCloudTaskActivity(input: UpsertCloudTaskActivityInput): Promise<void>;
  publishCloudArtifactActivity(input: UpsertCloudArtifactActivityInput): Promise<void>;
  refreshCloudContacts(): Promise<void>;
  initialContactsSettled: boolean;
  initialMessagesSettled: boolean;
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
  const contacts = useCloudContacts(account);
  const [messagesByPeer, setMessagesByPeer] = useState<Record<string, CloudMessage[]>>(() => loadCachedCloudMessagesByPeer(account?.accountId));
  const [cloudSessionActivity, setCloudSessionActivity] = useState<CloudSessionActivityStore>(() => loadCachedCloudSessionActivity(account?.accountId));
  const [cloudSessionForksById, setCloudSessionForksById] = useState<Record<string, CloudSessionForkSummary>>({});
  const [cloudSessionPinsById, setCloudSessionPinsById] = useState<CloudSessionPinsById>({});
  const [cloudHiddenSessionIds, setCloudHiddenSessionIds] = useState<Set<string>>(() => loadCloudSessionVisibility(account?.accountId).hiddenSessionIds);
  const [cloudDeletedSessionIds, setCloudDeletedSessionIds] = useState<Set<string>>(() => loadCloudSessionVisibility(account?.accountId).deletedSessionIds);
  const messagesByPeerRef = useRef<Record<string, CloudMessage[]>>({});
  const cloudSessionActivityRef = useRef<CloudSessionActivityStore>(cloudSessionActivity);
  const cloudSessionForksByIdRef = useRef<Record<string, CloudSessionForkSummary>>(cloudSessionForksById);
  const cloudSessionPinsByIdRef = useRef<CloudSessionPinsById>(cloudSessionPinsById);
  const cloudHiddenSessionIdsRef = useRef<Set<string>>(cloudHiddenSessionIds);
  const cloudDeletedSessionIdsRef = useRef<Set<string>>(cloudDeletedSessionIds);
  const messagesCacheAccountRef = useRef<string | null>(account?.accountId ?? null);
  const [initialMessagesSettledPeerKey, setInitialMessagesSettledPeerKey] = useState<string | null>(null);
  const canonicalSessionStateRef = useRef<CanonicalSessionState | null>(canonicalSessionState ?? null);
  const cloudGroupOfflineTimersRef = useRef<Map<string, number>>(new Map());
  const cloudProfileCacheRef = useRef<Map<string, CloudPublicProfile>>(new Map());
  const bootstrapPeerIdsRef = useRef<string[]>([]);
  const [readInboundMessageIdsByPeer, setReadInboundMessageIdsByPeer] = useState<Record<string, Set<string>>>({});
  const [localAgentTurnsByRequestId, setLocalAgentTurnsByRequestId] = useState<Record<string, DesktopChatTurnSnapshot>>({});
  const [cloudBridgeOverride, setCloudBridgeOverrideState] = useState<DesktopBridgeState | null>(null);
  const [cloudSelfAgentSyncStatusBySessionId, setCloudSelfAgentSyncStatusBySessionId] = useState<Record<string, CloudSelfAgentSyncStatus>>({});
  const cloudBridgeStateRef = useRef<DesktopBridgeState | null>(null);
  const readReceiptRequestRef = useRef<string | null>(null);
  const processedCloudAgentMentionIdsRef = useRef<Set<string>>(new Set());
  const claimedCloudFallbackRunKeysRef = useRef<Set<string>>(new Set());
  const syncedProviderAuthSnapshotKeysRef = useRef<Set<string>>(new Set());
  const processedCloudGroupControlIdsRef = useRef<Set<string>>(new Set());
  const cloudAgentTurnIdsByRequestIdRef = useRef<Map<string, string>>(new Map());
  const cloudSelfAgentForkRefreshKeyRef = useRef<string | null>(null);
  const syncingSelfAgentHistoryRef = useRef(false);
  const syncingCloudDiffRef = useRef(false);
  const syncedContactIdentitySignatureRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    messagesByPeerRef.current = messagesByPeer;
    if (account && messagesCacheAccountRef.current === account.accountId) saveCachedCloudMessagesByPeer(account.accountId, messagesByPeer);
  }, [account, messagesByPeer]);

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

  useEffect(() => {
    setMessagesByPeer((current) => {
      if (!account) {
        messagesCacheAccountRef.current = null;
        return Object.keys(current).length === 0 ? current : {};
      }
      const cached = loadCachedCloudMessagesByPeer(account.accountId);
      messagesCacheAccountRef.current = account.accountId;
      return cloudMessagesByPeerEqual(current, cached) ? current : cached;
    });
    setCloudSessionActivity(account ? loadCachedCloudSessionActivity(account.accountId) : EMPTY_CLOUD_SESSION_ACTIVITY);
    setCloudSessionPinsById({});
    const visibility = loadCloudSessionVisibility(account?.accountId);
    setCloudHiddenSessionIds(visibility.hiddenSessionIds);
    setCloudDeletedSessionIds(visibility.deletedSessionIds);
  }, [account?.accountId]);

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
  const initialMessagesSettled = cloudInitialMessagesSettledForPeerKey({
    accountReady: Boolean(account),
    contactsSettled: contacts.initialLoadSettled,
    currentPeerKey: bootstrapPeerKey,
    settledPeerKey: initialMessagesSettledPeerKey,
  });
  useEffect(() => {
    bootstrapPeerIdsRef.current = bootstrapPeerIds;
  }, [bootstrapPeerKey]);
  const cloudProfileAdoptionSignature = useMemo(() => JSON.stringify({
    accountId: account?.accountId ?? null,
    displayName: account?.displayName ?? account?.primaryEmail ?? null,
    avatarUrl: account?.avatarUrl ?? null,
    profileHumanIdentityId: canonicalSessionState?.profile.humanIdentityId ?? null,
  }), [account?.accountId, account?.avatarUrl, account?.displayName, account?.primaryEmail, canonicalSessionState?.profile.humanIdentityId]);

  useEffect(() => {
    if (!account || !setCanonicalSessionState) return;
    const stableIdentityId = `human:${account.accountId}`;
    if (canonicalSessionState?.profile.humanIdentityId === stableIdentityId) return;
    let cancelled = false;
    void adoptCloudProfileIdentity({
      accountId: account.accountId,
      displayName: account.displayName || account.primaryEmail || account.accountId,
      avatarKey: account.accountId,
      profileImageUrl: account.avatarUrl ?? null,
    })
      .then((nextState) => {
        if (!cancelled) setCanonicalSessionState(nextState);
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.warn('[cloud-profile-identity] failed to adopt stable cloud profile identity', error);
      });
    return () => {
      cancelled = true;
    };
  }, [account, canonicalSessionState?.profile.humanIdentityId, cloudProfileAdoptionSignature, setCanonicalSessionState]);

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
        const nextState = await upsertCanonicalIdentity(request);
        if (!cancelled) setCanonicalSessionState(nextState);
      }
    })().catch(() => {
      syncedContactIdentitySignatureRef.current = null;
    });
    return () => {
      cancelled = true;
    };
  }, [account, contactIdentitySignature, contacts.contacts, localHumanIdentityId, setCanonicalSessionState]);

  const refreshCloudBridgeMessages = useCallback(async () => {
    const retainedPeerIds = Object.keys(messagesByPeerRef.current);
    const initialPeerIds = [...new Set([...bootstrapPeerIdsRef.current, ...retainedPeerIds])];
    if (!account || initialPeerIds.length === 0) {
      setMessagesByPeer((current) => (Object.keys(current).length === 0 ? current : {}));
      setInitialMessagesSettledPeerKey(bootstrapPeerKey);
      return;
    }
    const session = await loadSession();
    if (!session?.token) {
      setInitialMessagesSettledPeerKey(null);
      return;
    }

    const loaded = await loadCloudMessagesByPeerUntilStable({
      accountId: account.accountId,
      initialPeerIds,
      existingMessagesByPeer: messagesByPeerRef.current,
      listMessages: (peerId) => client.listMessages(session.token, peerId),
      resolveMessageAttachments: async (messages) => Promise.all(messages.map(async (message) => ({
        ...message,
        attachments: message.attachments?.length
          ? await resolveCloudMessageAttachments({ token: session.token, client, attachments: message.attachments })
          : [],
      }))),
    });

    if (cancelledRef.current) return;
    setMessagesByPeer((current) => {
      const merged = mergeCloudMessagesByPeerSnapshot(current, loaded.messagesByPeer);
      return cloudMessagesByPeerEqual(current, merged) ? current : merged;
    });
    setInitialMessagesSettledPeerKey(loaded.complete ? bootstrapPeerKey : null);
  }, [account, bootstrapPeerKey, client]);

  const syncCloudBridgeDiff = useCallback(async () => {
    if (!account) return false;
    if (syncingCloudDiffRef.current) return true;
    const session = await loadSession();
    if (!session?.token) return false;
    syncingCloudDiffRef.current = true;
    try {
      let messagesByPeer = messagesByPeerRef.current;
      let sessionActivity = cloudSessionActivityRef.current;
      let sessionForksById = cloudSessionForksByIdRef.current;
      let sessionPinsById = cloudSessionPinsByIdRef.current;
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
          hiddenSessionIds,
          deletedSessionIds,
          fetchEvents: (cursor) => client.syncCloudEvents(session.token, cursor, 500),
        });
        if (result.fallbackRequired) {
          fallbackRequired = true;
          break;
        }
        messagesByPeer = result.messagesByPeer;
        sessionActivity = result.sessionActivity;
        sessionForksById = result.sessionForksById;
        sessionPinsById = result.sessionPinsById;
        hiddenSessionIds = result.hiddenSessionIds;
        deletedSessionIds = result.deletedSessionIds;
        if (!result.hasMore) break;
      }
      if (cancelledRef.current) return false;
      if (fallbackRequired) {
        await refreshCloudBridgeMessages();
        return false;
      }
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
      setCloudHiddenSessionIds((current) => setsEqual(current, hiddenSessionIds) ? current : new Set(hiddenSessionIds));
      setCloudDeletedSessionIds((current) => setsEqual(current, deletedSessionIds) ? current : new Set(deletedSessionIds));
      setInitialMessagesSettledPeerKey(bootstrapPeerKey);
      return true;
    } finally {
      syncingCloudDiffRef.current = false;
    }
  }, [account, bootstrapPeerKey, client, refreshCloudBridgeMessages]);

  useEffect(() => {
    if (!account) {
      setMessagesByPeer({});
      setCloudSessionActivity(EMPTY_CLOUD_SESSION_ACTIVITY);
      setCloudSessionForksById({});
      setCloudSessionPinsById({});
      setReadInboundMessageIdsByPeer({});
      setLocalAgentTurnsByRequestId({});
      setCloudBridgeOverrideState(null);
      setInitialMessagesSettledPeerKey(null);
      cloudSelfAgentForkRefreshKeyRef.current = null;
      return;
    }
    void syncCloudBridgeDiff().then((diffSynced) => {
      if (!diffSynced) void refreshCloudBridgeMessages();
    });
    const interval = window.setInterval(() => {
      void syncCloudBridgeDiff().then((diffSynced) => {
        if (!diffSynced) void refreshCloudBridgeMessages();
      });
    }, CLOUD_MESSAGES_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [account, refreshCloudBridgeMessages, syncCloudBridgeDiff]);

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
      const noticeId = `msg:cloud-agent-offline:${candidate.requestMessage.id}:${candidate.targetAccountId}`;
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
        setCanonicalSessionState((current) => (
          responseState === 'processing'
            ? setCloudGroupRequestPlaceholderProcessing(current, candidate, noticeId)
            : removeCloudGroupOfflinePlaceholder(current, noticeId)
        ));
        continue;
      }
      if (cloudGroupOfflineTimersRef.current.has(key)) continue;

      const timeoutId = window.setTimeout(() => {
        cloudGroupOfflineTimersRef.current.delete(key);
        void (async () => {
          const session = await loadSession();
          if (session?.token && await cloudFallbackRunAlreadyOwnsRequest({
            client,
            token: session.token,
            requestMessageId: candidate.requestMessage.id,
          })) {
            setCanonicalSessionState((current) => setCloudGroupRequestPlaceholderProcessing(current, candidate, noticeId));
            return;
          }
          const failedNoticeRequest = cloudGroupAgentNoProviderFallbackRequest({
            sessionId: candidate.requestMessage.sessionId,
            requestMessageId: candidate.requestMessage.id,
            targetAccountId: candidate.targetAccountId,
            targetAgentDisplayName: candidate.targetAgentDisplayName,
            createdAtMs: Date.now(),
          });
          setCanonicalSessionState((current) => upsertCanonicalRequestIntoLocalState(current, failedNoticeRequest));
          await upsertCanonicalMessage(failedNoticeRequest)
            .then((nextState) => {
              canonicalSessionStateRef.current = nextState;
              setCanonicalSessionState(nextState);
            });
        })().catch((error) => {
          // eslint-disable-next-line no-console
          console.warn('[cloud-group-agent-requesting] failed to persist no-provider fallback', error);
        });
      }, CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS);
      cloudGroupOfflineTimersRef.current.set(key, timeoutId);

      if (hasRequestingNotice && requestReachedCloud) {
        // Reaching Cloud only proves delivery, not target availability. Keep the
        // existing placeholder but arm the timeout above so it cannot remain as
        // "Processing…" forever if the target instance never sends a terminal
        // agent response.
        continue;
      }

      setCanonicalSessionState((current) => appendCloudGroupRequestingPlaceholder(current, candidate, noticeId));
      void upsertCanonicalMessage(cloudGroupAgentRequestingNoticeRequest({
        sessionId: candidate.requestMessage.sessionId,
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        targetAgentDisplayName: candidate.targetAgentDisplayName,
        createdAtMs: Date.now(),
      }))
        .then((nextState) => {
          canonicalSessionStateRef.current = nextState;
          setCanonicalSessionState(nextState);
        })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.warn('[cloud-group-agent-requesting] failed to persist requesting notice', error);
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
  }, [account, canonicalSessionState, client, setCanonicalSessionState]);

  const mergeMessage = useCallback((message: CloudMessage) => {
    const peerId = message.fromAccountId === account?.accountId ? message.toAccountId : message.fromAccountId;
    if (!peerId) return;
    setMessagesByPeer((current) => {
      const previous = current[peerId] ?? [];
      if (previous.some((candidate) => candidate.messageId === message.messageId)) return current;
      const next = [...previous, message].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return { ...current, [peerId]: next };
    });
  }, [account?.accountId]);

  useEffect(() => {
    if (!account || syncingSelfAgentHistoryRef.current) return;

    syncingSelfAgentHistoryRef.current = true;
    let plannedSessionIds: string[] = [];
    void (async () => {
      const latestState = await fetchCanonicalSessionState().catch(() => canonicalSessionState ?? null);
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
      await refreshCloudBridgeMessages();
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
  }, [account, canonicalSessionState, client, mergeMessage, refreshCloudBridgeMessages]);

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
      nextState = await upsertCanonicalIdentity(request);
    }

    const createdByIdentityId = identityIdByAccount.get(envelope.createdByAccountId)
      ?? identityIdByAccount.get(envelope.actor.accountId)
      ?? localHumanIdentityId;
    const participantIdentityIds = [...identityIdByAccount.entries()]
      .filter(([accountId, identityId]) => accountId !== envelope.createdByAccountId && identityId !== createdByIdentityId)
      .map(([, identityId]) => identityId);
    const sessionTitleUpdateTitle = cloudSessionTitleUpdateTitle(envelope);
    const explicitGroupTitle = shouldApplyCloudGroupTitleUpdate(envelope) ? cloudGroupNonGenericTitle(envelope.groupTitle) : null;
    const isSelfAuthoredControl = envelope.actor.accountId === account.accountId || envelope.createdByAccountId === account.accountId;
    const groupTitle = explicitGroupTitle || 'Group';
    const groupSpaceId = envelope.groupSpaceId?.trim() || envelope.groupId;
    const participantNames = [...participantByAccount.values()].map((participant) => participant.displayName);
    const forkMetadata = envelope.fork ? {
      forkedFromSessionId: envelope.fork.parentSessionId,
      forkedFromMessageId: envelope.fork.parentMessageId ?? null,
      forkMode: 'cloud-group',
      contextPolicy: 'prefix-through-message',
      boundary: 'inherited-history-reference-only',
      createdAtMs: envelope.fork.createdAtMs ?? null,
    } : null;
    const groupMetadata = {
      schemaVersion: 1,
      kind: 'chat-group',
      ...(explicitGroupTitle ? { customName: explicitGroupTitle } : {}),
      groupId: groupSpaceId,
      groupSpaceId,
      adminIdentityIds: [createdByIdentityId],
      initialContactIds: [...participantByAccount.keys()].map((accountId) => `cloud:${accountId}`),
      initialParticipantNames: participantNames,
      memberApprovalPolicy: 'under-50-open',
      createdFrom: envelope.kind === 'session-fork' || forkMetadata ? 'cloud-group-fork-sync' : 'cloud-group-sync',
      ...(forkMetadata ? { fork: forkMetadata } : {}),
    };
    const parsedControlCreatedAtMs = Date.parse(cloudMessage.createdAt);
    const controlCreatedAtMs = Number.isFinite(parsedControlCreatedAtMs) ? parsedControlCreatedAtMs : Date.now();
    nextState = await openOrCreateCanonicalSession({
      id: envelope.groupId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId,
      primaryIdentityId: null,
      relationshipIdentityId: null,
      participantIdentityIds,
      metadata: groupMetadata,
    });

    if (sessionTitleUpdateTitle) {
      const actorIdentityId = identityIdByAccount.get(envelope.actor.accountId) ?? createdByIdentityId;
      nextState = await renameCanonicalSession({
        sessionId: envelope.groupId,
        title: sessionTitleUpdateTitle,
        requestedByIdentityId: actorIdentityId,
      });
      if (!isSelfAuthoredControl) {
        const noticeRequest = cloudSessionTitleUpdateNoticeRequest({
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

    if (shouldApplyCloudGroupTitleUpdate(envelope)) {
      // openOrCreateCanonicalSession above already applied the replicated Cloud
      // group metadata. Do not route incoming Cloud sync through the local UI
      // admin guard; otherwise valid remote updates warn/fail on peers whose
      // local admin identity ids differ from the sender's local identity id.
      if (!isSelfAuthoredControl) {
        const noticeRequest = cloudGroupTitleUpdateNoticeRequest({
          envelope,
          actorIdentityId: identityIdByAccount.get(envelope.actor.accountId) ?? createdByIdentityId,
          createdAtMs: controlCreatedAtMs,
          cloudMessageId: cloudMessage.messageId,
        });
        if (noticeRequest && !nextState.messages.some((message) => message.id === noticeRequest.id)) {
          nextState = await appendCanonicalMessage(noticeRequest);
        }
      }
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
    // Round-trip guard: when the local agent owner broadcasts their own
    // agent response envelope, it returns via cloud polling. The mention
    // handler already wrote the canonical row in place of the processing
    // row (using processingMessageId), so envelope.message.id (a fresh
    // `msg:cloud-agent:<turnId>`) won't match the existing row — without
    // this guard, the receive-side block would write a second row and we'd
    // be back to the duplicate state. Treat the request as already handled
    // when this envelope is our own agent's response AND a processing row
    // exists locally for the same request.
    const isOwnAgentResponseRoundTrip = envelope.message
      && envelope.message.senderKind === 'agent'
      && envelope.message.senderAccountId === account.accountId
      && Boolean((envelope.message.replyToMessageId || envelope.message.requestId)?.trim());
    const ownAgentProcessingId = isOwnAgentResponseRoundTrip
      ? `msg:cloud-agent-processing:${(envelope.message!.replyToMessageId || envelope.message!.requestId || '').trim()}:${account.accountId}`
      : null;
    const existingCloudGroupMessage = [canonicalState, nextState]
      .filter((state): state is CanonicalSessionState => Boolean(state))
      .flatMap((state) => state.messages)
      .find((candidate) => (
        candidate.id === envelope.message?.id
        || (ownAgentProcessingId !== null && candidate.id === ownAgentProcessingId)
      )) ?? null;
    const messageAlreadyExists = Boolean(existingCloudGroupMessage);

    const senderIsAgent = envelope.message.senderKind === 'agent';
    const senderIdentityId = senderIsAgent ? `agent:cloud:${envelope.message.senderAccountId}` : senderHumanIdentityId;
    const messageReplyToId = envelope.message.replyToMessageId?.trim()
      || envelope.message.requestId?.trim()
      || null;
    const agentDeliveryState = senderIsAgent
      ? (envelope.message.deliveryState?.trim() || (isCloudAgentProcessingPlaceholderText(envelope.message.text) ? 'processing' : 'complete'))
      : null;
    if (senderIsAgent) {
      const owner = participantByAccount.get(envelope.message.senderAccountId);
      nextState = await upsertCanonicalIdentity({
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
    }
    const cloudAttachments = cloudMessage.attachments?.length ? cloudMessage.attachments : envelope.message.attachments ?? [];
    const currentSession = cloudAttachments.length > 0 ? await loadSession() : null;
    const mappedAttachments = currentSession?.token
      ? await resolveCloudMessageAttachments({ token: currentSession.token, client, attachments: cloudAttachments })
      : cloudAttachments.map(cloudMessageAttachmentToMessageAttachment);

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
        nextState = await upsertCanonicalMessage({
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
        });
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
        ? `msg:cloud-agent-offline:${messageReplyToId}:${envelope.message.senderAccountId}`
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
      const existingStableRowTerminalLocked = existingStableRow
        ? ['cancelled', 'complete'].includes((existingStableRow.status || '').trim().toLowerCase())
        : false;
      if (existingStableRowTerminalLocked && agentDeliveryState === 'processing') {
        setCanonicalSessionState(nextState);
        return;
      }
      const replacementAgentSlot = existingStableRow ?? responseProcessingSlot;
      const shouldUpdateStableAgentSlot = Boolean(replacementAgentSlot);
      const agentStatus = senderIsAgent && agentDeliveryState === 'processing'
        ? 'processing'
        : senderIsAgent && agentDeliveryState === 'failed'
          ? 'failed'
          : senderIsAgent && agentDeliveryState === 'cancelled'
            ? 'cancelled'
            : envelope.message.senderAccountId === account.accountId ? 'sent' : 'received';
      const messageRequest = {
        id: replacementAgentSlot?.id ?? envelope.message.id,
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
        sourceTransport: envelope.message.forkSnapshot
          ? 'cloud-group-fork-snapshot'
          : senderIsAgent ? 'cloud-group-agent' : 'cloud-group',
        sourceEventId: `${envelope.message.forkSnapshot ? 'cloud-group-fork-snapshot' : senderIsAgent ? 'cloud-group-agent' : 'cloud-group'}:${cloudMessage.messageId}`,
      };
      nextState = shouldUpdateStableAgentSlot
        ? await upsertCanonicalMessage(messageRequest)
        : await appendCanonicalMessage(messageRequest);
      // Race guard: if the local offline-timer effect added the offline-tier
      // placeholder AFTER we captured canonicalSessionState above (which can
      // happen when the response arrives in the same cloud-poll batch as the
      // mention), shouldUpdateStableAgentSlot was false and we just wrote a
      // separate row under envelope.message.id. Strip any orphan offline-tier
      // placeholder for this request from `nextState` before applying it so
      // the agent reply slot ends up with a single row instead of two
      // ("Processing…" + the real response).
      if (senderIsAgent && messageReplyToId) {
        const offlinePlaceholderId = `msg:cloud-agent-offline:${messageReplyToId}:${envelope.message.senderAccountId}`;
        nextState = removeCloudGroupOfflinePlaceholder(nextState, offlinePlaceholderId) ?? nextState;
      }
      setCanonicalSessionState(nextState);
    }

    const groupMessageIsOwn = envelope.message.senderAccountId === account.accountId;
    const groupMessageMentionsLocalAgent = envelope.message.forkSnapshot === true ? false : cloudMessageMentionsLocalAgent(
      envelope.message.text,
      account,
      { allowFirstPerson: groupMessageIsOwn },
    );
    if (
      !senderIsAgent
      && groupMessageMentionsLocalAgent
      && isRecentCloudAgentMention(cloudMessage.createdAt)
      && !processedCloudAgentMentionIdsRef.current.has(envelope.message.id)
    ) {
      const allCloudMessages = Object.values(messagesByPeerRef.current).flat();
      if (cloudGroupLocalAgentRequestAlreadyHandled({
        localAccountId: account.accountId,
        requestMessageId: envelope.message.id,
        messages: allCloudMessages,
      }) || cloudGroupAgentResponseExistsForRequest({
        localAccountId: account.accountId,
        requestMessageId: envelope.message.id,
        messages: allCloudMessages,
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
            messages: [...allCloudMessages, ...latestTargetMessages],
          })) {
          void refreshCloudBridgeMessages();
          return;
        }
        const agentIdentityId = `agent:cloud:${account.accountId}`;
        const agentDisplayName = `${account.displayName || account.primaryEmail || 'Cloud user'}'s Kordi`;
        await upsertCanonicalIdentity({
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
        const processingMessageId = `msg:cloud-agent-processing:${envelope.message!.id}:${account.accountId}`;
        const processingCreatedAtMs = Date.now();
        const processingState = await appendCanonicalMessage({
          id: processingMessageId,
          sessionId: envelope.groupId,
          senderIdentityId: agentIdentityId,
          senderRole: 'owned-agent',
          messageKind: 'agent-turn',
          contentText: 'processing...',
          content: {
            sender: 'My Kordi',
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
        });
        setCanonicalSessionState(processingState);
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
        const contextMessages = cloudGroupNativeContextMessages({
          cloudMessages: allCloudMessages,
          groupId: envelope.groupId,
          requestMessageId: envelope.message!.id,
          requestCreatedAtMs: envelope.message!.createdAtMs,
        });
        const visibleTaskRecords = cloudVisibleTaskRecordsForSession(cloudSessionActivityRef.current, envelope.groupId);
        const agentAttachmentPaths = mappedAttachments
          .map((attachment) => attachment.localPath?.trim() || '')
          .filter(Boolean);
        const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
          setLocalAgentTurnsByRequestId((current) => ({ ...current, [envelope.message!.id]: turn }));
        };
        const runtimeSessionId = `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${account.accountId}:${envelope.groupId}`;
        const startedTurn = await startDesktopChatMessage(
          runtimeSessionId,
          prompt,
          agentAttachmentPaths,
          cloudAgentRuntimeRouteForSession(cloudAgentRuntimeRoutesBySessionId, runtimeSessionId, defaultCloudAgentRuntimeRoute),
          contextMessages,
          visibleTaskRecords,
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
            messages: [...allCloudMessages, ...finalLatestTargetMessages],
          })) {
          void refreshCloudBridgeMessages();
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
        const responseState = await upsertCanonicalMessage({
          id: processingMessageId,
          sessionId: envelope.groupId,
          senderIdentityId: agentIdentityId,
          senderRole: 'owned-agent',
          messageKind: 'agent-turn',
          contentText: responseContentText,
          content: {
            sender: 'My Kordi',
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
        });
        setCanonicalSessionState(responseState);
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
        void refreshCloudBridgeMessages();
      })().catch((error) => {
        cloudAgentTurnIdsByRequestIdRef.current.delete(envelope.message!.id);
        if (isCloudAgentNoProviderConfiguredError(error)) {
          const responseCreatedAtMs = Date.now();
          const processingMessageId = `msg:cloud-agent-processing:${envelope.message!.id}:${account.accountId}`;
          const responseMessageId = `msg:cloud-agent-no-provider:${envelope.message!.id}:${account.accountId}`;
          const agentDisplayName = `${account.displayName || account.primaryEmail || 'Cloud user'}'s Kordi`;
          void (async () => {
            const nextState = await upsertCanonicalMessage({
              id: processingMessageId,
              sessionId: envelope.groupId,
              senderIdentityId: `agent:cloud:${account.accountId}`,
              senderRole: 'owned-agent',
              messageKind: 'agent-turn',
              contentText: '',
              content: {
                sender: 'My Kordi',
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
            });
            setCanonicalSessionState(nextState);
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
            void refreshCloudBridgeMessages();
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
    cloudAgentRuntimeRoutesBySessionId,
    defaultCloudAgentRuntimeRoute,
    mergeMessage,
    refreshCloudBridgeMessages,
    setCanonicalSessionState,
  ]);

  const mergeMessageRef = useRef(mergeMessage);
  const syncCloudBridgeDiffRef = useRef(syncCloudBridgeDiff);
  useEffect(() => { mergeMessageRef.current = mergeMessage; }, [mergeMessage]);
  useEffect(() => { syncCloudBridgeDiffRef.current = syncCloudBridgeDiff; }, [syncCloudBridgeDiff]);

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
    // `mergeMessage` and `refreshCloudBridgeMessages`, both of whose
    // identities flip transitively when canonicalSessionState updates
    // (groupParticipantContacts → groupParticipantPeerIds → bootstrapPeerIds
    // → refreshCloudBridgeMessages). Every canonical update therefore tore
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
    const cloudMessages = Object.values(messagesByPeer).flat();
    if (cloudMessages.length === 0) return;

    setCanonicalSessionState((current) => {
      if (!current) return current;
      let changed = false;
      const messages = current.messages.map((message) => {
        if (message.senderRole !== 'user') return message;
        const deliveryState = cloudGroupDeliveryStateFromMessages({
          accountId: account.accountId,
          messageId: message.id,
          messages: cloudMessages,
        });
        const readReceiptSummary = cloudGroupReadReceiptSummaryFromMessages({
          accountId: account.accountId,
          messageId: message.id,
          messages: cloudMessages,
        });
        if (!deliveryState && !readReceiptSummary) return message;
        const content = objectContent(message.content);
        const existingReadReceiptSummary = objectContent(content.readReceiptSummary);
        const existingReadCount = typeof existingReadReceiptSummary.count === 'number' && Number.isFinite(existingReadReceiptSummary.count)
          ? Math.max(0, Math.floor(existingReadReceiptSummary.count))
          : 0;
        const nextReadCount = readReceiptSummary?.count ?? 0;
        if (message.status === 'sent' && content.deliveryState === deliveryState && existingReadCount === nextReadCount) return message;
        changed = true;
        return {
          ...message,
          status: deliveryState ? 'sent' : message.status,
          content: {
            ...content,
            ...(deliveryState ? { deliveryState } : {}),
            ...(readReceiptSummary ? { readReceiptSummary } : { readReceiptSummary: null }),
          },
        };
      });
      return changed ? { ...current, messages } : current;
    });
  }, [account, messagesByPeer, setCanonicalSessionState]);

  useEffect(() => {
    if (!account || !setCanonicalSessionState) return;
    const activeConversationIds = [
      activeConversationId,
      activeConversationId ? cloudSessionIdFromConversationId(activeConversationId) : null,
    ];
    const unreadBySessionId = cloudGroupUnreadCountsBySessionId({
      accountId: account.accountId,
      activeConversationIds,
      messages: Object.values(messagesByPeer).flat(),
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
  }, [account, activeConversationId, canonicalSessionState?.sessions, messagesByPeer, setCanonicalSessionState]);

  useEffect(() => {
    if (!account || !canonicalSessionState?.profile.humanIdentityId || !setCanonicalSessionState || !initialMessagesSettled) return;
    const replayMessages = cloudGroupControlMessagesForAccount({
      accountId: account.accountId,
      messages: Object.values(messagesByPeer).flat(),
    });
    for (const message of replayMessages) {
      const envelope = parseCloudGroupControl(message.body);
      if (!envelope) continue;
      const replayKey = cloudGroupControlReplayKey(message) ?? message.messageId;
      if (processedCloudGroupControlIdsRef.current.has(replayKey)) continue;
      processedCloudGroupControlIdsRef.current.add(replayKey);
      void applyCloudGroupControl(message, envelope).catch((error) => {
        processedCloudGroupControlIdsRef.current.delete(replayKey);
        // eslint-disable-next-line no-console
        console.warn('[cloud-group] sync failed', error);
      });
    }
  }, [account, applyCloudGroupControl, canonicalSessionState?.profile.humanIdentityId, initialMessagesSettled, messagesByPeer, setCanonicalSessionState]);

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
    const claims = cloudFallbackRunClaimsForMessages({ account, contacts: contacts.contacts, messagesByPeer })
      .filter((claim) => !claimedCloudFallbackRunKeysRef.current.has(claim.idempotencyKey));
    if (claims.length === 0) return;
    let cancelled = false;
    void (async () => {
      const session = await loadSession();
      if (!session?.token) return;
      for (const claim of claims) {
        if (cancelled) return;
        claimedCloudFallbackRunKeysRef.current.add(claim.idempotencyKey);
        await client.claimCloudAgentRun(session.token, claim).catch((error) => {
          // owner_online means the local owner device should handle the request;
          // other authorization/configuration errors should not be retried in a tight UI loop.
          if (error?.code === 'network_error') {
            claimedCloudFallbackRunKeysRef.current.delete(claim.idempotencyKey);
          }
          // eslint-disable-next-line no-console
          console.warn('[cloud-agent-fallback] claim failed', error);
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, client, contacts.contacts, initialMessagesSettled, messagesByPeer]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    for (const messages of Object.values(messagesByPeer)) {
      for (const message of messages) {
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
        void upsertCanonicalMessage(cloudGroupAgentCancelledNoticeRequest({
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
        }))
          .then((nextState) => {
            // See sender-side cancel handler for rationale: collapse the
            // cancel write and the offline-placeholder removal so the cancel
            // notice replaces the "Processing…" bubble in one render.
            const collapsedState = collapseCloudAgentOfflinePlaceholderForRequest(
              nextState,
              processingMessage,
              cancel.requestId,
            );
            canonicalSessionStateRef.current = collapsedState;
            setCanonicalSessionState(collapsedState);
          })
          .catch((error) => {
            // eslint-disable-next-line no-console
            console.warn('[cloud-agent-mention] group cancel notice failed', error);
          });
      }
    }

    for (const [peerId, messages] of Object.entries(messagesByPeer)) {
      for (const message of messages) {
        if (!shouldRunLocalCloudAgentForCloudMessage({ account, peerId, message, peerMessages: messages })) continue;
        if (processedCloudAgentMentionIdsRef.current.has(message.messageId)) continue;

        processedCloudAgentMentionIdsRef.current.add(message.messageId);
        void (async () => {
          const session = await loadSession();
          if (!session?.token) throw new Error('Not signed in.');
          const latestMessages = await client.listMessages(session.token, peerId, 100).catch(() => messages);
          if (await cloudFallbackRunAlreadyOwnsRequest({ client, token: session.token, requestMessageId: message.messageId })
            || cloudAgentResponseExistsForRequest({ account, requestMessageId: message.messageId, peerMessages: latestMessages })) {
            void refreshCloudBridgeMessages();
            return;
          }
          const contact = cloudLookupContacts.find((candidate) => (
            candidate.bridgePeerNodeId || candidate.id.replace(/^cloud:/, '')
          ) === peerId);
          const peerHumanName = contact?.name?.trim() || contact?.owner?.trim() || peerId;
          const activitySessionId = message.sessionId ?? cloudSessionIdForBridgeSend(account.accountId, peerId, `cloud:${peerId}`);
          const prompt = promptTextForCloudAgentMention(message.body);
          const contextMessages = cloudAgentNativeContextMessagesFromDirectCloudSession({
            messages,
            requestMessage: message,
            localAccountId: account.accountId,
            localHumanName: account.displayName || account.primaryEmail || 'Me',
            peerHumanName,
            localAgentName: 'My Kordi',
            peerAgentName: `${peerHumanName}'s Kordi`,
          });
          const currentSession = message.attachments?.length ? await loadSession() : null;
          const agentAttachments = currentSession?.token && message.attachments?.length
            ? await resolveCloudMessageAttachments({ token: currentSession.token, client, attachments: message.attachments })
            : message.attachments ?? [];
          const visibleTaskRecords = activitySessionId
            ? cloudVisibleTaskRecordsForSession(cloudSessionActivityRef.current, activitySessionId)
            : [];
          const agentAttachmentPaths = agentAttachments
            .map((attachment) => attachment.localPath?.trim() || '')
            .filter(Boolean);
          const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
            setLocalAgentTurnsByRequestId((current) => ({ ...current, [message.messageId]: turn }));
          };
          const runtimeSessionId = `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${account.accountId}:${peerId}`;
          const startedTurn = await startDesktopChatMessage(
            runtimeSessionId,
            prompt,
            agentAttachmentPaths,
            cloudAgentRuntimeRouteForSession(cloudAgentRuntimeRoutesBySessionId, runtimeSessionId, defaultCloudAgentRuntimeRoute),
            contextMessages,
            visibleTaskRecords,
          );
          rememberLocalTurn(startedTurn);
          cloudAgentTurnIdsByRequestIdRef.current.set(message.messageId, startedTurn.id);
          const finalTurn = startedTurn.completed
            ? startedTurn
            : await waitForCloudAgentTurn(startedTurn.id, rememberLocalTurn);
          rememberLocalTurn(finalTurn);
          cloudAgentTurnIdsByRequestIdRef.current.delete(message.messageId);
          if (finalTurn.status === 'cancelled') {
            void refreshCloudBridgeMessages();
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
          const finalLatestMessages = await client.listMessages(session.token, peerId, 100).catch(() => latestMessages);
          if (await cloudFallbackRunAlreadyOwnsRequest({ client, token: session.token, requestMessageId: message.messageId })
            || cloudAgentResponseExistsForRequest({ account, requestMessageId: message.messageId, peerMessages: finalLatestMessages })) {
            void refreshCloudBridgeMessages();
            return;
          }
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
          void refreshCloudBridgeMessages();
        })().catch((error) => {
          cloudAgentTurnIdsByRequestIdRef.current.delete(message.messageId);
          if (isCloudAgentNoProviderConfiguredError(error)) {
            void loadSession()
              .then((session) => {
                if (!session?.token) return null;
                return client.sendMessage(
                  session.token,
                  peerId,
                  encodeCloudAgentResponse({
                    requestId: message.messageId,
                    text: cloudAgentNoProviderNoticeText(),
                    deliveryState: 'failed',
                  }),
                  { sessionId: message.sessionId ?? null },
                );
              })
              .then((response) => {
                if (response) mergeMessage(response);
                void refreshCloudBridgeMessages();
              })
              .catch((sendError) => {
                processedCloudAgentMentionIdsRef.current.delete(message.messageId);
                // eslint-disable-next-line no-console
                console.warn('[cloud-agent-mention] no-provider notice failed', sendError);
              });
            return;
          }
          processedCloudAgentMentionIdsRef.current.delete(message.messageId);
          // eslint-disable-next-line no-console
          console.warn('[cloud-agent-mention] local agent response failed', error);
        });
      }
    }
  }, [account, client, cloudAgentRuntimeRoutesBySessionId, cloudLookupContacts, defaultCloudAgentRuntimeRoute, initialMessagesSettled, mergeMessage, messagesByPeer, refreshCloudBridgeMessages, setCanonicalSessionState]);

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
      messages: Object.values(messagesByPeer).flat(),
    });
    if (cloudGroupReadTargets.peerIds.length > 0 || cloudGroupReadTargets.sessionIds.length > 0) {
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
          void refreshCloudBridgeMessages();
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
        void refreshCloudBridgeMessages();
      })
      .catch(() => {
        readReceiptRequestRef.current = null;
      });
  }, [account, activeConversationId, client, messagesByPeer, refreshCloudBridgeMessages]);

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
    });
    if (plan.sessionRequests.length === 0 && plan.messageRequests.length === 0) return;
    let cancelled = false;
    void (async () => {
      let nextState = await upsertCanonicalIdentity(plan.agentIdentityRequest);
      for (const sessionRequest of plan.sessionRequests) {
        if (cancelled) return;
        nextState = await openOrCreateCanonicalSession(sessionRequest);
      }
      for (const messageRequest of plan.messageRequests) {
        if (cancelled) return;
        nextState = await upsertCanonicalMessage(messageRequest);
      }
      if (!cancelled) setCanonicalSessionState(nextState);
    })().catch((error) => {
      // eslint-disable-next-line no-console
      console.warn('[cloud-self-agent-sync] failed to materialize cloud session locally', error);
    });
    return () => {
      cancelled = true;
    };
  }, [account, canonicalSessionState, cloudSessionForksById, initialMessagesSettled, messagesByPeer, setCanonicalSessionState]);

  useEffect(() => {
    if (!account) return;
    const refresh = () => void refreshCloudBridgeMessages();
    const refreshWhenVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [account, refreshCloudBridgeMessages]);

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
      if (!initialMessagesSettled) return {};
      let next = messagesByPeer;
      for (const sessionId of hiddenCloudSessionIds) {
        next = removeCloudSessionMessages(account.accountId, next, sessionId);
      }
      return next;
    })();
    const generated = buildCloudDesktopBridgeState({
      account,
      contacts: cloudBridgeContacts,
      messagesByPeer: visibleMessagesByPeer,
      readInboundMessageIdsByPeer,
      activeConversationId,
      localAgentTurnsByRequestId,
      localAgentRuntimeRoute: activeRuntimeRoute,
      cloudSessionTitlesById,
      hiddenCloudSessionIds,
      suppressUnscopedSelfAgentConversation,
    });
    const generatedWithOverride = cloudBridgeOverride ?? generated;
    return applyCloudAgentRuntimeRouteToState(generatedWithOverride, activeRuntimeRoute);
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
    localAgentTurnsByRequestId,
    initialMessagesSettled,
    messagesByPeer,
    readInboundMessageIdsByPeer,
  ]);

  useEffect(() => {
    cloudBridgeStateRef.current = cloudBridgeState;
  }, [cloudBridgeState]);

  const setCloudBridgeState = useCallback<Dispatch<SetStateAction<DesktopBridgeState | null>>>((action) => {
    const current = cloudBridgeStateRef.current;
    const next = typeof action === 'function'
      ? (action as (value: DesktopBridgeState | null) => DesktopBridgeState | null)(current)
      : action;
    setCloudBridgeOverrideState(next);
  }, []);

  const mergedBridgeState = cloudBridgeState;
  const visibleCloudSelfAgentSyncStatusBySessionId = useMemo(() => ({
    ...cloudSelfAgentDerivedSyncedStatusBySessionId(account?.accountId, messagesByPeer),
    ...cloudSelfAgentSyncStatusBySessionId,
  }), [account?.accountId, cloudSelfAgentSyncStatusBySessionId, messagesByPeer]);

  const sendCloudBridgeMessage = useCallback(async (conversationId: string, text: string, attachments: AttachmentItem[] = []) => {
    const peerId = cloudPeerAccountIdFromConversationId(conversationId);
    const trimmed = text.trim();
    if (!peerId || (!trimmed && attachments.length === 0)) throw new Error('Unable to resolve cloud conversation.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const uploadedAttachments = attachments.length > 0
      ? await uploadComposerAttachments({ token: session.token, client, attachments })
      : [];
    const cloudSessionId = cloudSessionIdForBridgeSend(account?.accountId, peerId, conversationId);
    const message = await client.sendMessage(session.token, peerId, trimmed, { sessionId: cloudSessionId, attachments: uploadedAttachments });
    mergeMessage(message);
  }, [account?.accountId, client, mergeMessage]);

  const sendCloudGroupControl = useCallback(async (input: SendCloudGroupControlInput) => {
    if (!account) throw new Error('Not signed in.');
    const relatedGroupControls = cloudGroupRelatedControlsForSend(Object.values(messagesByPeer)
      .flat()
      .flatMap((cloudMessage) => {
        const envelope = parseCloudGroupControl(cloudMessage.body);
        if (!envelope) return [];
        return [{
          envelope,
          createdAtMs: Date.parse(cloudMessage.createdAt) || 0,
        }];
      }), {
      groupId: input.groupId,
      groupSpaceId: input.groupSpaceId,
    }).sort((left, right) => left.createdAtMs - right.createdAtMs);
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const actor = input.actor ?? cloudGroupSelfParticipant(account, input.kind === 'group-message' ? 'person' : 'admin');
    const inputParticipants = input.participants?.length
      ? input.participants
      : cloudGroupParticipantsForBridgeSessionParticipants(account, input.bridgeParticipants ?? []);
    const participants = cloudGroupUniqueParticipants([
      ...inputParticipants,
      ...relatedGroupControls.flatMap((control) => control.envelope.participants),
    ]);
    const targetAccountIds = [...new Set([
      ...input.targetAccountIds.map((value) => value.trim()).filter(Boolean),
      ...participants.map((participant) => participant.accountId.trim()).filter(Boolean),
    ])].filter((accountId) => accountId !== account.accountId);
    if (targetAccountIds.length === 0) return;
    const groupTitle = cloudGroupTitleForOutgoingControl({
      kind: input.kind,
      groupTitle: input.groupTitle,
      relatedGroupTitles: relatedGroupControls.map((control) => control.envelope.groupTitle),
    });
    const uploadedAttachments = input.attachments?.length
      ? await uploadComposerAttachments({ token: session.token, client, attachments: input.attachments })
      : [];
    const message = input.message
      ? {
          ...input.message,
          senderAccountId: input.message.senderAccountId?.trim() || account.accountId,
          attachments: uploadedAttachments.length > 0 ? uploadedAttachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            name: attachment.name,
            kind: attachment.kind,
            mimeType: attachment.mimeType ?? null,
            sizeBytes: attachment.sizeBytes ?? null,
          })) : input.message.attachments,
        }
      : null;
    const forkFromSessionMetadata = input.kind === 'group-message'
      ? cloudGroupForkPayloadFromSessionMetadata(
          canonicalSessionStateRef.current?.sessions.find((sessionCandidate) => sessionCandidate.id === input.groupId)?.metadata,
          input.groupId,
        )
      : null;
    const envelope = encodeCloudGroupControl({
      kind: input.kind,
      groupId: input.groupId,
      groupSpaceId: input.groupSpaceId ?? null,
      groupTitle,
      createdByAccountId: input.createdByAccountId?.trim() || account.accountId,
      actor,
      participants,
      fork: input.fork ?? forkFromSessionMetadata,
      message,
    });
    const clientCreatedAtMs = typeof message?.createdAtMs === 'number' && Number.isFinite(message.createdAtMs)
      ? message.createdAtMs
      : typeof (input.fork?.createdAtMs ?? forkFromSessionMetadata?.createdAtMs) === 'number' && Number.isFinite(input.fork?.createdAtMs ?? forkFromSessionMetadata?.createdAtMs)
        ? (input.fork?.createdAtMs ?? forkFromSessionMetadata?.createdAtMs)!
        : null;
    const results = await Promise.allSettled(targetAccountIds.map((peerId) => client.sendMessage(session.token, peerId, envelope, {
      sessionId: input.groupId,
      attachments: uploadedAttachments,
      ...(clientCreatedAtMs !== null ? { clientCreatedAt: new Date(clientCreatedAtMs).toISOString() } : {}),
    })));
    const sent = fulfilledCloudGroupSends(results);
    sent.forEach(mergeMessage);
    if (sent.length > 0) {
      await refreshCloudBridgeMessages();
      return;
    }
    const firstFailure = firstCloudGroupSendFailure(results);
    throw firstFailure instanceof Error ? firstFailure : new Error(String(firstFailure || 'Group message failed.'));
  }, [account, client, mergeMessage, messagesByPeer, refreshCloudBridgeMessages]);

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
        const cancelledState = await upsertCanonicalMessage(cloudGroupAgentCancelledNoticeRequest({
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
        }));
        // Collapse the cancel write and the offline-placeholder removal into a
        // single render so the cancel notice replaces the "Processing…" bubble
        // atomically. Without this, the offline-timer effect removes the
        // offline-tier placeholder on the next tick, which visually shifts the
        // cancel notice up and reads as a flicker (appear → disappear → appear).
        const collapsedState = collapseCloudAgentOfflinePlaceholderForRequest(
          cancelledState,
          processingMessage,
          trimmedRequestId,
        );
        canonicalSessionStateRef.current = collapsedState;
        setCanonicalSessionState(collapsedState);
      }
      const cancelBody = encodeCloudAgentCancel({ requestId: trimmedRequestId });
      const groupEnvelope = Object.values(messagesByPeer)
        .flat()
        .map((message) => parseCloudGroupControl(message.body))
        .find((envelope) => (
          envelope?.kind === 'group-message'
          && envelope.groupId === groupId
          && envelope.message?.id === trimmedRequestId
        ));
      const targetAccountIds = [...new Set((groupEnvelope?.participants ?? [])
        .map((participant) => participant.accountId.trim())
        .filter((accountId) => accountId && accountId !== account?.accountId))];
      const sent = await Promise.allSettled(
        targetAccountIds.map((targetAccountId) => client.sendMessage(session.token, targetAccountId, cancelBody)),
      );
      sent.forEach((result) => {
        if (result.status === 'fulfilled') mergeMessage(result.value);
      });
      await refreshCloudBridgeMessages();
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
    await refreshCloudBridgeMessages();
    setCloudBridgeOverrideState(null);
  }, [account, canonicalSessionState?.messages, client, mergeMessage, messagesByPeer, refreshCloudBridgeMessages, setCanonicalSessionState]);

  return {
    cloudBridgeState,
    setCloudBridgeState,
    mergedBridgeState,
    sendCloudBridgeMessage,
    sendCloudGroupControl,
    recordCloudSessionFork,
    updateCloudSessionPin,
    hideCloudSession,
    unhideCloudSession,
    deleteCloudSession,
    cancelCloudBridgeAgentRequest,
    refreshCloudBridgeMessages,
    cloudSessionActivity,
    refreshCloudSessionActivity,
    publishCloudTaskActivity,
    publishCloudArtifactActivity,
    refreshCloudContacts: contacts.refresh,
    initialContactsSettled: contacts.initialLoadSettled,
    initialMessagesSettled,
    cachedMessagesReady: Object.values(messagesByPeer).some((messages) => messages.length > 0),
    cloudHiddenSessionIds,
    cloudDeletedSessionIds,
    cloudSessionPinsById,
    cloudSelfAgentSyncStatusBySessionId: visibleCloudSelfAgentSyncStatusBySessionId,
  };
}
