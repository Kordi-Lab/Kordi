import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { cloudAgentNoProviderNoticeText, isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';
import { isCloudBridgeConversationId } from '@/features/cloud/cloudBridgeState';
import { encodeCloudDirectMessageEnvelope } from '@/features/cloud/cloudDirectMessages';
import {
  cloudGroupMessageSessionId,
  cloudGroupTargetAccountIds,
  shouldRouteMentionThroughCloudGroup,
} from '@/features/cloud/cloudGroupMessages';
import { bridgeConversationIdsToMarkReadOnUserActivity } from '@/features/bridge/readReceipts';
import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  ComposerScope,
  Conversation,
  ConversationBridgeTarget,
  Message,
  DesktopChatState,
  DesktopBridgePromptIdentity,
  DesktopBridgeState,
  DesktopBridgeSessionParticipant,
  DesktopChatTurnSnapshot,
  QueuedDesktopChatMessage,
} from '@/kordi-app/types';
import {
  appendCanonicalMessage,
  createDesktopChatSession,
  openOrCreateCanonicalSession,
  fetchDesktopChatTurnState,
  startDesktopChatMessage,
  upsertCanonicalMessage,
  updateDesktopChatSessionConfig,
  type DesktopChatContextMessage,
} from '@/lib/desktop';

import { CHAT_COMPOSER_TEXTAREA_SELECTOR, formatDesktopEventTime, isSharedLocalSlashCommand, resizeComposerTextarea } from '../composerController.shared';
import type { UseComposerControllerArgs } from '../composerController.types';
import { updateScopeDraft, type ComposerDraftState } from '../composerDrafts';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID, isLocalDraftChatConversationId } from '../draftSessions';
import { NO_PROVIDER_PENDING_LIVE_TURN_PREFIX } from '../desktopLiveTurns';
import {
  localAgentRuntimeText,
  localHumanAddressLabels,
  mentionForBridgeTarget,
  mentionedPersonIsActiveBridgeTarget,
  mentionsLocalAgent,
  resolveMentionedBridgeTarget,
  stripLeadingAddressMentions,
} from './mentions';
import {
  appendOptimisticBridgeMessage,
  appendOptimisticCanonicalMessage,
  appendOptimisticOutboundMessage,
  failedPreparedCanonicalUserMessage,
  optimisticSessionTitleFromMessage,
  findBridgeConversationForTarget,
  markOptimisticBridgeMessageFailed,
  markOptimisticCanonicalMessageFailed,
  persistCanonicalUserMessage,
  prepareCanonicalUserMessage,
} from './optimistic';
import type { PendingBridgeOutreach } from './types';
import { quoteMessageAction } from '../messageActionMetadata';

export type LocalChatSendInFlight = {
  sessionId: string | null;
};

export function bridgeSendFailureDetail(error: unknown, fallback = 'Unable to send bridge message') {
  return error instanceof Error ? error.message : fallback;
}

export function shouldShowBridgeSendFailureNotice(hasInlineFailureTarget: boolean) {
  return !hasInlineFailureTarget;
}

export function shouldAppendOptimisticBridgeMessage(_conversationId: string): boolean {
  return true;
}

function generatedSelfAgentSessionId() {
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `session:self-agent:${randomId}`;
}

export function shouldUseNoProviderSelfAgentShortcut({
  activeConversationUsesBridgeRouting,
  activeConvCanonicalSessionId,
  canonicalSessionState,
  hasAnyDesktopAuth,
}: {
  activeConversationUsesBridgeRouting: boolean;
  activeConvCanonicalSessionId?: string | null;
  canonicalSessionState: CanonicalSessionState | null;
  hasAnyDesktopAuth: boolean;
}) {
  if (hasAnyDesktopAuth) return false;
  if (activeConversationUsesBridgeRouting) return false;
  const sessionId = activeConvCanonicalSessionId?.trim();
  if (!sessionId) return true;
  const session = canonicalSessionState?.sessions.find((candidate) => candidate.id === sessionId);
  return !session || session.kind === 'self-agent';
}

function canonicalIdentityKind(state: CanonicalSessionState, identityId?: string | null): string | null {
  return state.identities.find((identity) => identity.id === identityId)?.kind ?? null;
}

function ownedAgentIdentityId(state: CanonicalSessionState | null, fallbackPrimaryIdentityId?: string | null) {
  const fallback = fallbackPrimaryIdentityId?.trim();
  if (state && fallback && canonicalIdentityKind(state, fallback) === 'agent') return fallback;
  return state?.identities.find((identity) => identity.kind === 'agent' && identity.ownerIdentityId === state.profile.humanIdentityId)?.id ?? null;
}

function mergeCanonicalSessionState(current: CanonicalSessionState | null, next: CanonicalSessionState | null): CanonicalSessionState | null {
  if (!current) return next;
  if (!next) return current;
  const nextSessionIds = new Set(next.sessions.map((session) => session.id));
  const nextMessageIds = new Set(next.messages.map((message) => message.id));
  return {
    ...next,
    sessions: [
      ...next.sessions,
      ...current.sessions.filter((session) => !nextSessionIds.has(session.id)),
    ],
    messages: [
      ...next.messages,
      ...current.messages.filter((message) => !nextMessageIds.has(message.id)),
    ],
  };
}

function appendCanonicalRequestToLocalState(
  current: CanonicalSessionState | null,
  request: AppendCanonicalMessageRequest | null,
): CanonicalSessionState | null {
  if (!current || !request) return current;
  const id = request.id?.trim() || `msg:local:${request.sessionId}:${request.sourceEventId ?? Date.now()}`;
  if (current.messages.some((message) => message.id === id)) return current;
  const createdAtMs = request.createdAtMs ?? Date.now();
  const sequenceNum = current.messages
    .filter((message) => message.sessionId === request.sessionId)
    .reduce((max, message) => Math.max(max, message.sequenceNum), 0) + 1;
  return {
    ...current,
    sessions: current.sessions.map((session) => (
      session.id === request.sessionId
        ? {
            ...session,
            updatedAtMs: Math.max(session.updatedAtMs, createdAtMs),
            lastMessageAtMs: Math.max(session.lastMessageAtMs ?? 0, createdAtMs),
          }
        : session
    )),
    messages: [
      ...current.messages,
      {
        id,
        sessionId: request.sessionId,
        senderIdentityId: request.senderIdentityId,
        senderRole: request.senderRole,
        messageKind: request.messageKind,
        contentText: request.contentText,
        content: request.content ?? {},
        parentMessageId: request.parentMessageId,
        delegatedExchangeId: request.delegatedExchangeId,
        status: request.status ?? 'sent',
        sequenceNum,
        createdAtMs,
        updatedAtMs: createdAtMs,
        contentHash: null,
        sourceTransport: request.sourceTransport,
        sourceEventId: request.sourceEventId,
      },
    ],
  };
}

export function noProviderPendingLiveTurn({
  sessionId,
  requestMessageId,
  text,
  now = Date.now(),
}: {
  sessionId: string;
  requestMessageId: string;
  text: string;
  now?: number;
}): DesktopChatTurnSnapshot {
  return {
    id: `${NO_PROVIDER_PENDING_LIVE_TURN_PREFIX}${requestMessageId}`,
    sessionId,
    prompt: text.trim(),
    status: 'starting',
    message: 'Working…',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    startedAtMs: now,
    completedAtMs: null,
    error: null,
    replyToMessageId: requestMessageId,
  };
}

