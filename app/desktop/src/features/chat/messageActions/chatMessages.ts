import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { localAgentRuntimeRouteForBridgeState } from '@/features/bridge/agentModelRouting';
import { isCloudBridgeConversationId } from '@/features/cloud/cloudBridgeState';
import {
  cloudGroupMessageSessionId,
  cloudGroupTargetAccountIds,
  nonCloudGroupTargets,
  shouldRouteMentionThroughCloudGroup,
} from '@/features/cloud/cloudGroupMessages';
import { bridgeConversationIdsToMarkReadOnUserActivity } from '@/features/bridge/readReceipts';
import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import { markBridgeConversationsReadInState, mergeDesktopBridgeState } from '@/features/bridge/useBridgeState';
import type {
  ComposerScope,
  Conversation,
  ConversationBridgeTarget,
  DesktopChatState,
  DesktopBridgePromptIdentity,
  DesktopBridgeState,
  DesktopBridgeSessionParticipant,
  DesktopChatTurnSnapshot,
  QueuedDesktopChatMessage,
} from '@/kordi-app/types';
import {
  cancelDesktopBridgeOutreach,
  createDesktopBridgeOutreach,
  createDesktopChatSession,
  fetchDesktopChatTurnState,
  markDesktopBridgeConversationRead,
  openDesktopBridgeConversation,
  sendDesktopBridgeMessage,
  startDesktopChatMessage,
  updateDesktopChatSessionConfig,
} from '@/lib/desktop';

import { CHAT_COMPOSER_TEXTAREA_SELECTOR, formatDesktopEventTime, isSharedLocalSlashCommand, resizeComposerTextarea } from '../composerController.shared';
import type { UseComposerControllerArgs } from '../composerController.types';
import { updateScopeDraft, type ComposerDraftState } from '../composerDrafts';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID, isLocalDraftChatConversationId } from '../draftSessions';
import { combineContext, parentSessionMessagesForOutreach, renderProjectContext, renderRecentMessageContext } from './context';
import {
  localAgentRuntimeText,
  localHumanAddressLabels,
  mentionForBridgeTarget,
  mentionedPersonIsActiveBridgeTarget,
  mentionsLocalAgent,
  outreachIdentityForBridgeTarget,
  publicLocalAgentMentionText,
  resolveMentionedBridgeTarget,
  stripLeadingAddressMentions,
} from './mentions';
import {
  appendOptimisticBridgeMessage,
  appendOptimisticCanonicalMessage,
  appendOptimisticOutboundMessage,
  bridgeAttachmentTransportFields,
  failedPreparedCanonicalUserMessage,
  findBridgeConversationForTarget,
  markOptimisticBridgeMessageFailed,
  markOptimisticCanonicalMessageFailed,
  persistCanonicalUserMessage,
  prepareCanonicalUserMessage,
} from './optimistic';
import { pendingOutreachFromState, relaySharedSessionMessage } from './relay';
import type { RelaySharedSessionMessageOptions } from './relay';
import type { PendingBridgeOutreach } from './types';

export type LocalChatSendInFlight = {
  sessionId: string | null;
};

export function bridgeSendFailureDetail(error: unknown, fallback = 'Unable to send bridge message') {
  return error instanceof Error ? error.message : fallback;
}