export function canonicalNoProviderFailedAgentMessageRequest({
  state,
  sessionId,
  requestMessageId,
  now = Date.now(),
}: {
  state: CanonicalSessionState | null;
  sessionId: string;
  requestMessageId: string;
  now?: number;
}): AppendCanonicalMessageRequest | null {
  if (!state) return null;
  const session = state.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  if (!session) return null;
  const agentIdentityId = ownedAgentIdentityId(state, session.primaryIdentityId);
  if (!agentIdentityId) return null;
  const notice = cloudAgentNoProviderNoticeText();
  return {
    id: `msg:no-provider:${requestMessageId}`,
    sessionId,
    senderIdentityId: agentIdentityId,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      sender: 'My Kordi',
      timestampMs: now,
      deliveryState: 'failed',
      requestId: requestMessageId,
      replyToMessageId: requestMessageId,
      error: notice,
    },
    createdAtMs: now,
    parentMessageId: requestMessageId,
    delegatedExchangeId: null,
    status: 'failed',
    sourceTransport: 'desktop-chat-ui',
    sourceEventId: `desktop-chat-ui-no-provider:${sessionId}:${requestMessageId}`,
  };
}

export function localChatSendIsInFlightForTarget(
  inFlight: LocalChatSendInFlight | null,
  targetSessionId: string | null,
) {
  if (!inFlight) return false;
  if (!inFlight.sessionId) return true;
  if (!targetSessionId) return false;
  return inFlight.sessionId === targetSessionId;
}

export function localChatTargetHasRunningTurn(
  desktopLiveTurn: { sessionId?: string | null; completed?: boolean } | null | undefined,
  targetSessionId: string | null,
) {
  return Boolean(targetSessionId && desktopLiveTurn?.sessionId === targetSessionId && !desktopLiveTurn.completed);
}

export type LocalChatSendDelayReason = 'session-starting' | 'same-session-running';

export function localChatSendDelayReason({
  inFlight,
  targetSessionId,
  desktopLiveTurn,
}: {
  inFlight: LocalChatSendInFlight | null;
  targetSessionId: string | null;
  desktopLiveTurn?: { sessionId?: string | null; completed?: boolean } | null;
}): LocalChatSendDelayReason | null {
  if (localChatSendIsInFlightForTarget(inFlight, targetSessionId)) {
    return targetSessionId && inFlight?.sessionId === targetSessionId
      ? 'same-session-running'
      : 'session-starting';
  }
  if (localChatTargetHasRunningTurn(desktopLiveTurn, targetSessionId)) {
    return 'same-session-running';
  }
  return null;
}