export function shouldShowBridgeSendFailureNotice(hasInlineFailureTarget: boolean) {
  return !hasInlineFailureTarget;
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
  | 'desktopBridgeState'
  | 'desktopChatState'
  | 'desktopLiveTurn'
  | 'isNativeShell'
  | 'isDesktopChatSending'
  | 'queuedDesktopMessagesBySession'
  | 'refreshDesktopChat'
  | 'setActiveConvId'
  | 'setCanonicalSessionState'
  | 'setChatComposerAttachments'
  | 'setComposerDrafts'
  | 'setDesktopBridgeState'
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
  desktopBridgeState,
  desktopChatState,
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
  setDesktopBridgeState,
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

  const watchLocalTurnAndFlushQueue = useCallback((turn: DesktopChatTurnSnapshot) => {
    void watchDesktopLiveTurn(turn).finally(() => {
      if (localChatSendInFlightRef.current?.sessionId === turn.sessionId) {
        localChatSendInFlightRef.current = null;
      }
      flushQueuedDesktopMessagesForSessionRef.current(turn.sessionId);
    });
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
        setDesktopChatError('Cloud chat is still loading. Try again in a moment.');
        return;
      }
      const sentAt = formatDesktopEventTime();
      const optimisticMessageId = `cloud-pending-${Date.now()}`;
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, ''));
        setChatComposerAttachments([]);
        resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
        setCloudBridgeState((current) => appendOptimisticBridgeMessage(current, activeConvId, text, sentAt, optimisticMessageId, chatComposerAttachments, attachmentSummaryText(text)));
        await sendCloudBridgeMessage(activeConvId, text, chatComposerAttachments);
      } catch (error) {
        const failureDetail = bridgeSendFailureDetail(error, 'Unable to send cloud message');
        setCloudBridgeState((current) => markOptimisticBridgeMessageFailed(current, activeConvId, optimisticMessageId, failureDetail));
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
        setDesktopChatError('Unable to resolve Cloud group session.');
        return;
      }
      if (!sendCloudGroupControl) {
        setDesktopChatError('Cloud group chat is still loading. Try again in a moment.');
        return;
      }
      if (cloudGroupTargetIds.length === 0) {
        setDesktopChatError('Unable to resolve Cloud group recipients.');
        return;
      }
      const sentAt = formatDesktopEventTime();
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        activeConvCanonicalSessionId,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'desktop-bridge-ui',
        'sent',
        mentionForBridgeTarget(mentionedTarget),
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
          },
          attachments: chatComposerAttachments,
        });
      } catch (error) {
        const failureDetail = bridgeSendFailureDetail(error, 'Unable to send Cloud group mention');
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
      try {
        shouldAutoFollowChatRef.current = true;
        pendingBridgeCancelRequestedRef.current = false;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, ''));
        setChatComposerAttachments([]);
        resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
        const sentAt = formatDesktopEventTime();
        const parentSessionId = activeConvCanonicalSessionId ?? activeConvId;
        const groupMentionRelayTargets = activeGroupSessionIsGroup
          ? bridgeGroupMentionRelayTargets(activeGroupSessionScope, mentionedTarget, activeConvBridgeTarget, localBridgeNodeIds)
          : [];
        const mentionIsSessionMessage = Boolean(
          activeGroupSessionIsGroup
          || (activeConvCanonicalSessionId && mentionedPersonIsActiveBridgeTarget(mentionedTarget, activeConvBridgeTarget)),
        );
        const preparedCanonicalMessage = prepareCanonicalUserMessage(
          parentSessionId,
          canonicalHumanIdentityId,
          text,
          chatComposerAttachments,
          sentAt,
          'desktop-bridge-ui',
          'sent',
          mentionForBridgeTarget(mentionedTarget),
        );
        setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
        void persistCanonicalUserMessage(preparedCanonicalMessage)
          .catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
            return preparedCanonicalMessage?.messageId ?? null;
          })
          .then(async (parentMessageId) => {
            const primaryState = await createDesktopBridgeOutreach({
              hostId: mentionedTarget.host.id,
              targetNodeId: mentionedTarget.peer.nodeId,
              targetKind: mentionedTarget.targetKind,
              requestText: mentionIsSessionMessage ? text : mentionedTarget.requestText,
              ...outreachIdentityForBridgeTarget(mentionedTarget),
              triggerText: text,
              contextText: mentionIsSessionMessage
                ? null
                : combineContext(
                  renderProjectContext(desktopChatState),
                  renderRecentMessageContext(activeConvMessages),
                ),
              contextPolicy: mentionIsSessionMessage ? 'session-message' : 'recent-window',
              parentSessionId,
              parentSessionTitle: mentionIsSessionMessage ? null : desktopChatState?.activeSession.title,
              parentSessionKind: activeGroupSessionIsGroup ? 'group' : null,
              parentGroupSpaceId: activeGroupSessionSpaceId,
              parentSessionParticipants: activeGroupSessionParticipants,
              parentSessionMessages: mentionIsSessionMessage ? [] : parentSessionMessagesForOutreach(activeConvMessages),
              initiatorIdentity: bridgePromptInitiatorIdentity,
              parentMessageId,
              projectId: mentionIsSessionMessage ? null : desktopChatState?.activeSession.project?.root,
              projectName: mentionIsSessionMessage ? null : desktopChatState?.activeSession.project?.name,
              ...bridgeAttachmentTransportFields(chatComposerAttachments),
            });
            let nextState = primaryState;
            for (const relayTarget of groupMentionRelayTargets) {
              const relayState = await createDesktopBridgeOutreach({
                hostId: relayTarget.hostId,
                targetNodeId: relayTarget.nodeId,
                targetKind: 'bridge-person',
                requestText: text,
                targetDisplayName: relayTarget.displayName ?? relayTarget.ownerName ?? null,
                targetOwnerName: relayTarget.ownerName ?? relayTarget.displayName ?? null,
                targetRuntime: 'person',
                targetHumanId: relayTarget.humanId ?? null,
                targetAgentId: null,
                triggerText: null,
                contextText: null,
                contextPolicy: 'session-message',
                parentSessionId,
                parentSessionTitle: null,
                parentSessionKind: 'group',
                parentGroupSpaceId: activeGroupSessionSpaceId,
                parentSessionParticipants: activeGroupSessionParticipants,
                parentSessionMessages: [],
                initiatorIdentity: bridgePromptInitiatorIdentity,
                parentMessageId,
                projectId: null,
                projectName: null,
                ...bridgeAttachmentTransportFields(chatComposerAttachments),
              });
              nextState = mergeDesktopBridgeState(nextState, relayState) ?? relayState;
            }
            return { primaryState, nextState };
          })
          .then(({ primaryState, nextState }) => {
            if (mentionedTarget.targetKind === 'bridge-agent') {
              const pending = pendingOutreachFromState(primaryState, parentSessionId, mentionedTarget.peer.nodeId);
              if (pendingBridgeCancelRequestedRef.current && pending) {
                pendingBridgeCancelRequestedRef.current = false;
                void cancelDesktopBridgeOutreach(pending.conversationId, pending.requestId)
                  .then((cancelledState) => {
                    setDesktopBridgeState((current) => mergeDesktopBridgeState(current, cancelledState));
                  })
                  .catch((error: unknown) => {
                    setDesktopChatError(error instanceof Error ? error.message : 'Unable to stop bridge outreach');
                  })
                  .finally(() => {
                    setPendingBridgeOutreach(null);
                    setIsDesktopChatSending(false);
                  });
              } else if (pending) {
                setPendingBridgeOutreach(pending);
              } else {
                setPendingBridgeOutreach(null);
                setIsDesktopChatSending(false);
              }
            }
            setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
          })
          .catch((error: unknown) => {
            if (mentionedTarget.targetKind === 'bridge-agent') {
              setPendingBridgeOutreach(null);
              setIsDesktopChatSending(false);
            }
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to start outreach');
          });
      } catch (error) {
        if (mentionedTarget.targetKind === 'bridge-agent') {
          setPendingBridgeOutreach(null);
        }
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to start outreach');
      } finally {
        if (mentionedTarget.targetKind !== 'bridge-agent') {
          setIsDesktopChatSending(false);
        }
      }
      return;
    }

    if (activeConversationUsesBridgeRouting && !localAgentMentioned) {
      const sentAt = formatDesktopEventTime();
      const previewText = attachmentSummaryText(text);
      const bridgeMessageText = text;
      const optimisticMessageId = `bridge-pending-${Date.now()}`;
      const hasMaterializedBridgeConversation = activeConversationIsBridge && activeConvId.startsWith('bridge:');
      const existingTargetConversation = activeConvBridgeTarget && desktopBridgeState
        ? findBridgeConversationForTarget(desktopBridgeState, activeConvBridgeTarget)
        : null;
      const shouldStayInCanonicalSession = Boolean(activeConvCanonicalSessionId && (activeConvBridgeTarget || activeGroupSessionIsGroup));
      const isGroupSessionMessage = shouldStayInCanonicalSession && activeGroupSessionIsGroup;
      const allGroupSendTargets = isGroupSessionMessage
        ? bridgeGroupSessionSendTargets(activeGroupSessionScope, activeConvBridgeTarget, localBridgeNodeIds)
        : [];
      const groupSendTargets = nonCloudGroupTargets(allGroupSendTargets);
      const cloudGroupTargetIds = cloudGroupTargetAccountIds(allGroupSendTargets);
      const groupSessionParticipants = isGroupSessionMessage ? activeGroupSessionParticipants : [];
      const sendPlan = bridgeConversationSendPlan({
        activeConvId,
        hasMaterializedBridgeConversation,
        existingTargetConversationId: existingTargetConversation?.id ?? null,
        shouldStayInCanonicalSession,
      });
      let targetConversationId = sendPlan.targetConversationId;
      let optimisticCanonicalSessionId: string | null = null;
      let optimisticCanonicalMessageId: string | null = null;
      let preparedCanonicalMessage: ReturnType<typeof prepareCanonicalUserMessage> = null;
      let canonicalUserMessagePersisted = false;
      let optimisticBridgeMessageAppended = false;
      const markCanonicalSendFailed = (detail?: string | null) => {
        const failedSessionId = optimisticCanonicalSessionId;
        const failedMessageId = optimisticCanonicalMessageId;
        if (!failedSessionId || !failedMessageId) return;
        setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
          current,
          failedSessionId,
          failedMessageId,
          detail,
        ));
      };
      const hasInlineSendFailureTarget = () => Boolean(
        optimisticCanonicalMessageId || optimisticBridgeMessageAppended,
      );
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);

        if (sendPlan.shouldOpenBeforeOptimisticSend && activeConvBridgeTarget) {
          const openedState = await openDesktopBridgeConversation(
            activeConvBridgeTarget.hostId,
            activeConvBridgeTarget.nodeId,
            activeConvBridgeTarget.displayName ?? undefined,
            activeConvBridgeTarget.ownerName ?? undefined,
            activeConvBridgeTarget.runtime ?? undefined,
          );
          setDesktopBridgeState((current) => mergeDesktopBridgeState(current, openedState));
          const openedConversation = findBridgeConversationForTarget(openedState, activeConvBridgeTarget);
          if (!openedConversation) {
            throw new Error('Unable to open bridge conversation');
          }
          targetConversationId = openedConversation.id;
          if (!shouldStayInCanonicalSession) {
            setActiveConvId(openedConversation.id);
          }
        }

        if (!targetConversationId && !shouldStayInCanonicalSession) {
          throw new Error('Unable to resolve bridge conversation');
        }

        const optimisticParentSessionId = activeConvCanonicalSessionId ?? targetConversationId;
        if (!optimisticParentSessionId) {
          throw new Error('Unable to resolve bridge conversation');
        }
        preparedCanonicalMessage = prepareCanonicalUserMessage(
          optimisticParentSessionId,
          canonicalHumanIdentityId,
          text,
          chatComposerAttachments,
          sentAt,
          'desktop-bridge-ui',
          shouldStayInCanonicalSession ? 'sent' : 'sending',
        );
        optimisticCanonicalSessionId = optimisticParentSessionId;
        optimisticCanonicalMessageId = preparedCanonicalMessage?.messageId ?? null;
        if (preparedCanonicalMessage && isGroupSessionMessage && cloudGroupTargetIds.length > 0) {
          preparedCanonicalMessage.request.content = {
            ...(preparedCanonicalMessage.request.content && typeof preparedCanonicalMessage.request.content === 'object' ? preparedCanonicalMessage.request.content : {}),
            deliveryState: 'delivered',
          };
        }
        setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
        if (targetConversationId && !isGroupSessionMessage) {
          setDesktopBridgeState((current) => appendOptimisticBridgeMessage(current, targetConversationId!, bridgeMessageText, sentAt, optimisticMessageId, chatComposerAttachments, previewText));
          optimisticBridgeMessageAppended = true;
        }
        const activeBridgeReadConversationIds = bridgeConversationIdsToMarkReadOnUserActivity(
          desktopBridgeState?.conversations ?? [],
          activeConvCanonicalSessionId ?? activeConvId,
        );
        if (activeBridgeReadConversationIds.length > 0) {
          setDesktopBridgeState((current) => markBridgeConversationsReadInState(current, activeBridgeReadConversationIds));
          void Promise.all(activeBridgeReadConversationIds.map((conversationId) => markDesktopBridgeConversationRead(conversationId)))
            .then((states) => {
              setDesktopBridgeState((current) => states.reduce((merged, state) => mergeDesktopBridgeState(merged, state), current));
            })
            .catch(() => {});
        }
        setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, ''));
        setChatComposerAttachments([]);
        resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
        const resolvedConversationId = targetConversationId;
        void (async () => {
          try {
            let nextBridgeState = null;
            if (isGroupSessionMessage && activeConvCanonicalSessionId) {
              if (groupSendTargets.length === 0 && cloudGroupTargetIds.length === 0) {
                throw new Error('Unable to resolve group recipients');
              }
              if (cloudGroupTargetIds.length > 0) {
                if (!sendCloudGroupControl) throw new Error('Cloud group chat is still loading. Try again in a moment.');
                await persistCanonicalUserMessage(preparedCanonicalMessage);
                canonicalUserMessagePersisted = true;
                await sendCloudGroupControl({
                  targetAccountIds: cloudGroupTargetIds,
                  kind: 'group-message',
                  groupId: cloudGroupMessageSessionId({ activeConvCanonicalSessionId, activeGroupSessionSpaceId }),
                  groupSpaceId: activeGroupSessionSpaceId,
                  groupTitle: null,
                  bridgeParticipants: groupSessionParticipants,
                  message: {
                    id: preparedCanonicalMessage?.messageId ?? `cloud-group-message-${Date.now()}`,
                    senderAccountId: '',
                    text: bridgeMessageText,
                    createdAtMs: Date.now(),
                  },
                  attachments: chatComposerAttachments,
                });
              }
              for (const target of groupSendTargets) {
                const nextState = await createDesktopBridgeOutreach({
                  hostId: target.hostId,
                  targetNodeId: target.nodeId,
                  targetKind: 'bridge-person',
                  requestText: bridgeMessageText,
                  targetDisplayName: target.displayName ?? target.ownerName ?? null,
                  targetOwnerName: target.ownerName ?? target.displayName ?? null,
                  targetRuntime: 'person',
                  targetHumanId: target.humanId ?? null,
                  targetAgentId: null,
                  triggerText: null,
                  contextText: null,
                  contextPolicy: 'session-message',
                  parentSessionId: activeConvCanonicalSessionId,
                  parentSessionTitle: null,
                  parentSessionKind: 'group',
                  parentGroupSpaceId: activeGroupSessionSpaceId,
                  parentSessionParticipants: groupSessionParticipants,
                  parentSessionMessages: [],
                  parentTurnId: null,
                  parentMessageId: preparedCanonicalMessage?.messageId ?? null,
                  projectId: null,
                  projectName: null,
                  ...bridgeAttachmentTransportFields(chatComposerAttachments),
                });
                setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
              }
            } else if (shouldStayInCanonicalSession && activeConvBridgeTarget && activeConvCanonicalSessionId) {
              const target = bridgeSessionOutreachTarget(activeConvBridgeTarget);
              const targetIsAgent = target.targetKind === 'bridge-agent';
              nextBridgeState = await createDesktopBridgeOutreach({
                hostId: activeConvBridgeTarget.hostId,
                targetNodeId: activeConvBridgeTarget.nodeId,
                targetKind: target.targetKind,
                requestText: bridgeMessageText,
                targetDisplayName: target.targetDisplayName,
                targetOwnerName: target.targetOwnerName,
                targetRuntime: target.targetRuntime,
                targetHumanId: target.targetHumanId,
                targetAgentId: target.targetAgentId,
                triggerText: null,
                contextText: targetIsAgent
                  ? combineContext(
                    renderProjectContext(desktopChatState),
                    renderRecentMessageContext(activeConvMessages),
                  )
                  : null,
                contextPolicy: targetIsAgent ? 'recent-window' : 'session-message',
                parentSessionId: activeConvCanonicalSessionId,
                parentSessionTitle: null,
                parentSessionKind: activeGroupSessionIsGroup ? 'group' : null,
                parentGroupSpaceId: activeGroupSessionSpaceId,
                parentSessionMessages: targetIsAgent ? parentSessionMessagesForOutreach(activeConvMessages) : [],
                parentTurnId: null,
                parentMessageId: preparedCanonicalMessage?.messageId ?? null,
                projectId: targetIsAgent ? desktopChatState?.activeSession.project?.root : null,
                projectName: targetIsAgent ? desktopChatState?.activeSession.project?.name : null,
                ...bridgeAttachmentTransportFields(chatComposerAttachments),
              });
            } else {
              if (!resolvedConversationId) {
                throw new Error('Unable to resolve bridge conversation');
              }
              nextBridgeState = await sendDesktopBridgeMessage(resolvedConversationId, bridgeMessageText, chatComposerAttachments);
            }
            if (!canonicalUserMessagePersisted) {
              void persistCanonicalUserMessage(preparedCanonicalMessage)
                .catch((error: unknown) => {
                  setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
                });
            }
            if (nextBridgeState) {
              setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextBridgeState));
            }
          } catch (error) {
            const failureDetail = bridgeSendFailureDetail(error);
            if (resolvedConversationId) {
              setDesktopBridgeState((current) => markOptimisticBridgeMessageFailed(current, resolvedConversationId, optimisticMessageId, failureDetail));
            }
            markCanonicalSendFailed(failureDetail);
            if (!canonicalUserMessagePersisted) {
              void persistCanonicalUserMessage(failedPreparedCanonicalUserMessage(preparedCanonicalMessage, failureDetail))
                .catch((saveError: unknown) => {
                  setDesktopChatError(saveError instanceof Error ? saveError.message : 'Unable to save message');
                });
            }
            if (shouldShowBridgeSendFailureNotice(hasInlineSendFailureTarget())) {
              setDesktopChatError(failureDetail);
            }
          }
        })();
      } catch (error) {
        const failureDetail = bridgeSendFailureDetail(error);
        if (targetConversationId) {
          setDesktopBridgeState((current) => markOptimisticBridgeMessageFailed(current, targetConversationId!, optimisticMessageId, failureDetail));
        }
        markCanonicalSendFailed(failureDetail);
        if (!canonicalUserMessagePersisted) {
          void persistCanonicalUserMessage(failedPreparedCanonicalUserMessage(preparedCanonicalMessage, failureDetail))
            .catch((saveError: unknown) => {
              setDesktopChatError(saveError instanceof Error ? saveError.message : 'Unable to save message');
            });
        }
        if (shouldShowBridgeSendFailureNotice(hasInlineSendFailureTarget())) {
          setDesktopChatError(failureDetail);
        }
      } finally {
        setIsDesktopChatSending(false);
      }
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
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, ''));
        setChatComposerAttachments([]);
        resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
        const parentSessionId = await ensureLocalSessionId();
        const sentAt = formatDesktopEventTime();
        const preparedCanonicalMessage = prepareCanonicalUserMessage(
          parentSessionId,
          canonicalHumanIdentityId,
          text,
          chatComposerAttachments,
          sentAt,
          'desktop-chat-ui',
          'sent',
          mentionForBridgeTarget(mentionedTarget),
        );
        setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
        setDesktopChatState((current) => {
          const baseState = materializedState && current?.activeSessionId !== parentSessionId
            ? materializedState
            : current;
          if (!baseState) return current;
          return appendOptimisticOutboundMessage(baseState, parentSessionId, text, text, chatComposerAttachments, sentAt, mentionForBridgeTarget(mentionedTarget));
        });
        void persistCanonicalUserMessage(preparedCanonicalMessage)
          .catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
            return preparedCanonicalMessage?.messageId ?? null;
          })
          .then((parentMessageId) => createDesktopBridgeOutreach({
            hostId: mentionedTarget.host.id,
            targetNodeId: mentionedTarget.peer.nodeId,
            targetKind: mentionedTarget.targetKind,
            requestText: mentionedTarget.requestText,
            ...outreachIdentityForBridgeTarget(mentionedTarget),
            triggerText: text,
            contextText: combineContext(
              renderProjectContext(desktopChatState),
              renderRecentMessageContext(activeConvMessages),
            ),
            contextPolicy: 'recent-window',
            parentSessionId,
            parentSessionTitle: desktopChatState?.activeSession.title,
            parentSessionMessages: parentSessionMessagesForOutreach(activeConvMessages),
            parentMessageId,
            projectId: desktopChatState?.activeSession.project?.root,
            projectName: desktopChatState?.activeSession.project?.name,
            ...bridgeAttachmentTransportFields(chatComposerAttachments),
          }))
          .then((nextState) => {
            setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
          })
          .catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to start outreach');
          });
      } catch (error) {
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to start outreach');
      } finally {
        setIsDesktopChatSending(false);
      }
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
      setPendingUserChatMessage(null);
      const parentSessionIdForMessage = activeConvCanonicalSessionId ?? resolvedSessionId;
      const willRelayToLocalAgent = bridgeLocalAgentMentionCanRelayToBridge({
        activeGroupSessionIsGroup,
        activeConvBridgeTarget,
        hasLocalAgentMention: mentionsLocalAgent(text, desktopChatState, desktopBridgeState),
      });
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        parentSessionIdForMessage,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'desktop-chat-ui',
        willRelayToLocalAgent ? 'sent' : 'sending',
      );
      const localAgentRelayTargets = willRelayToLocalAgent
        ? bridgeLocalAgentRelayTargets(activeGroupSessionScope, activeConvBridgeTarget, localBridgeNodeIds)
        : [];
      const localAgentRelayPlan = localAgentRelayTargets.length > 0
        ? {
            targets: localAgentRelayTargets,
            parentSessionId: parentSessionIdForMessage,
            parentMessageId: preparedCanonicalMessage?.messageId ?? null,
            parentSessionTitle: desktopChatState?.activeSession.title ?? null,
            parentSessionKind: activeGroupSessionIsGroup ? 'group' : null,
            parentGroupSpaceId: activeGroupSessionSpaceId,
            parentSessionParticipants: activeGroupSessionParticipants,
          }
        : null;
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
      const relayToLocalAgentTargets = async (
        requestText: string,
        parentTurnId?: string | null,
        deliveryState?: 'processing' | LocalAgentRelayTerminalDeliveryState,
        bridgeRequestId?: string | null,
        options: Pick<RelaySharedSessionMessageOptions, 'attachments' | 'taskTools'> = {},
      ) => {
        if (!localAgentRelayPlan) return;
        for (const target of localAgentRelayPlan.targets) {
          const nextState = await relaySharedSessionMessage(
            target,
            localAgentRelayPlan.parentSessionId,
            requestText,
            localAgentRelayPlan.parentSessionTitle,
            localAgentRelayPlan.parentMessageId,
            parentTurnId,
            deliveryState,
            bridgeRequestId,
            {
              parentSessionKind: localAgentRelayPlan.parentSessionKind,
              parentGroupSpaceId: localAgentRelayPlan.parentGroupSpaceId,
              parentSessionParticipants: localAgentRelayPlan.parentSessionParticipants,
              attachments: options.attachments,
              taskTools: options.taskTools,
            },
          );
          setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
        }
      };
      const runtimeMessageText = localAgentRelayPlan
        ? localAgentRuntimeText(text, desktopChatState, desktopBridgeState)
        : text;
      if (localAgentRelayPlan) {
        setIsDesktopChatSending(true);
        const optimisticLiveTurnId = `local-agent-starting:${preparedCanonicalMessage?.messageId ?? Date.now()}`;
        setDesktopLiveTurnsBySession((current) => ({
          ...current,
          [resolvedSessionId]: {
            id: optimisticLiveTurnId,
            sessionId: resolvedSessionId,
            prompt: runtimeMessageText,
            status: 'starting',
            message: 'Starting…',
            assistantText: '',
            thinkingText: '',
            tools: [],
            completed: false,
            succeeded: false,
            error: null,
          },
        }));
      }
      void persistCanonicalUserMessage(preparedCanonicalMessage)
        .catch((error: unknown) => {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
        })
        .then(async () => {
          const userRelayPromise = localAgentRelayPlan
            ? relayToLocalAgentTargets(
              publicLocalAgentMentionText(text, desktopBridgeState),
              null,
              undefined,
              undefined,
              { attachments: chatComposerAttachments },
            ).catch((error: unknown) => {
              setDesktopChatError(error instanceof Error ? error.message : 'Unable to relay local agent request');
            })
            : null;
          const turn = await startDesktopChatMessage(
            resolvedSessionId,
            runtimeMessageText,
            attachmentPaths,
            localAgentRelayPlan ? localAgentRuntimeRouteForBridgeState(desktopBridgeState, desktopChatState) : null,
          );
          const localAgentBridgeRequestId = `bridge_req_${turn.id.replace(/[^a-zA-Z0-9]/g, '')}`;
          let processingRelayPromise: Promise<void> | null = null;
          if (localAgentRelayPlan) {
            await userRelayPromise;
            processingRelayPromise = relayToLocalAgentTargets(
              'processing...',
              turn.id,
              'processing',
              localAgentBridgeRequestId,
            ).catch((error: unknown) => {
              setDesktopChatError(error instanceof Error ? error.message : 'Unable to relay local agent progress');
            });
          }
          return { turn, processingRelayPromise, localAgentBridgeRequestId };
        })
        .then(({ turn, processingRelayPromise, localAgentBridgeRequestId }) => {
          if (!localAgentRelayPlan) {
            watchLocalTurnAndFlushQueue(turn);
            setIsDesktopChatSending(false);
            return;
          }

          void (async () => {
            let completedTurn: DesktopChatTurnSnapshot | null = null;
            try {
              await watchDesktopLiveTurn(turn);
              completedTurn = await waitForCompletedDesktopTurn(fetchDesktopChatTurnState, turn.id);
              await awaitRelayProgressBeforeTerminal(processingRelayPromise);
              const assistantText = stripLeadingAddressMentions(
                completedTurn.assistantText.trim(),
                localHumanAddressLabels(desktopBridgeState),
              );
              const userCancelledThisTurn = userCancelledTurnIdsRef.current.delete(completedTurn.id)
                || userCancelledTurnIdsRef.current.delete(turn.id);
              const turnStatusForRelay = userCancelledThisTurn ? 'cancelled' : completedTurn.status;
              const terminalDeliveryState = localAgentRelayTerminalDeliveryState({
                assistantText,
                error: completedTurn.error,
                succeeded: completedTurn.succeeded,
                status: turnStatusForRelay,
              });
              await relayToLocalAgentTargets(
                terminalDeliveryState === 'responded'
                  ? assistantText
                  : localAgentRelayFailureText({ error: completedTurn.error, status: turnStatusForRelay }),
                completedTurn.id,
                terminalDeliveryState,
                localAgentBridgeRequestId,
                { taskTools: completedTurn.tools },
              );
            } catch (error) {
              await awaitRelayProgressBeforeTerminal(processingRelayPromise);
              const userCancelledThisTurn = userCancelledTurnIdsRef.current.delete(turn.id)
                || (completedTurn && userCancelledTurnIdsRef.current.delete(completedTurn.id));
              const wasCancelled = userCancelledThisTurn
                || completedTurn?.status === 'cancelled'
                || completedTurn?.status === 'cancelling';
              const fallbackTurn = completedTurn
                ? { error: completedTurn.error, status: wasCancelled ? 'cancelled' as const : completedTurn.status }
                : { error: error instanceof Error ? error.message : null, status: wasCancelled ? 'cancelled' as const : 'failed' as const };
              await relayToLocalAgentTargets(
                localAgentRelayFailureText(fallbackTurn),
                completedTurn?.id ?? turn.id,
                wasCancelled ? 'cancelled' : 'processing_failed',
                localAgentBridgeRequestId,
                completedTurn ? { taskTools: completedTurn.tools } : undefined,
              );
              throw error;
            } finally {
              if (localChatSendInFlightRef.current?.sessionId === resolvedSessionId) {
                localChatSendInFlightRef.current = null;
              }
              setIsDesktopChatSending(false);
              flushQueuedDesktopMessagesForSessionRef.current(resolvedSessionId);
            }
          })().catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to relay local agent response');
          });
        })
        .catch((error: unknown) => {
          if (localAgentRelayPlan) {
            if (localChatSendInFlightRef.current?.sessionId === resolvedSessionId) {
              localChatSendInFlightRef.current = null;
            }
            setIsDesktopChatSending(false);
            setDesktopLiveTurnsBySession((current) => {
              if (!current[resolvedSessionId]) return current;
              const { [resolvedSessionId]: _removed, ...rest } = current;
              return rest;
            });
          }
          setPendingUserChatMessage(null);
          if (localChatSendInFlightRef.current?.sessionId === resolvedSessionId) {
            localChatSendInFlightRef.current = null;
          }
          setIsDesktopChatSending(false);
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
    attachmentSummaryText,
    chatComposerAttachments,
    canonicalHumanIdentityId,
    composerDrafts.chat,
    composerSelections.chat.model,
    composerSelections.chat.thinking,
    desktopBridgeState,
    desktopChatState,
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
    setDesktopBridgeState,
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