export function queuedDesktopChatMessageFromDraft({
  sessionId,
  text,
  time,
  attachments,
  scope = 'chat',
}: {
  sessionId: string;
  text: string;
  time: string;
  attachments: QueuedDesktopChatMessage['attachments'];
  scope?: QueuedDesktopChatMessage['scope'];
}): QueuedDesktopChatMessage {
  const timestamp = Date.now();
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${timestamp}-${Math.random().toString(16).slice(2)}`;
  return {
    id: `queued-local-chat:${sessionId}:${randomId}`,
    sessionId,
    scope,
    text,
    time,
    attachments,
  };
}

export function chatSendIsBusy({
  isDesktopChatSending = false,
  localSendInFlight = false,
}: {
  isDesktopChatSending?: boolean;
  desktopLiveTurn?: { completed?: boolean } | null;
  localSendInFlight?: boolean;
}) {
  return Boolean(isDesktopChatSending || localSendInFlight);
}

export type LocalAgentRelayTurnResult = Pick<DesktopChatTurnSnapshot, 'assistantText' | 'error' | 'succeeded' | 'status'>;
export type LocalAgentRelayTerminalDeliveryState = 'responded' | 'cancelled' | 'processing_failed';

function turnWasCancelled(turn: Pick<LocalAgentRelayTurnResult, 'status'>) {
  return turn.status === 'cancelled' || turn.status === 'cancelling';
}

export function localAgentRelayTerminalDeliveryState(turn: LocalAgentRelayTurnResult): LocalAgentRelayTerminalDeliveryState {
  if (turnWasCancelled(turn)) return 'cancelled';
  return turn.succeeded && turn.assistantText.trim() ? 'responded' : 'processing_failed';
}

export function localAgentRelayFailureText(turn: Pick<LocalAgentRelayTurnResult, 'error' | 'status'>) {
  if (turnWasCancelled(turn)) return 'Stopped';
  return 'Processing failed';
}

export async function awaitRelayProgressBeforeTerminal(
  progressRelayPromise: Promise<void> | null,
  timeoutMs = 1_500,
) {
  if (!progressRelayPromise) return;
  await Promise.race([
    progressRelayPromise,
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, timeoutMs)),
  ]);
}

export async function waitForCompletedDesktopTurn(
  fetchTurnState: (turnId: string) => Promise<DesktopChatTurnSnapshot>,
  turnId: string,
  pollIntervalMs = 60,
) {
  let turn = await fetchTurnState(turnId);
  while (!turn.completed) {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, pollIntervalMs));
    turn = await fetchTurnState(turn.id);
  }
  return turn;
}

export function bridgeConversationSendPlan({
  activeConvId,
  hasMaterializedBridgeConversation,
  existingTargetConversationId,
  shouldStayInCanonicalSession,
}: {
  activeConvId: string;
  hasMaterializedBridgeConversation: boolean;
  existingTargetConversationId?: string | null;
  shouldStayInCanonicalSession: boolean;
}) {
  const targetConversationId = hasMaterializedBridgeConversation
    ? activeConvId
    : existingTargetConversationId ?? null;

  return {
    targetConversationId,
    shouldOpenBeforeOptimisticSend: !targetConversationId && !shouldStayInCanonicalSession,
    canAppendBridgeOptimisticMessage: Boolean(targetConversationId),
  };
}

function cleanText(value?: string | null) {
  return value?.trim() || null;
}

function bridgeTargetIsAgent(target?: ConversationBridgeTarget | null) {
  const runtime = cleanText(target?.runtime);
  return Boolean(cleanText(target?.agentId) || (runtime && isBridgeAgentRuntime(runtime)));
}

export function bridgeSessionOutreachTarget(target: ConversationBridgeTarget) {
  const targetIsAgent = bridgeTargetIsAgent(target);
  const displayName = cleanText(target.displayName) ?? cleanText(target.ownerName);
  const ownerName = cleanText(target.ownerName) ?? (targetIsAgent ? null : displayName);
  return {
    targetKind: targetIsAgent ? 'bridge-agent' as const : 'bridge-person' as const,
    targetRuntime: targetIsAgent ? (cleanText(target.runtime) ?? 'kordi-desktop') : 'person',
    targetDisplayName: displayName,
    targetOwnerName: ownerName,
    targetHumanId: targetIsAgent ? null : cleanText(target.humanId),
    targetAgentId: targetIsAgent ? cleanText(target.agentId) : null,
  };
}

function participantIsSelf(participant: NonNullable<Conversation['canonicalParticipants']>[number]) {
  return participant.role === 'self' || (participant.source === 'local' && participant.kind === 'human');
}

export function isBridgeGroupSession(conversation?: {
  canonicalSessionId?: string | null;
  participantSpaceId?: string | null;
  directness?: string | null;
  canonicalParticipants?: Conversation['canonicalParticipants'];
} | null) {
  if (!conversation) return false;
  if (conversation.canonicalSessionId?.startsWith('session:group:')) return true;
  if (conversation.participantSpaceId?.startsWith('group:')) return true;
  if (/\bgroup\b/i.test(conversation.directness ?? '')) return true;
  const humanCount = (conversation.canonicalParticipants ?? [])
    .filter((participant) => participant.kind === 'human' && !participantIsSelf(participant))
    .length;
  return humanCount > 1;
}

export function bridgeGroupSessionSpaceId(conversation?: {
  canonicalSessionId?: string | null;
  participantSpaceId?: string | null;
} | null) {
  const participantSpaceId = cleanText(conversation?.participantSpaceId);
  if (participantSpaceId) {
    return participantSpaceId.startsWith('group:') ? participantSpaceId.slice('group:'.length) : participantSpaceId;
  }
  return cleanText(conversation?.canonicalSessionId);
}

function asSelfBridgeNodeIdSet(value?: ReadonlySet<string> | Iterable<string | null | undefined> | null) {
  if (!value) return new Set<string>();
  if (value instanceof Set) return value;
  const result = new Set<string>();
  for (const entry of value) {
    const cleaned = cleanText(entry);
    if (cleaned) result.add(cleaned);
  }
  return result;
}

export function bridgeGroupSessionSendTargets(
  conversation: Pick<Conversation, 'canonicalParticipants'>,
  fallbackTarget?: ConversationBridgeTarget | null,
  selfBridgeNodeIds?: ReadonlySet<string> | Iterable<string | null | undefined> | null,
) {
  const targets = new Map<string, ConversationBridgeTarget>();
  const fallbackHostId = cleanText(fallbackTarget?.hostId);
  const selfNodeIdSet = asSelfBridgeNodeIdSet(selfBridgeNodeIds);

  for (const participant of conversation.canonicalParticipants ?? []) {
    if (participant.kind !== 'human' || participantIsSelf(participant)) continue;
    const nodeId = cleanText(participant.bridgeNodeId);
    if (nodeId && selfNodeIdSet.has(nodeId)) continue;
    const hostId = cleanText(participant.bridgeHostId) ?? fallbackHostId;
    if (!nodeId || !hostId) continue;
    targets.set(`${hostId}:${nodeId}:${cleanText(participant.humanId) ?? ''}`, {
      hostId,
      nodeId,
      displayName: cleanText(participant.name),
      ownerName: cleanText(participant.ownerName) ?? cleanText(participant.name),
      runtime: 'person',
      humanId: cleanText(participant.humanId),
      agentId: null,
    });
  }

  if (targets.size === 0
    && fallbackTarget?.hostId
    && fallbackTarget.nodeId
    && !selfNodeIdSet.has(fallbackTarget.nodeId)
  ) {
    targets.set(`${fallbackTarget.hostId}:${fallbackTarget.nodeId}:${fallbackTarget.humanId ?? ''}`, {
      ...fallbackTarget,
      runtime: 'person',
      agentId: null,
    });
  }

  return [...targets.values()];
}

export function shouldUseBridgeConversationRouting({
  activeConversationIsBridge,
  activeConvBridgeTarget,
  activeGroupSessionScope,
  selfBridgeNodeIds,
}: {
  activeConversationIsBridge: boolean;
  activeConvBridgeTarget?: ConversationBridgeTarget | null;
  activeGroupSessionScope?: (Pick<Conversation, 'canonicalParticipants'> & {
    canonicalSessionId?: string | null;
    participantSpaceId?: string | null;
    directness?: string | null;
  }) | null;
  selfBridgeNodeIds?: ReadonlySet<string> | Iterable<string | null | undefined> | null;
}) {
  return activeConversationIsBridge
    || Boolean(activeConvBridgeTarget)
    || Boolean(
      isBridgeGroupSession(activeGroupSessionScope)
      && bridgeGroupSessionSendTargets(activeGroupSessionScope ?? {}, activeConvBridgeTarget, selfBridgeNodeIds).length > 0,
    );
}

export function activeLocalTurnShouldDelayChatSend({
  activeConversationUsesBridgeRouting,
  activeConvId,
  desktopLiveTurn,
}: {
  activeConversationUsesBridgeRouting: boolean;
  activeConvId: string;
  desktopLiveTurn?: { sessionId?: string | null; completed?: boolean } | null;
}) {
  return !activeConversationUsesBridgeRouting
    && !activeConvId.startsWith('bridge:')
    && !isLocalDraftChatConversationId(activeConvId)
    && localChatTargetHasRunningTurn(desktopLiveTurn, activeConvId);
}

export function localChatTargetSessionIdForActiveConversation({
  activeConvId,
  activeConvCanonicalSessionId,
  desktopActiveSessionId,
}: {
  activeConvId: string;
  activeConvCanonicalSessionId?: string | null;
  desktopActiveSessionId?: string | null;
}) {
  const activeSessionId = activeConvId.trim();
  if (isLocalDraftChatConversationId(activeSessionId)) return null;

  const canonicalSessionId = activeConvCanonicalSessionId?.trim() ?? '';
  if (canonicalSessionId && !isLocalDraftChatConversationId(canonicalSessionId)) {
    return canonicalSessionId;
  }

  if (activeSessionId && !activeSessionId.startsWith('bridge:')) {
    return activeSessionId;
  }

  const desktopSessionId = desktopActiveSessionId?.trim() ?? '';
  if (desktopSessionId && !isLocalDraftChatConversationId(desktopSessionId)) {
    return desktopSessionId;
  }

  return null;
}

export function chatDraftSessionIdsToClearForSend(activeSessionId: string, resolvedSessionId: string) {
  return [activeSessionId, resolvedSessionId]
    .map((sessionId) => sessionId.trim())
    .filter((sessionId, index, sessionIds) => Boolean(sessionId) && sessionIds.indexOf(sessionId) === index);
}

function messageAuthorKind(message: Message): 'human' | 'agent' {
  if (message.senderType === 'agent' || message.role === 'owned-agent' || message.role === 'external-agent') return 'agent';
  return 'human';
}

function messageContextText(message: Message): string {
  return (message.turn?.assistantText ?? message.text).trim();
}

function cloudSelfAgentMessageId(message: Message): string | null {
  const id = message.id?.trim() || message.entryId?.trim() || '';
  return id.startsWith('msg:cloud:self:') ? id : null;
}

export function restoredCloudSelfAgentContextMessages(messages: readonly Message[]): DesktopChatContextMessage[] {
  return messages.flatMap((message) => {
    const id = cloudSelfAgentMessageId(message);
    const text = messageContextText(message);
    if (!id || !text) return [];
    const authorKind = messageAuthorKind(message);
    return [{
      id,
      authorName: message.sender?.trim() || (authorKind === 'agent' ? 'My Kordi' : 'Me'),
      authorKind,
      text,
      createdAtMs: null,
    }];
  });
}

export function bridgeLocalAgentMentionCanRelayToBridge({
  activeGroupSessionIsGroup,
  activeConvBridgeTarget,
  hasLocalAgentMention,
}: {
  activeGroupSessionIsGroup: boolean;
  activeConvBridgeTarget?: ConversationBridgeTarget | null;
  hasLocalAgentMention: boolean;
}) {
  return Boolean(hasLocalAgentMention && (activeGroupSessionIsGroup || activeConvBridgeTarget));
}

export function bridgeLocalAgentRelayTargets(
  conversation: { canonicalParticipants?: Conversation['canonicalParticipants']; directness?: string | null },
  fallbackTarget?: ConversationBridgeTarget | null,
  selfBridgeNodeIds?: ReadonlySet<string> | Iterable<string | null | undefined> | null,
) {
  if (isBridgeGroupSession(conversation)) {
    return bridgeGroupSessionSendTargets(conversation, fallbackTarget, selfBridgeNodeIds);
  }
  if (!fallbackTarget?.hostId || !fallbackTarget.nodeId) return [];
  const selfNodeIdSet = asSelfBridgeNodeIdSet(selfBridgeNodeIds);
  if (selfNodeIdSet.has(fallbackTarget.nodeId)) return [];
  return [{ ...fallbackTarget, runtime: 'person', agentId: null }];
}

export function bridgeGroupMentionRelayTargets(
  conversation: Pick<Conversation, 'canonicalParticipants'> & { directness?: string | null },
  mentionedTarget?: { peer?: { nodeId?: string | null; humanId?: string | null } | null } | null,
  fallbackTarget?: ConversationBridgeTarget | null,
  selfBridgeNodeIds?: ReadonlySet<string> | Iterable<string | null | undefined> | null,
) {
  if (!isBridgeGroupSession(conversation)) return [];
  const mentionedNodeId = cleanText(mentionedTarget?.peer?.nodeId);
  const mentionedHumanId = cleanText(mentionedTarget?.peer?.humanId);
  return bridgeGroupSessionSendTargets(conversation, fallbackTarget, selfBridgeNodeIds).filter((target) => {
    if (mentionedHumanId && target.humanId === mentionedHumanId) return false;
    if (mentionedNodeId && target.nodeId === mentionedNodeId) return false;
    return true;
  });
}

function isSelfReferencePeerLabel(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase() ?? '';
  return trimmed === 'me' || trimmed === 'you';
}

export function bridgeGroupSessionParticipants(
  conversation: Pick<Conversation, 'canonicalParticipants'>,
  options: { selfPublicName?: string | null } = {},
): DesktopBridgeSessionParticipant[] {
  const selfPublicName = cleanText(options.selfPublicName ?? undefined);
  const participants = new Map<string, DesktopBridgeSessionParticipant>();
  for (const participant of conversation.canonicalParticipants ?? []) {
    if (participant.kind !== 'human') continue;
    const rawDisplayName = cleanText(participant.name);
    if (!rawDisplayName) continue;
    const bridgeNodeId = cleanText(participant.bridgeNodeId);
    const humanId = cleanText(participant.humanId);
    const isSelf = participantIsSelf(participant);
    if (isSelf && !bridgeNodeId && !humanId) continue;
    // Don't broadcast self-reference labels like "Me"/"You" to other peers — those collide on
    // the receiver side and end up rendered as "Me" for every group member.
    const displayName = isSelf && isSelfReferencePeerLabel(rawDisplayName) && selfPublicName
      ? selfPublicName
      : rawDisplayName;
    participants.set(participant.id || `${bridgeNodeId ?? ''}:${humanId ?? ''}:${displayName}`, {
      identityId: cleanText(participant.id),
      displayName,
      kind: 'human',
      role: isSelf ? 'self' : (cleanText(participant.role) ?? 'person'),
      bridgeNodeId,
      humanId,
      runtime: 'person',
    });
  }
  return [...participants.values()];
}

function initiatorIdentityForBridgeHost(
  activeBridgeHost: DesktopBridgeState['hosts'][number] | null | undefined,
  canonicalHumanIdentityId: string | null | undefined,
): DesktopBridgePromptIdentity | null {
  const displayName = cleanText(activeBridgeHost?.ownerName) || cleanText(activeBridgeHost?.displayName);
  if (!displayName && !canonicalHumanIdentityId) return null;
  return {
    identityId: canonicalHumanIdentityId || activeBridgeHost?.humanId || activeBridgeHost?.id || null,
    displayName: displayName ?? 'Me',
    kind: 'human',
    bridgeNodeId: activeBridgeHost?.nodeId ?? null,
    humanId: activeBridgeHost?.humanId ?? null,
    runtime: 'person',
  };
}

type UseChatMessageActionsArgs = Pick<
  UseComposerControllerArgs,
  | 'activeConversationIsBridge'
  | 'activeConvBridgeTarget'
  | 'activeConvCanonicalSessionId'
  | 'activeConvId'
  | 'activeConvMessages'
  | 'activeConvMentionScope'
  | 'canonicalHumanIdentityId'
  | 'chatComposerAttachments'
  | 'composerSelections'
  | 'composerDrafts'
  | 'activeChatQuote'
  | 'desktopBridgeState'
  | 'desktopChatState'
  | 'canonicalSessionState'
  | 'hasAnyDesktopAuth'
  | 'desktopLiveTurn'
  | 'isNativeShell'
  | 'isDesktopChatSending'
  | 'queuedDesktopMessagesBySession'
  | 'refreshDesktopChat'
  | 'setActiveConvId'
  | 'setCanonicalSessionState'
  | 'setChatComposerAttachments'
  | 'setComposerDrafts'
  | 'setCloudBridgeState'
  | 'sendCloudBridgeMessage'
  | 'sendCloudGroupControl'
  | 'setDesktopChatError'
  | 'setDesktopChatState'
  | 'setDesktopLiveTurnsBySession'
  | 'setIsDesktopChatSending'
  | 'setOpenComposerSelector'
  | 'setPendingUserChatMessage'
  | 'setQueuedDesktopMessagesBySession'
  | 'shouldAutoFollowChatRef'
  | 'watchDesktopLiveTurn'
> & {
  attachmentSummaryText: (text: string) => string;
  handleLocalSlashCommand: (rawText: string, scope?: ComposerScope) => Promise<boolean>;
  pendingBridgeCancelRequestedRef: MutableRefObject<boolean>;
  localChatSendInFlightRef: MutableRefObject<LocalChatSendInFlight | null>;
  userCancelledTurnIdsRef: MutableRefObject<Set<string>>;
  setPendingBridgeOutreach: Dispatch<SetStateAction<PendingBridgeOutreach | null>>;
};

export function useChatMessageActions({
  activeConversationIsBridge,
  activeConvBridgeTarget,
  activeConvCanonicalSessionId,
  activeConvId,
  activeConvMessages,
  activeConvMentionScope,
  attachmentSummaryText,
  canonicalHumanIdentityId,
  chatComposerAttachments,
  composerSelections,
  composerDrafts,
  activeChatQuote,
  desktopBridgeState,
  desktopChatState,
  canonicalSessionState,
  hasAnyDesktopAuth,
  desktopLiveTurn,
  handleLocalSlashCommand,
  isNativeShell,
  queuedDesktopMessagesBySession,
  pendingBridgeCancelRequestedRef,
  localChatSendInFlightRef,
  userCancelledTurnIdsRef,
  refreshDesktopChat,
  setActiveConvId,
  setCanonicalSessionState,
  setChatComposerAttachments,
  setComposerDrafts,
  setCloudBridgeState,
  sendCloudBridgeMessage,
  sendCloudGroupControl,
  setDesktopChatError,
  setDesktopChatState,
  setDesktopLiveTurnsBySession,
  setIsDesktopChatSending,
  setOpenComposerSelector,
  setPendingBridgeOutreach,
  setPendingUserChatMessage,
  setQueuedDesktopMessagesBySession,
  shouldAutoFollowChatRef,
  watchDesktopLiveTurn,
}: UseChatMessageActionsArgs) {
  const queuedDesktopMessagesBySessionRef = useRef(queuedDesktopMessagesBySession);
  const flushQueuedDesktopMessagesForSessionRef = useRef<(sessionId: string) => void>(() => {});

  useEffect(() => {
    queuedDesktopMessagesBySessionRef.current = queuedDesktopMessagesBySession;
  }, [queuedDesktopMessagesBySession]);

  const setQueuedDesktopMessagesBySessionNow = useCallback((next: Record<string, QueuedDesktopChatMessage[]>) => {
    queuedDesktopMessagesBySessionRef.current = next;
    setQueuedDesktopMessagesBySession(next);
  }, [setQueuedDesktopMessagesBySession]);

  const enqueueLocalQueuedMessage = useCallback((message: QueuedDesktopChatMessage, position: 'back' | 'front' = 'back') => {
    const current = queuedDesktopMessagesBySessionRef.current;
    const existing = current[message.sessionId] ?? [];
    const nextMessages = position === 'front' ? [message, ...existing] : [...existing, message];
    setQueuedDesktopMessagesBySessionNow({
      ...current,
      [message.sessionId]: nextMessages,
    });
  }, [setQueuedDesktopMessagesBySessionNow]);

  const dequeueLocalQueuedMessage = useCallback((sessionId: string) => {
    const current = queuedDesktopMessagesBySessionRef.current;
    const existing = current[sessionId] ?? [];
    const [message, ...remaining] = existing;
    if (!message) return null;
    const next = { ...current };
    if (remaining.length > 0) {
      next[sessionId] = remaining;
    } else {
      delete next[sessionId];
    }
    setQueuedDesktopMessagesBySessionNow(next);
    return message;
  }, [setQueuedDesktopMessagesBySessionNow]);

  const queueLocalDraftForSession = useCallback((sessionId: string, draftText: string, attachments: QueuedDesktopChatMessage['attachments']) => {
    const queuedMessage = queuedDesktopChatMessageFromDraft({
      sessionId,
      text: draftText,
      time: formatDesktopEventTime(),
      attachments,
    });
    enqueueLocalQueuedMessage(queuedMessage);
    shouldAutoFollowChatRef.current = true;
    setDesktopChatError(null);
    setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', sessionId, ''));
    setChatComposerAttachments([]);
    resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
  }, [enqueueLocalQueuedMessage, setChatComposerAttachments, setComposerDrafts, setDesktopChatError, shouldAutoFollowChatRef]);

  const watchLocalTurnAndFlushQueue = useCallback((
    turn: DesktopChatTurnSnapshot,
    onComplete?: (finalTurn: DesktopChatTurnSnapshot) => Promise<void> | void,
  ) => {
    const cleanup = () => {
      if (localChatSendInFlightRef.current?.sessionId === turn.sessionId) {
        localChatSendInFlightRef.current = null;
      }
      flushQueuedDesktopMessagesForSessionRef.current(turn.sessionId);
    };
    if (turn.completed && isCloudAgentNoProviderConfiguredError(turn.error || turn.message || turn.assistantText)) {
      void Promise.resolve(onComplete?.(turn)).finally(cleanup);
      return;
    }
    void watchDesktopLiveTurn(turn)
      .then(async () => {
        if (!onComplete) return;
        const finalTurn = await fetchDesktopChatTurnState(turn.id).catch(() => turn);
        await onComplete(finalTurn);
      })
      .finally(cleanup);
  }, [localChatSendInFlightRef, watchDesktopLiveTurn]);

  const sendQueuedLocalMessage = useCallback(async (message: QueuedDesktopChatMessage) => {
    const delayReason = localChatSendDelayReason({
      inFlight: localChatSendInFlightRef.current,
      targetSessionId: message.sessionId,
      desktopLiveTurn: null,
    });
    if (delayReason) {
      enqueueLocalQueuedMessage(message, 'front');
      return;
    }

    localChatSendInFlightRef.current = { sessionId: message.sessionId };
    try {
      setDesktopChatError(null);
      const attachmentPaths = message.attachments.map((item) => item.path);
      const previewText = attachmentSummaryText(message.text);
      const turn = await startDesktopChatMessage(message.sessionId, message.text, attachmentPaths);
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        message.sessionId,
        canonicalHumanIdentityId,
        message.text,
        message.attachments,
        message.time,
        'desktop-chat-ui',
        'sending',
      );
      setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
      setDesktopChatState((current) => current
        ? appendOptimisticOutboundMessage(current, message.sessionId, previewText, message.text, message.attachments, message.time)
        : current);
      await persistCanonicalUserMessage(preparedCanonicalMessage).catch((error: unknown) => {
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to save queued message');
      });
      watchLocalTurnAndFlushQueue(turn);
    } catch (error) {
      if (localChatSendInFlightRef.current?.sessionId === message.sessionId) {
        localChatSendInFlightRef.current = null;
      }
      enqueueLocalQueuedMessage(message, 'front');
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to send queued chat message');
    }
  }, [attachmentSummaryText, canonicalHumanIdentityId, enqueueLocalQueuedMessage, localChatSendInFlightRef, setCanonicalSessionState, setDesktopChatError, setDesktopChatState, watchLocalTurnAndFlushQueue]);

  useEffect(() => {
    flushQueuedDesktopMessagesForSessionRef.current = (sessionId: string) => {
      const nextMessage = dequeueLocalQueuedMessage(sessionId);
      if (!nextMessage) return;
      void sendQueuedLocalMessage(nextMessage);
    };
  }, [dequeueLocalQueuedMessage, sendQueuedLocalMessage]);

  useEffect(() => {
    if (!isNativeShell || activeConversationIsBridge || activeConvId.startsWith('bridge:') || isLocalDraftChatConversationId(activeConvId)) return;
    if ((queuedDesktopMessagesBySession[activeConvId] ?? []).length === 0) return;
    const delayReason = localChatSendDelayReason({
      inFlight: localChatSendInFlightRef.current,
      targetSessionId: activeConvId,
      desktopLiveTurn,
    });
    if (delayReason) return;
    flushQueuedDesktopMessagesForSessionRef.current(activeConvId);
  }, [activeConvId, activeConversationIsBridge, desktopLiveTurn, isNativeShell, localChatSendInFlightRef, queuedDesktopMessagesBySession]);

  return useCallback(async (draftOverride?: string) => {
    if (!isNativeShell) return;
    const rawText = draftOverride ?? composerDrafts.chat;
    const text = rawText.trim();
    if (!text && chatComposerAttachments.length === 0) return;

    const mentionedTarget = resolveMentionedBridgeTarget(text, desktopBridgeState, activeConvMentionScope, { targetKind: 'bridge-agent' });
    const activeGroupSessionScope = {
      canonicalSessionId: activeConvCanonicalSessionId ?? activeConvId,
      participantSpaceId: activeConvMentionScope?.participantSpaceId,
      directness: activeConvMentionScope?.directness,
      canonicalParticipants: activeConvMentionScope?.canonicalParticipants,
    };
    const localBridgeNodeIds = new Set(
      (desktopBridgeState?.hosts ?? [])
        .map((host) => host.nodeId?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    const activeGroupSessionIsGroup = isBridgeGroupSession(activeGroupSessionScope);
    const localAgentMentioned = mentionsLocalAgent(text, desktopChatState, desktopBridgeState);
    const activeConversationUsesBridgeRouting = shouldUseBridgeConversationRouting({
      activeConversationIsBridge,
      activeConvBridgeTarget,
      activeGroupSessionScope,
      selfBridgeNodeIds: localBridgeNodeIds,
    });
    const activeGroupSessionSpaceId = activeGroupSessionIsGroup ? bridgeGroupSessionSpaceId(activeGroupSessionScope) : null;
    const activeBridgeHost = desktopBridgeState?.hosts.find((host) => host.id === desktopBridgeState.activeHostId)
      ?? desktopBridgeState?.hosts[0]
      ?? null;
    const selfPublicBridgeName = activeBridgeHost?.ownerName?.trim()
      || activeBridgeHost?.displayName?.trim()
      || null;
    const bridgePromptInitiatorIdentity = initiatorIdentityForBridgeHost(
      activeBridgeHost,
      canonicalHumanIdentityId,
    );
    const activeGroupSessionParticipants = activeGroupSessionIsGroup
      ? bridgeGroupSessionParticipants(activeGroupSessionScope, { selfPublicName: selfPublicBridgeName })
      : [];
    const allGroupSendTargets = activeGroupSessionIsGroup
      ? bridgeGroupSessionSendTargets(activeGroupSessionScope, activeConvBridgeTarget, localBridgeNodeIds)
      : [];
    const cloudGroupTargetIds = cloudGroupTargetAccountIds(allGroupSendTargets);

    if (activeLocalTurnShouldDelayChatSend({ activeConversationUsesBridgeRouting, activeConvId, desktopLiveTurn })) {
      const leadingCommand = text.split(/\s+/, 1)[0] ?? text;
      if (chatComposerAttachments.length === 0 && isSharedLocalSlashCommand(leadingCommand)) {
        setDesktopChatError('Commands are unavailable while this session is running. Your draft is preserved.');
        return;
      }
      queueLocalDraftForSession(activeConvId, text, chatComposerAttachments);
      return;
    }

    if (activeConversationUsesBridgeRouting && isCloudBridgeConversationId(activeConvId)) {
      if (!sendCloudBridgeMessage || !setCloudBridgeState) {
        setDesktopChatError('Chat is still loading. Try again in a moment.');
        return;
      }
      const sentAt = formatDesktopEventTime();
      const optimisticMessageId = `cloud-pending-${Date.now()}`;
      const appendedOptimisticBridgeMessage = shouldAppendOptimisticBridgeMessage(activeConvId);
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, ''));
        setChatComposerAttachments([]);
        resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
        if (appendedOptimisticBridgeMessage) {
          setCloudBridgeState((current) => appendOptimisticBridgeMessage(current, activeConvId, text, sentAt, optimisticMessageId, chatComposerAttachments, attachmentSummaryText(text)));
        }
        const cloudBody = activeChatQuote?.source
          ? encodeCloudDirectMessageEnvelope({
              schemaVersion: 1,
              kind: 'message',
              text,
              messageAction: quoteMessageAction(activeChatQuote.source),
            })
          : text;
        await sendCloudBridgeMessage(activeConvId, cloudBody, chatComposerAttachments);
        if (appendedOptimisticBridgeMessage && isCloudBridgeConversationId(activeConvId)) {
          setCloudBridgeState(null);
        }
      } catch (error) {
        const failureDetail = bridgeSendFailureDetail(error, 'Unable to send message');
        if (appendedOptimisticBridgeMessage) {
          setCloudBridgeState((current) => markOptimisticBridgeMessageFailed(current, activeConvId, optimisticMessageId, failureDetail));
        }
        setDesktopChatError(failureDetail);
      } finally {
        setIsDesktopChatSending(false);
      }
      return;
    }

    if (activeConversationUsesBridgeRouting && shouldRouteMentionThroughCloudGroup({
      mentionedHostId: mentionedTarget?.host.id,
      activeGroupSessionIsGroup,
      mentionsLocalAgent: localAgentMentioned,
      mentionsBridgeAgent: mentionedTarget?.targetKind === 'bridge-agent',
      hasCloudGroupRecipients: cloudGroupTargetIds.length > 0,
    })) {
      if (!activeConvCanonicalSessionId) {
        setDesktopChatError('Unable to open group chat.');
        return;
      }
      if (!sendCloudGroupControl) {
        setDesktopChatError('Group chat is still loading. Try again in a moment.');
        return;
      }
      if (cloudGroupTargetIds.length === 0) {
        setDesktopChatError('Unable to resolve group recipients.');
        return;
      }
      const sentAt = formatDesktopEventTime();
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        activeConvCanonicalSessionId,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'cloud-group-ui',
        'sent',
        mentionForBridgeTarget(mentionedTarget),
        activeChatQuote,
      );
      if (preparedCanonicalMessage) {
        preparedCanonicalMessage.request.content = {
          ...(preparedCanonicalMessage.request.content && typeof preparedCanonicalMessage.request.content === 'object' ? preparedCanonicalMessage.request.content : {}),
          deliveryState: 'delivered',
        };
      }
      let canonicalUserMessagePersisted = false;
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, ''));
        setChatComposerAttachments([]);
        resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
        setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
        await persistCanonicalUserMessage(preparedCanonicalMessage);
        canonicalUserMessagePersisted = true;
        await sendCloudGroupControl({
          targetAccountIds: cloudGroupTargetIds,
          kind: 'group-message',
          groupId: cloudGroupMessageSessionId({ activeConvCanonicalSessionId, activeGroupSessionSpaceId }),
          groupSpaceId: activeGroupSessionSpaceId,
          groupTitle: null,
          bridgeParticipants: activeGroupSessionParticipants,
          message: {
            id: preparedCanonicalMessage?.messageId ?? `cloud-group-message-${Date.now()}`,
            senderAccountId: '',
            text,
            createdAtMs: Date.now(),
            messageAction: activeChatQuote?.source ? quoteMessageAction(activeChatQuote.source) : null,
          },
          attachments: chatComposerAttachments,
        });
      } catch (error) {
        const failureDetail = bridgeSendFailureDetail(error, 'Unable to send group mention');
        setDesktopChatError(failureDetail);
        setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
          current,
          activeConvCanonicalSessionId,
          preparedCanonicalMessage?.messageId ?? null,
          failureDetail,
        ));
        if (!canonicalUserMessagePersisted) {
          void persistCanonicalUserMessage(failedPreparedCanonicalUserMessage(preparedCanonicalMessage, failureDetail))
            .catch((saveError: unknown) => {
              setDesktopChatError(saveError instanceof Error ? saveError.message : 'Unable to save message');
            });
        }
      } finally {
        setIsDesktopChatSending(false);
      }
      return;
    }

    if (mentionedTarget && activeConversationUsesBridgeRouting) {
      setDesktopChatError('This chat is unavailable. Try again from the chat list.');
      return;
    }

    if (activeConversationUsesBridgeRouting && !localAgentMentioned) {
      setDesktopChatError('This chat is unavailable. Try again from the chat list.');
      return;
    }

    const isTransientDraftConversation = isLocalDraftChatConversationId(activeConvId);
    let targetSessionId = localChatTargetSessionIdForActiveConversation({
      activeConvId,
      activeConvCanonicalSessionId,
      desktopActiveSessionId: desktopChatState?.activeSessionId,
    });
    if (chatComposerAttachments.length === 0 && (await handleLocalSlashCommand(text))) {
      setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, ''));
      resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
      setOpenComposerSelector(null);
      return;
    }

    const noProviderShortcutSessionId = activeConvCanonicalSessionId?.trim()
      || (isTransientDraftConversation ? generatedSelfAgentSessionId() : null);
    if (noProviderShortcutSessionId && shouldUseNoProviderSelfAgentShortcut({
      activeConversationUsesBridgeRouting,
      activeConvCanonicalSessionId: activeConvCanonicalSessionId?.trim() || null,
      canonicalSessionState,
      hasAnyDesktopAuth,
    })) {
      const sentAt = formatDesktopEventTime();
      let canonicalBaseState = canonicalSessionState;
      const existingCanonicalSession = canonicalSessionState?.sessions.find((session) => session.id === noProviderShortcutSessionId) ?? null;
      if (!existingCanonicalSession && canonicalHumanIdentityId) {
        const primaryIdentityId = ownedAgentIdentityId(canonicalSessionState);
        if (primaryIdentityId) {
          canonicalBaseState = await openOrCreateCanonicalSession({
            id: noProviderShortcutSessionId,
            kind: 'self-agent',
            title: optimisticSessionTitleFromMessage(text, chatComposerAttachments, 'New session'),
            status: 'active',
            createdByIdentityId: canonicalHumanIdentityId,
            primaryIdentityId,
            participantIdentityIds: [canonicalHumanIdentityId, primaryIdentityId],
            metadata: { createdFrom: 'chat-create-flow' },
          });
        }
      }
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        noProviderShortcutSessionId,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'desktop-chat-ui',
        'sent',
        [],
        activeChatQuote,
      );
      const failedReplyRequest = preparedCanonicalMessage
        ? canonicalNoProviderFailedAgentMessageRequest({
            state: canonicalBaseState,
            sessionId: noProviderShortcutSessionId,
            requestMessageId: preparedCanonicalMessage.messageId,
          })
        : null;
      const pendingNoProviderTurn = preparedCanonicalMessage
        ? noProviderPendingLiveTurn({
            sessionId: noProviderShortcutSessionId,
            requestMessageId: preparedCanonicalMessage.messageId,
            text,
          })
        : null;
      shouldAutoFollowChatRef.current = true;
      setIsDesktopChatSending(true);
      setDesktopChatError(null);
      setPendingUserChatMessage(null);
      if (isTransientDraftConversation) setActiveConvId(noProviderShortcutSessionId);
      setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(
        mergeCanonicalSessionState(current, canonicalBaseState),
        preparedCanonicalMessage,
      ));
      if (pendingNoProviderTurn) {
        setDesktopLiveTurnsBySession((current) => ({
          ...current,
          [pendingNoProviderTurn.sessionId]: pendingNoProviderTurn,
        }));
      }
      setComposerDrafts((current: ComposerDraftState) => (
        chatDraftSessionIdsToClearForSend(activeConvId, noProviderShortcutSessionId).reduce(
          (next, sessionId) => updateScopeDraft(next, 'chat', sessionId, ''),
          current,
        )
      ));
      setChatComposerAttachments([]);
      resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
      setIsDesktopChatSending(false);
      if (preparedCanonicalMessage) {
        void upsertCanonicalMessage(preparedCanonicalMessage.request)
          .catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
          });
      }
      if (failedReplyRequest) {
        window.setTimeout(() => {
          if (pendingNoProviderTurn) {
            setDesktopLiveTurnsBySession((current) => {
              if (current[pendingNoProviderTurn.sessionId]?.id !== pendingNoProviderTurn.id) return current;
              const { [pendingNoProviderTurn.sessionId]: _removed, ...rest } = current;
              return rest;
            });
          }
          setCanonicalSessionState((current) => appendCanonicalRequestToLocalState(current, failedReplyRequest));
          void appendCanonicalMessage(failedReplyRequest).catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to save provider notice');
          });
        }, 450);
      }
      return;
    }

    let materializedState: DesktopChatState | null = null;
    const ensureLocalSessionId = async () => {
      if (targetSessionId) {
        if (!activeConvBridgeTarget && desktopChatState?.activeSessionId !== targetSessionId) {
          await refreshDesktopChat(targetSessionId);
        }
        return targetSessionId;
      }

      if (isTransientDraftConversation) {
        await updateDesktopChatSessionConfig(
          LOCAL_DRAFT_CHAT_CONVERSATION_ID,
          composerSelections.chat.model,
          composerSelections.chat.thinking,
        );
      }
      materializedState = await createDesktopChatSession();
      targetSessionId = materializedState.activeSessionId;
      setDesktopChatState(materializedState);
      setActiveConvId(targetSessionId);
      return targetSessionId;
    };

    if (mentionedTarget) {
      setDesktopChatError('This chat is unavailable. Try again from the chat list.');
      return;
    }

    const localTargetSessionId = targetSessionId ?? null;
    const localSendDelayReason = localChatSendDelayReason({
      inFlight: localChatSendInFlightRef.current,
      targetSessionId: localTargetSessionId,
      desktopLiveTurn,
    });
    if (localSendDelayReason === 'same-session-running' && localTargetSessionId) {
      queueLocalDraftForSession(localTargetSessionId, text, chatComposerAttachments);
      return;
    }
    if (localSendDelayReason) {
      setDesktopChatError('Kordi is still preparing this session. Your draft and attachments are preserved.');
      return;
    }
    localChatSendInFlightRef.current = { sessionId: localTargetSessionId };

    try {
      shouldAutoFollowChatRef.current = true;
      setIsDesktopChatSending(true);
      setDesktopChatError(null);
      const resolvedSessionId = await ensureLocalSessionId();
      localChatSendInFlightRef.current = { sessionId: resolvedSessionId };

      const sentAt = formatDesktopEventTime();
      const attachmentPaths = chatComposerAttachments.map((item) => item.path);
      const previewText = attachmentSummaryText(text);
      const restoredCloudContextMessages = restoredCloudSelfAgentContextMessages(activeConvMessages);
      setPendingUserChatMessage(null);
      const parentSessionIdForMessage = activeConvCanonicalSessionId ?? resolvedSessionId;
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        parentSessionIdForMessage,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'desktop-chat-ui',
        'sending',
        [],
        activeChatQuote,
      );
      const noProviderLocalShortcut = shouldUseNoProviderSelfAgentShortcut({
        activeConversationUsesBridgeRouting,
        activeConvCanonicalSessionId,
        canonicalSessionState,
        hasAnyDesktopAuth,
      });
      if (noProviderLocalShortcut && preparedCanonicalMessage) {
        const canonicalSessionId = parentSessionIdForMessage;
        const existingCanonicalSession = canonicalSessionState?.sessions.find((session) => session.id === canonicalSessionId) ?? null;
        let canonicalBaseState = canonicalSessionState;
        if (!existingCanonicalSession && canonicalHumanIdentityId) {
          const primaryIdentityId = ownedAgentIdentityId(canonicalSessionState);
          if (primaryIdentityId) {
            canonicalBaseState = await openOrCreateCanonicalSession({
              id: canonicalSessionId,
              kind: 'self-agent',
              title: optimisticSessionTitleFromMessage(text, chatComposerAttachments, 'New session'),
              status: 'active',
              createdByIdentityId: canonicalHumanIdentityId,
              primaryIdentityId,
              participantIdentityIds: [canonicalHumanIdentityId, primaryIdentityId],
              metadata: { createdFrom: 'chat-create-flow' },
            });
          }
        }
        const sentUserRequest = {
          ...preparedCanonicalMessage.request,
          status: 'sent',
          content: {
            ...(preparedCanonicalMessage.request.content && typeof preparedCanonicalMessage.request.content === 'object' ? preparedCanonicalMessage.request.content : {}),
            deliveryState: 'sent',
          },
        };
        const failedReplyRequest = canonicalNoProviderFailedAgentMessageRequest({
          state: canonicalBaseState,
          sessionId: canonicalSessionId,
          requestMessageId: preparedCanonicalMessage.messageId,
        });
        if (!failedReplyRequest) {
          localChatSendInFlightRef.current = null;
          setIsDesktopChatSending(false);
          setDesktopChatError(cloudAgentNoProviderNoticeText());
          return;
        }
        const pendingNoProviderTurn = noProviderPendingLiveTurn({
          sessionId: canonicalSessionId,
          requestMessageId: preparedCanonicalMessage.messageId,
          text,
        });
        const nextCanonicalState = appendCanonicalRequestToLocalState(canonicalBaseState, sentUserRequest);
        if (nextCanonicalState) setCanonicalSessionState(nextCanonicalState);
        setDesktopLiveTurnsBySession((current) => ({
          ...current,
          [pendingNoProviderTurn.sessionId]: pendingNoProviderTurn,
        }));
        setDesktopChatState((current) => {
          const baseState = materializedState && current?.activeSessionId !== resolvedSessionId
            ? materializedState
            : current;
          return baseState
            ? appendOptimisticOutboundMessage(baseState, resolvedSessionId, previewText, text, chatComposerAttachments, sentAt)
            : current;
        });
        setComposerDrafts((current: ComposerDraftState) => (
          chatDraftSessionIdsToClearForSend(activeConvId, resolvedSessionId).reduce(
            (next, sessionId) => updateScopeDraft(next, 'chat', sessionId, ''),
            current,
          )
        ));
        setChatComposerAttachments([]);
        resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
        localChatSendInFlightRef.current = null;
        setIsDesktopChatSending(false);
        void upsertCanonicalMessage(sentUserRequest).catch((error: unknown) => {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
        });
        window.setTimeout(() => {
          setDesktopLiveTurnsBySession((current) => {
            if (current[pendingNoProviderTurn.sessionId]?.id !== pendingNoProviderTurn.id) return current;
            const { [pendingNoProviderTurn.sessionId]: _removed, ...rest } = current;
            return rest;
          });
          setCanonicalSessionState((current) => appendCanonicalRequestToLocalState(current, failedReplyRequest));
          void appendCanonicalMessage(failedReplyRequest).catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to save provider notice');
          });
        }, 450);
        return;
      }
      setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
      setDesktopChatState((current) => {
        const baseState = materializedState && current?.activeSessionId !== resolvedSessionId
          ? materializedState
          : current;
        if (!baseState) {
          return current;
        }
        return appendOptimisticOutboundMessage(baseState, resolvedSessionId, previewText, text, chatComposerAttachments, sentAt);
      });
      setComposerDrafts((current: ComposerDraftState) => (
        chatDraftSessionIdsToClearForSend(activeConvId, resolvedSessionId).reduce(
          (next, sessionId) => updateScopeDraft(next, 'chat', sessionId, ''),
          current,
        )
      ));
      setChatComposerAttachments([]);
      resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
      void persistCanonicalUserMessage(preparedCanonicalMessage)
        .catch((error: unknown) => {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
        })
        .then(() => startDesktopChatMessage(resolvedSessionId, text, attachmentPaths, null, restoredCloudContextMessages))
        .then((turn) => {
          watchLocalTurnAndFlushQueue(turn, async (finalTurn) => {
            const noProviderFailure = isCloudAgentNoProviderConfiguredError(finalTurn.error || finalTurn.message || finalTurn.assistantText);
            if (!noProviderFailure || !activeConvCanonicalSessionId || !preparedCanonicalMessage) return;
            const sentUserRequest = {
              ...preparedCanonicalMessage.request,
              status: 'sent',
              content: {
                ...(preparedCanonicalMessage.request.content && typeof preparedCanonicalMessage.request.content === 'object' ? preparedCanonicalMessage.request.content : {}),
                deliveryState: 'sent',
              },
            };
            try {
              const stateAfterUser = await upsertCanonicalMessage(sentUserRequest);
              const failedReplyRequest = canonicalNoProviderFailedAgentMessageRequest({
                state: stateAfterUser ?? canonicalSessionState,
                sessionId: activeConvCanonicalSessionId,
                requestMessageId: preparedCanonicalMessage.messageId,
              });
              const nextState = failedReplyRequest ? await appendCanonicalMessage(failedReplyRequest) : stateAfterUser;
              if (nextState) setCanonicalSessionState(nextState);
            } catch (error) {
              setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
                current,
                activeConvCanonicalSessionId,
                preparedCanonicalMessage.messageId,
                cloudAgentNoProviderNoticeText(),
              ));
              setDesktopChatError(error instanceof Error ? error.message : 'Unable to save provider notice');
            }
          });
          setIsDesktopChatSending(false);
        })
        .catch((error: unknown) => {
          setPendingUserChatMessage(null);
          if (localChatSendInFlightRef.current?.sessionId === resolvedSessionId) {
            localChatSendInFlightRef.current = null;
          }
          setIsDesktopChatSending(false);
          if (isCloudAgentNoProviderConfiguredError(error) && activeConvCanonicalSessionId && preparedCanonicalMessage) {
            setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
              current,
              activeConvCanonicalSessionId,
              preparedCanonicalMessage.messageId,
              cloudAgentNoProviderNoticeText(),
            ));
            setDesktopChatError(null);
            return;
          }
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to send chat message');
        });
    } catch (error) {
      setPendingUserChatMessage(null);
      localChatSendInFlightRef.current = null;
      setIsDesktopChatSending(false);
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to send chat message');
    }
  }, [
    activeConversationIsBridge,
    activeConvBridgeTarget,
    activeConvCanonicalSessionId,
    activeConvId,
    activeConvMessages,
    activeConvMentionScope,
    activeChatQuote,
    attachmentSummaryText,
    chatComposerAttachments,
    canonicalHumanIdentityId,
    composerDrafts.chat,
    composerSelections.chat.model,
    composerSelections.chat.thinking,
    desktopBridgeState,
    desktopChatState,
    canonicalSessionState,
    hasAnyDesktopAuth,
    desktopLiveTurn,
    handleLocalSlashCommand,
    isNativeShell,
    localChatSendInFlightRef,
    queueLocalDraftForSession,
    refreshDesktopChat,
    setActiveConvId,
    setCanonicalSessionState,
    setChatComposerAttachments,
    setComposerDrafts,
    setCloudBridgeState,
    sendCloudBridgeMessage,
    sendCloudGroupControl,
    setDesktopChatError,
    setDesktopChatState,
    setIsDesktopChatSending,
    setOpenComposerSelector,
    setPendingUserChatMessage,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
    watchLocalTurnAndFlushQueue,
  ]);


}
