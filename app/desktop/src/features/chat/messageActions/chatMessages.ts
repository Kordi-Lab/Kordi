import { useCallback, useEffect, useMemo, useRef } from 'react';

import { cloudAgentNoProviderNoticeText, isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';
import { isCloudCollaborationConversationId } from '@/features/cloud/cloudCollaborationState';
import { encodeCloudDirectMessageEnvelope } from '@/features/cloud/cloudDirectMessages';
import {
  cloudGroupMessageSessionId,
  cloudGroupTargetAccountIds,
  shouldRouteMentionThroughCloudGroup,
} from '@/features/cloud/cloudGroupMessages';
import { cloudAgentContextMessagesFromConversation } from '@/features/chat/chatCreateFlows';
import { resolvedPublishedAgentRuntimeRoute } from '@/features/chat/agentSessionRuntimeRoute';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  ComposerScope,
  Conversation,
  ConversationCollaborationTarget,
  Message,
  DesktopChatState,
  DesktopCollaborationState,
  DesktopChatTurnSnapshot,
  QueuedDesktopChatMessage,
} from '@/kordi-app/types';
import {
  appendCanonicalMessage,
  createDesktopChatSession,
  fetchDesktopChatTurnState,
  openOrCreateCanonicalSession,
  startDesktopChatMessage,
  upsertCanonicalMessage,
  upsertCanonicalMessageFast,
  updateCanonicalMessageDelivery,
  updateDesktopChatSessionConfig,
  type DesktopChatContextMessage,
} from '@/lib/desktop';
import { CHAT_COMPOSER_TEXTAREA_SELECTOR, formatDesktopEventTime, isSharedLocalSlashCommand, resizeComposerTextarea } from '../composerController.shared';
import type { AttachmentItem } from '../composerController.types';
import { updateScopeDraft, type ComposerDraftState } from '../composerDrafts';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID, isLocalDraftChatConversationId } from '../draftSessions';
import { messageMentionsForSend } from '../messageMentions';
import {
  mentionsLocalAgent,
  resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh,
} from './mentions';
import {
  appendOptimisticCollaborationMessage,
  appendOptimisticCanonicalMessage,
  appendOptimisticOutboundMessage,
  failedPreparedCanonicalUserMessage,
  optimisticSessionTitleFromMessage,
  markOptimisticCollaborationMessageSending,
  markOptimisticCanonicalMessageFailed,
  markOptimisticCanonicalMessageSending,
  persistCanonicalUserMessage,
  prepareCanonicalUserMessage,
  retryAttachmentItemsFromMessage,
  voiceMessageDraftFromAttachments,
  type PreparedCanonicalUserMessage,
} from './optimistic';
import { reconcileOptimisticCollaborationMessageUpdater } from './optimisticReconciliation';
import {
  markOptimisticCanonicalMessageSent,
  sentPreparedCanonicalUserMessage,
} from './canonicalDelivery';
import {
  collaborationSendFailureDetail,
  createCloudCollaborationClientMessageId,
  failedCanonicalGroupMessageRequest,
  shouldAppendOptimisticCollaborationMessage,
  terminalCollaborationSendFailure,
} from './collaborationSendLifecycle';
import {
  fetchMaterializedLocalChatTarget,
  generatedSelfAgentSessionId,
  shouldUseNoProviderSelfAgentShortcut,
} from './localAgentSessionTarget';
import type {
  LocalChatSendInFlight,
  PendingCollaborationOutreach,
  UseChatMessageActionsArgs,
} from './types';
import { quoteMessageAction } from '../messageActionMetadata';
import { memeAttachmentDraftError } from '../memeAttachments';
import { sessionTitleMetadata } from '../sessionTitlePolicy';
import {
  collaborationDirectSessionParticipants,
  collaborationGroupSessionParticipants,
  collaborationGroupSessionSendTargets,
  collaborationGroupSessionSpaceId,
  isCollaborationGroupSession,
  shouldUseCollaborationConversationRouting,
} from './collaborationRouting';
import {
  resolvedCloudConversationIdForConversation,
  resolvedCloudConversationIdForTarget,
  resolveDirectHostedAgentTarget,
  resolveLockedKordiSupportCloudConversationId,
  resolveLockedKordiSupportAgentTarget,
} from './directHostedAgentTarget';
import {
  canonicalNoProviderFailedAgentMessageRequest,
  initialCloudAgentSessionTitle,
  noProviderPendingLiveTurn,
  ownedAgentIdentityId,
} from './agentMessageLifecycle';

export {
  canonicalNoProviderFailedAgentMessageRequest,
  initialCloudAgentSessionTitle,
  noProviderPendingLiveTurn,
} from './agentMessageLifecycle';

export {
  collaborationGroupMentionRelayTargets,
  collaborationGroupSessionParticipants,
  collaborationGroupSessionSendTargets,
  collaborationGroupSessionSpaceId,
  collaborationLocalAgentMentionCanRelay,
  collaborationLocalAgentRelayTargets,
  collaborationSessionOutreachTarget,
  isCollaborationGroupSession,
  shouldUseCollaborationConversationRouting,
} from './collaborationRouting';
async function persistCanonicalGroupMessageFailure(
  prepared: PreparedCanonicalUserMessage | null,
  detail: string,
  recipientIds: readonly string[],
) {
  const request = failedCanonicalGroupMessageRequest(prepared, detail, recipientIds);
  if (!request) return;
  await upsertCanonicalMessage(request);
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
  contextMessages,
  runtimeRoute,
}: {
  sessionId: string;
  text: string;
  time: string;
  attachments: QueuedDesktopChatMessage['attachments'];
  scope?: QueuedDesktopChatMessage['scope'];
  contextMessages?: DesktopChatContextMessage[];
  runtimeRoute?: QueuedDesktopChatMessage['runtimeRoute'];
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
    ...(contextMessages && contextMessages.length > 0 ? { contextMessages } : null),
    ...(runtimeRoute ? { runtimeRoute } : null),
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

export function collaborationConversationSendPlan({
  activeConvId,
  hasMaterializedCollaborationConversation,
  existingTargetConversationId,
  shouldStayInCanonicalSession,
}: {
  activeConvId: string;
  hasMaterializedCollaborationConversation: boolean;
  existingTargetConversationId?: string | null;
  shouldStayInCanonicalSession: boolean;
}) {
  const targetConversationId = hasMaterializedCollaborationConversation
    ? activeConvId
    : existingTargetConversationId ?? null;

  return {
    targetConversationId,
    shouldOpenBeforeOptimisticSend: !targetConversationId && !shouldStayInCanonicalSession,
    canAppendCollaborationOptimisticMessage: Boolean(targetConversationId),
  };
}

function cleanText(value?: string | null) {
  return value?.trim() || null;
}

export function activeLocalTurnShouldDelayChatSend({
  activeConversationUsesCollaborationRouting,
  activeConvId,
  desktopLiveTurn,
}: {
  activeConversationUsesCollaborationRouting: boolean;
  activeConvId: string;
  desktopLiveTurn?: { sessionId?: string | null; completed?: boolean } | null;
}) {
  return !activeConversationUsesCollaborationRouting
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

function restoredSelfAgentContextMessageId(message: Message): string | null {
  const ids = [
    message.id,
    message.entryId,
    ...(message.replyAliasIds ?? []),
  ]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean);
  const cloudMessageId = ids.find((id) => id.startsWith('msg:cloud:self:'));
  if (cloudMessageId) return cloudMessageId;
  if (!message.isForkSnapshot) return null;
  return ids.find((id) => id.startsWith('msg:')) ?? ids[0] ?? null;
}

export function restoredSelfAgentContextMessages(messages: readonly Message[]): DesktopChatContextMessage[] {
  return messages.flatMap((message) => {
    if (message.messageAction?.kind === 'forward') return [];
    const id = restoredSelfAgentContextMessageId(message);
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

export function useChatMessageActions({
  activeConversationUsesCollaboration,
  activeConvCollaborationTarget,
  activeConvSupportTicketEnabled,
  activeConvCanonicalSessionId,
  activeConvId,
  activeConvMessages,
  activeConvMentionScope,
  sharedCloudAgents = [],
  resolveSharedCloudAgentsForMention,
  chatConversations,
  attachmentSummaryText,
  canonicalHumanIdentityId,
  chatComposerAttachments,
  composerSelections,
  composerDrafts,
  activeChatQuote,
  desktopCollaborationState,
  desktopChatState,
  canonicalSessionState,
  hasAnyDesktopAuth,
  desktopLiveTurn,
  resolveChatRuntimeRoute,
  handleLocalSlashCommand,
  isNativeShell,
  queuedDesktopMessagesBySession,
  localChatSendInFlightRef,
  refreshDesktopChat,
  setActiveConvId,
  setCanonicalSessionState,
  setChatComposerAttachments,
  setComposerDrafts,
  setCloudCollaborationState,
  sendCloudCollaborationMessage,
  sendCloudGroupControl,
  publishCloudAgentRuntimeRouteChange,
  setDesktopChatError,
  setDesktopChatState,
  setDesktopLiveTurnsBySession,
  setIsDesktopChatSending,
  setOpenComposerSelector,
  setPendingUserChatMessage,
  setQueuedDesktopMessagesBySession,
  shouldAutoFollowChatRef,
  watchDesktopLiveTurn,
}: UseChatMessageActionsArgs) {
  const resolvedActiveCloudConversationId = resolvedCloudConversationIdForTarget(
    activeConvId,
    activeConvCanonicalSessionId,
    activeConvCollaborationTarget,
  );
  const lockedSupportAgentTarget = useMemo(() => (
    resolveLockedKordiSupportAgentTarget({
      conversationId: activeConvId,
      resolvedConversationId: resolvedActiveCloudConversationId,
      canonicalSessionId: activeConvCanonicalSessionId,
      supportTicketEnabled: activeConvSupportTicketEnabled,
      activeTarget: activeConvCollaborationTarget,
    })
  ), [
    activeConvCanonicalSessionId,
    activeConvCollaborationTarget,
    activeConvId,
    activeConvSupportTicketEnabled,
    resolvedActiveCloudConversationId,
  ]);
  const activeCloudConversationId = resolveLockedKordiSupportCloudConversationId({
    resolvedConversationId: resolvedActiveCloudConversationId,
    canonicalSessionId: activeConvCanonicalSessionId,
    lockedTarget: lockedSupportAgentTarget,
  }) ?? resolvedActiveCloudConversationId;
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

  const queueLocalDraftForSession = useCallback((sessionId: string, draftText: string, attachments: QueuedDesktopChatMessage['attachments'], contextMessages: DesktopChatContextMessage[] = []) => {
    const queuedMessage = queuedDesktopChatMessageFromDraft({
      sessionId,
      text: draftText,
      time: formatDesktopEventTime(),
      attachments,
      contextMessages,
      runtimeRoute: resolveChatRuntimeRoute(sessionId),
    });
    enqueueLocalQueuedMessage(queuedMessage);
    shouldAutoFollowChatRef.current = true;
    setDesktopChatError(null);
    setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', sessionId, ''));
    setChatComposerAttachments([]);
    resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
  }, [enqueueLocalQueuedMessage, resolveChatRuntimeRoute, setChatComposerAttachments, setComposerDrafts, setDesktopChatError, shouldAutoFollowChatRef]);

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

  const materializeLocalChatTarget = useCallback(async (sessionId: string) => {
    const materializedState = await fetchMaterializedLocalChatTarget(sessionId, desktopChatState);
    if (materializedState) setDesktopChatState(materializedState);
    return materializedState;
  }, [desktopChatState, setDesktopChatState]);

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
      const materializedState = await materializeLocalChatTarget(message.sessionId);
      const attachmentPaths = message.attachments.map((item) => item.path);
      const previewText = attachmentSummaryText(message.text);
      const turn = await startDesktopChatMessage(
        message.sessionId,
        message.text,
        attachmentPaths,
        message.runtimeRoute ?? resolveChatRuntimeRoute(message.sessionId),
        message.contextMessages ?? [],
      );
      const preparedCanonicalMessage = sentPreparedCanonicalUserMessage(
        prepareCanonicalUserMessage(
          message.sessionId,
          canonicalHumanIdentityId,
          message.text,
          message.attachments,
          message.time,
          'desktop-chat-ui',
          'sending',
        ),
      );
      setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
      setDesktopChatState((current) => {
        const currentTargetsSession = current?.activeSessionId === message.sessionId
          && current.activeSession.id === message.sessionId;
        const baseState = materializedState && !currentTargetsSession ? materializedState : current;
        return baseState
          ? appendOptimisticOutboundMessage(baseState, message.sessionId, previewText, message.text, message.attachments, message.time)
          : current;
      });
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
  }, [attachmentSummaryText, canonicalHumanIdentityId, enqueueLocalQueuedMessage, localChatSendInFlightRef, materializeLocalChatTarget, resolveChatRuntimeRoute, setCanonicalSessionState, setDesktopChatError, setDesktopChatState, watchLocalTurnAndFlushQueue]);

  useEffect(() => {
    flushQueuedDesktopMessagesForSessionRef.current = (sessionId: string) => {
      const nextMessage = dequeueLocalQueuedMessage(sessionId);
      if (!nextMessage) return;
      void sendQueuedLocalMessage(nextMessage);
    };
  }, [dequeueLocalQueuedMessage, sendQueuedLocalMessage]);

  useEffect(() => {
    if (!isNativeShell || activeConversationUsesCollaboration || activeConvId.startsWith('bridge:') || isLocalDraftChatConversationId(activeConvId)) return;
    if ((queuedDesktopMessagesBySession[activeConvId] ?? []).length === 0) return;
    const delayReason = localChatSendDelayReason({
      inFlight: localChatSendInFlightRef.current,
      targetSessionId: activeConvId,
      desktopLiveTurn,
    });
    if (delayReason) return;
    flushQueuedDesktopMessagesForSessionRef.current(activeConvId);
  }, [activeConvId, activeConversationUsesCollaboration, desktopLiveTurn, isNativeShell, localChatSendInFlightRef, queuedDesktopMessagesBySession]);

  const clearComposerAfterSend = useCallback((sessionIds: string[]) => {
    setComposerDrafts((current: ComposerDraftState) => sessionIds.reduce(
      (next, sessionId) => updateScopeDraft(next, 'chat', sessionId, ''),
      current,
    ));
    setChatComposerAttachments([]);
    resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
  }, [setChatComposerAttachments, setComposerDrafts]);

  const sendLocalAgentChatMessage = useCallback(async ({
    targetConversationId,
    canonicalSessionId,
    text,
    attachments,
    sentAt,
    quote,
    contextMessages,
    clearDraftSessionIds,
    materializedState,
    materializeTarget,
    preserveComposer = false,
    setSendingState,
    runtimeRoute,
  }: {
    targetConversationId: string;
    canonicalSessionId: string;
    text: string;
    attachments: typeof chatComposerAttachments;
    sentAt: string;
    quote: typeof activeChatQuote;
    contextMessages: DesktopChatContextMessage[];
    clearDraftSessionIds: string[];
    materializedState?: DesktopChatState | null;
    materializeTarget?: () => Promise<DesktopChatState | null>;
    preserveComposer?: boolean;
    setSendingState: boolean;
    runtimeRoute?: QueuedDesktopChatMessage['runtimeRoute'];
  }) => {
    if (setSendingState) setIsDesktopChatSending(true);
    shouldAutoFollowChatRef.current = true;
    setDesktopChatError(null);
    setPendingUserChatMessage(null);
    const attachmentPaths = attachments.map((item) => item.path);
    const previewText = attachmentSummaryText(text, attachments);
    const preparedCanonicalMessage = prepareCanonicalUserMessage(
      canonicalSessionId,
      canonicalHumanIdentityId,
      text,
      attachments,
      sentAt,
      'desktop-chat-ui',
      'sending',
      [],
      quote,
    );
    let resolvedMaterializedState = materializedState;

    setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
    if (!preserveComposer) clearComposerAfterSend(clearDraftSessionIds);

    try {
      if (materializeTarget) resolvedMaterializedState = await materializeTarget();
      setDesktopChatState((current) => {
        const currentTargetsConversation = current?.activeSessionId === targetConversationId
          && current.activeSession.id === targetConversationId;
        const baseState = resolvedMaterializedState && !currentTargetsConversation
          ? resolvedMaterializedState
          : current;
        if (!baseState) return current;
        return appendOptimisticOutboundMessage(baseState, targetConversationId, previewText, text, attachments, sentAt, [], quote);
      });
      await persistCanonicalUserMessage(preparedCanonicalMessage);
      const turn = await startDesktopChatMessage(
        targetConversationId,
        text,
        attachmentPaths,
        runtimeRoute ?? resolveChatRuntimeRoute(canonicalSessionId),
        contextMessages,
      );
      const sentCanonicalMessage = sentPreparedCanonicalUserMessage(preparedCanonicalMessage);
      if (sentCanonicalMessage) {
        setCanonicalSessionState((current) => markOptimisticCanonicalMessageSent(
          current,
          canonicalSessionId,
          sentCanonicalMessage.messageId,
        ));
        void upsertCanonicalMessageFast(sentCanonicalMessage.request).catch((error: unknown) => {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to update message delivery status');
        });
      }
      watchLocalTurnAndFlushQueue(turn, async (finalTurn) => {
        const noProviderFailure = isCloudAgentNoProviderConfiguredError(finalTurn.error || finalTurn.message || finalTurn.assistantText);
        if (!noProviderFailure || !preparedCanonicalMessage) return;
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
            sessionId: canonicalSessionId,
            requestMessageId: preparedCanonicalMessage.messageId,
          });
          const nextState = failedReplyRequest ? await appendCanonicalMessage(failedReplyRequest) : stateAfterUser;
          if (nextState) setCanonicalSessionState(nextState);
        } catch (error) {
          setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
            current,
            canonicalSessionId,
            preparedCanonicalMessage.messageId,
            cloudAgentNoProviderNoticeText(),
          ));
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to save provider notice');
        }
      });
      if (setSendingState) setIsDesktopChatSending(false);
    } catch (error) {
      setPendingUserChatMessage(null);
      if (localChatSendInFlightRef.current?.sessionId === targetConversationId) {
        localChatSendInFlightRef.current = null;
      }
      if (setSendingState) setIsDesktopChatSending(false);
      if (isCloudAgentNoProviderConfiguredError(error) && preparedCanonicalMessage) {
        setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
          current,
          canonicalSessionId,
          preparedCanonicalMessage.messageId,
          cloudAgentNoProviderNoticeText(),
        ));
        setDesktopChatError(null);
        return;
      }
      const failureDetail = error instanceof Error ? error.message : 'Unable to send chat message';
      setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
        current,
        canonicalSessionId,
        preparedCanonicalMessage?.messageId ?? null,
        failureDetail,
      ));
      void persistCanonicalUserMessage(failedPreparedCanonicalUserMessage(preparedCanonicalMessage, failureDetail))
        .catch((saveError: unknown) => {
          setDesktopChatError(saveError instanceof Error ? saveError.message : 'Unable to save message');
        });
      setDesktopChatError(failureDetail);
    }
  }, [
    activeChatQuote,
    canonicalHumanIdentityId,
    canonicalSessionState,
    chatComposerAttachments,
    clearComposerAfterSend,
    localChatSendInFlightRef,
    setCanonicalSessionState,
    setDesktopChatError,
    setDesktopChatState,
    setIsDesktopChatSending,
    setPendingUserChatMessage,
    shouldAutoFollowChatRef,
    watchLocalTurnAndFlushQueue,
    resolveChatRuntimeRoute,
  ]);

  const sendTargetedChatMessage = useCallback(async (targetSessionId: string, rawText: string, contextMessages: DesktopChatContextMessage[] = []) => {
    if (!isNativeShell) return;
    const text = rawText.trim();
    if (!text && chatComposerAttachments.length === 0) return;

    const targetConversation = chatConversations.find((conversation) => (
      conversation.id === targetSessionId || conversation.canonicalSessionId === targetSessionId
    ));
    if (!targetConversation) {
      setDesktopChatError('Unable to find that side chat.');
      return;
    }

    const sentAt = formatDesktopEventTime();
    const clearTargetDraft = () => {
      setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', targetConversation.id, ''));
    };

    const targetGroupScope = {
      canonicalSessionId: targetConversation.canonicalSessionId ?? targetConversation.id,
      participantSpaceId: targetConversation.participantSpaceId,
      directness: targetConversation.directness,
      canonicalParticipants: targetConversation.canonicalParticipants,
    };
    const localCollaborationNodeIds = new Set(
      (desktopCollaborationState?.hosts ?? [])
        .map((host) => host.nodeId?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    const groupTargets = isCollaborationGroupSession(targetGroupScope)
      ? collaborationGroupSessionSendTargets(targetConversation, targetConversation.collaborationTarget, localCollaborationNodeIds)
      : [];
    const cloudGroupTargetIds = cloudGroupTargetAccountIds(groupTargets);
    if (cloudGroupTargetIds.length > 0) {
      if (!sendCloudGroupControl) {
        setDesktopChatError('Group chat is still loading. Try again in a moment.');
        return;
      }
      const canonicalSessionId = targetConversation.canonicalSessionId ?? targetConversation.id;
      const activeCollaborationHost = desktopCollaborationState?.hosts.find((host) => host.id === desktopCollaborationState.activeHostId)
        ?? desktopCollaborationState?.hosts[0]
        ?? null;
      const selfPublicCollaborationName = activeCollaborationHost?.ownerName?.trim()
        || activeCollaborationHost?.displayName?.trim()
        || null;
      const activeGroupSessionSpaceId = collaborationGroupSessionSpaceId(targetGroupScope);
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        canonicalSessionId,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'cloud-group-ui',
        'sending',
      );
      if (preparedCanonicalMessage) {
        preparedCanonicalMessage.request.content = {
          ...(preparedCanonicalMessage.request.content && typeof preparedCanonicalMessage.request.content === 'object' ? preparedCanonicalMessage.request.content : {}),
          deliveryState: 'sending',
        };
      }
      try {
        shouldAutoFollowChatRef.current = true;
        setDesktopChatError(null);
        setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
        clearTargetDraft();
        setChatComposerAttachments([]);
        await persistCanonicalUserMessage(preparedCanonicalMessage);
        await sendCloudGroupControl({
          targetAccountIds: cloudGroupTargetIds,
          kind: 'group-message',
          groupId: cloudGroupMessageSessionId({ activeConvCanonicalSessionId: canonicalSessionId, activeGroupSessionSpaceId }),
          groupSpaceId: activeGroupSessionSpaceId,
          groupTitle: null,
          collaborationParticipants: collaborationGroupSessionParticipants(targetConversation, { selfPublicName: selfPublicCollaborationName }),
          message: {
            id: preparedCanonicalMessage?.messageId ?? `cloud-group-message-${Date.now()}`,
            senderAccountId: '',
            text,
            createdAtMs: Date.now(),
          },
          attachments: chatComposerAttachments,
        });
      } catch (error) {
        const failureDetail = collaborationSendFailureDetail(error, 'Unable to send group message');
        setDesktopChatError(failureDetail);
        setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
          current,
          canonicalSessionId,
          preparedCanonicalMessage?.messageId ?? null,
          failureDetail,
        ));
        await persistCanonicalGroupMessageFailure(
          preparedCanonicalMessage,
          failureDetail,
          cloudGroupTargetIds,
        ).catch((saveError: unknown) => {
          setDesktopChatError(saveError instanceof Error ? saveError.message : 'Unable to save message');
        });
      }
      return;
    }

    const targetCloudConversationId = resolvedCloudConversationIdForConversation(targetConversation);
    if (isCloudCollaborationConversationId(targetCloudConversationId)) {
      if (!sendCloudCollaborationMessage || !setCloudCollaborationState) {
        setDesktopChatError('Chat is still loading. Try again in a moment.');
        return;
      }
      const optimisticMessageId = createCloudCollaborationClientMessageId();
      try {
        shouldAutoFollowChatRef.current = true;
        setDesktopChatError(null);
        setCloudCollaborationState((current) => appendOptimisticCollaborationMessage(
          current,
          targetCloudConversationId,
          text,
          sentAt,
          optimisticMessageId,
          chatComposerAttachments,
          attachmentSummaryText(text),
        ));
        clearTargetDraft();
        setChatComposerAttachments([]);
        const canonicalMessage = await sendCloudCollaborationMessage(
          targetCloudConversationId,
          text,
          chatComposerAttachments,
          { clientMessageId: optimisticMessageId },
        );
        setCloudCollaborationState(reconcileOptimisticCollaborationMessageUpdater(targetCloudConversationId, optimisticMessageId, canonicalMessage));
      } catch (error) {
        const failure = terminalCollaborationSendFailure({ error, fallback: 'Unable to send message', conversationId: targetCloudConversationId, messageId: optimisticMessageId });
        if (failure) {
          setCloudCollaborationState(failure.updateOptimisticState);
          setDesktopChatError(failure.detail);
        }
      }
      return;
    }

    const delayReason = localChatSendDelayReason({
      inFlight: localChatSendInFlightRef.current,
      targetSessionId: targetConversation.id,
      desktopLiveTurn: null,
    });
    if (delayReason === 'same-session-running') {
      queueLocalDraftForSession(targetConversation.id, text, chatComposerAttachments, contextMessages);
      return;
    }
    if (delayReason === 'session-starting') {
      setDesktopChatError(null);
      return;
    }
    localChatSendInFlightRef.current = { sessionId: targetConversation.id };
    await sendLocalAgentChatMessage({
      targetConversationId: targetConversation.id,
      canonicalSessionId: targetConversation.canonicalSessionId ?? targetConversation.id,
      text,
      attachments: chatComposerAttachments,
      sentAt,
      quote: activeChatQuote,
      contextMessages,
      clearDraftSessionIds: [targetConversation.id],
      materializeTarget: () => materializeLocalChatTarget(targetConversation.id),
      setSendingState: false,
    });
    clearTargetDraft();
  }, [
    activeChatQuote,
    attachmentSummaryText,
    canonicalHumanIdentityId,
    chatComposerAttachments,
    chatConversations,
    desktopCollaborationState,
    desktopChatState,
    isNativeShell,
    localChatSendInFlightRef,
    materializeLocalChatTarget,
    queueLocalDraftForSession,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
    sendLocalAgentChatMessage,
    setCanonicalSessionState,
    setChatComposerAttachments,
    setCloudCollaborationState,
    setComposerDrafts,
    setDesktopChatError,
    setDesktopChatState,
    shouldAutoFollowChatRef,
    watchLocalTurnAndFlushQueue,
  ]);

  const handleSendChatMessage = useCallback(async (
    draftOverride?: string,
    sideTargetSessionId?: string,
    contextMessages: DesktopChatContextMessage[] = [],
    attachmentOverride?: AttachmentItem[],
    retryMessage?: Message,
  ) => {
    if (!isNativeShell) return;
    if (sideTargetSessionId && sideTargetSessionId !== activeConvId) {
      await sendTargetedChatMessage(sideTargetSessionId, draftOverride ?? '', contextMessages);
      return;
    }
    const retryAttachments = retryMessage ? retryAttachmentItemsFromMessage(retryMessage) : null;
    if (retryMessage && retryAttachments === null) {
      setDesktopChatError('The original image is no longer available on this device.');
      return;
    }
    const rawText = retryMessage?.text ?? draftOverride ?? composerDrafts.chat;
    const text = rawText.trim();
    const attachmentsToSend = retryAttachments ?? attachmentOverride ?? chatComposerAttachments;
    const voiceMessage = voiceMessageDraftFromAttachments(attachmentsToSend);
    const preserveComposer = attachmentOverride !== undefined;
    if (!text && attachmentsToSend.length === 0) return;
    const memeValidationError = memeAttachmentDraftError(attachmentsToSend, {
      requireRightsConfirmation: !retryMessage,
    });
    if (memeValidationError) {
      setDesktopChatError(memeValidationError);
      return;
    }
    const mentionedTarget = await resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh(
      text, desktopCollaborationState, activeConvMentionScope,
      sharedCloudAgents, resolveSharedCloudAgentsForMention,
    );
    const messageMentions = messageMentionsForSend(text, activeConvMentionScope, mentionedTarget);
    const targetCloudAgentId = mentionedTarget?.peer.agentId?.startsWith('cloud_agent_') ? mentionedTarget.peer.agentId : null;
    const mentionedCloudSharedAgentOwnerAccountId = targetCloudAgentId
      ? cleanText(mentionedTarget?.peer.humanId) || cleanText(mentionedTarget?.peer.nodeId)
      : null;
    const activeGroupSessionScope = {
      canonicalSessionId: activeConvCanonicalSessionId ?? activeConvId,
      participantSpaceId: activeConvMentionScope?.participantSpaceId,
      directness: activeConvMentionScope?.directness,
      canonicalParticipants: activeConvMentionScope?.canonicalParticipants,
    };
    const localCollaborationNodeIds = new Set(
      (desktopCollaborationState?.hosts ?? [])
        .map((host) => host.nodeId?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    const activeGroupSessionIsGroup = isCollaborationGroupSession(activeGroupSessionScope);
    const localAgentMentioned = mentionsLocalAgent(text, desktopChatState, desktopCollaborationState);
    const activeConversationUsesCollaborationRouting = shouldUseCollaborationConversationRouting({
      activeConversationUsesCollaboration,
      activeConvCollaborationTarget,
      activeGroupSessionScope,
      selfCollaborationNodeIds: localCollaborationNodeIds,
      forceCollaborationRouting: Boolean(lockedSupportAgentTarget),
    });
    const activeGroupSessionSpaceId = activeGroupSessionIsGroup ? collaborationGroupSessionSpaceId(activeGroupSessionScope) : null;
    const activeCollaborationHost = desktopCollaborationState?.hosts.find((host) => host.id === desktopCollaborationState.activeHostId)
      ?? desktopCollaborationState?.hosts[0]
      ?? null;
    const selfPublicCollaborationName = activeCollaborationHost?.ownerName?.trim()
      || activeCollaborationHost?.displayName?.trim()
      || null;
    const activeGroupSessionParticipants = activeGroupSessionIsGroup
      ? collaborationGroupSessionParticipants(activeGroupSessionScope, { selfPublicName: selfPublicCollaborationName })
      : [];
    const allGroupSendTargets = activeGroupSessionIsGroup
      ? collaborationGroupSessionSendTargets(activeGroupSessionScope, activeConvCollaborationTarget, localCollaborationNodeIds)
      : [];
    const cloudGroupTargetIds = cloudGroupTargetAccountIds(allGroupSendTargets);
    const directCloudSharedAgentTargetIds = !activeGroupSessionIsGroup && mentionedCloudSharedAgentOwnerAccountId
      ? [mentionedCloudSharedAgentOwnerAccountId]
      : [];
    const cloudAgentMentionTargetIds = activeGroupSessionIsGroup ? cloudGroupTargetIds : directCloudSharedAgentTargetIds;
    const cloudAgentMentionParticipants = activeGroupSessionIsGroup
      ? activeGroupSessionParticipants
      : collaborationDirectSessionParticipants(activeGroupSessionScope, activeCollaborationHost, activeConvCollaborationTarget, { selfPublicName: selfPublicCollaborationName });
    const cloudAgentMentionSessionId = activeGroupSessionIsGroup
      ? cloudGroupMessageSessionId({ activeConvCanonicalSessionId, activeGroupSessionSpaceId })
      : (activeConvCanonicalSessionId ?? activeConvId);

    if (retryMessage) {
      const retryMessageId = retryMessage.id?.trim();
      if (!retryMessageId || !retryAttachments) {
        setDesktopChatError('This message cannot be retried.');
        return;
      }

      if (
        activeConversationUsesCollaborationRouting
        && activeGroupSessionIsGroup
        && activeConvCanonicalSessionId
        && cloudGroupTargetIds.length > 0
        && sendCloudGroupControl
      ) {
        try {
          shouldAutoFollowChatRef.current = true;
          setIsDesktopChatSending(true);
          setDesktopChatError(null);
          setCanonicalSessionState((current) => markOptimisticCanonicalMessageSending(
            current,
            activeConvCanonicalSessionId,
            retryMessageId,
            cloudGroupTargetIds,
          ));
          await updateCanonicalMessageDelivery({
            messageId: retryMessageId,
            sessionId: activeConvCanonicalSessionId,
            status: 'sending',
            deliveryState: 'sending',
            deliveredRecipientIds: [],
            pendingRecipientIds: cloudGroupTargetIds,
            exhaustedRecipientIds: [],
          });
          await sendCloudGroupControl({
            targetAccountIds: cloudGroupTargetIds,
            kind: 'group-message',
            groupId: cloudGroupMessageSessionId({ activeConvCanonicalSessionId, activeGroupSessionSpaceId }),
            groupSpaceId: activeGroupSessionSpaceId,
            groupTitle: null,
            collaborationParticipants: activeGroupSessionParticipants,
            message: {
              id: retryMessageId,
              senderAccountId: '',
              text,
              createdAtMs: Date.now(),
              messageAction: retryMessage.messageAction ?? null,
              messageKind: voiceMessage ? 'voice' : 'text',
              voiceMessage,
            },
            attachments: retryAttachments,
            retryFailed: true,
          });
        } catch (error) {
          const failureDetail = collaborationSendFailureDetail(error, 'Unable to retry group message');
          setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
            current,
            activeConvCanonicalSessionId,
            retryMessageId,
            failureDetail,
          ));
          await updateCanonicalMessageDelivery({
            messageId: retryMessageId,
            sessionId: activeConvCanonicalSessionId,
            status: 'failed',
            deliveryState: 'failed',
            deliveredRecipientIds: [],
            pendingRecipientIds: [],
            exhaustedRecipientIds: cloudGroupTargetIds,
          }).catch(() => {});
          setDesktopChatError(failureDetail);
        } finally {
          setIsDesktopChatSending(false);
        }
        return;
      }

      if (
        activeConversationUsesCollaborationRouting
        && isCloudCollaborationConversationId(activeCloudConversationId)
        && sendCloudCollaborationMessage
        && setCloudCollaborationState
      ) {
        try {
          shouldAutoFollowChatRef.current = true;
          setIsDesktopChatSending(true);
          setDesktopChatError(null);
          setCloudCollaborationState((current) => markOptimisticCollaborationMessageSending(
            current,
            activeCloudConversationId,
            retryMessageId,
          ));
          const retryDirectHostedAgentTarget = resolveDirectHostedAgentTarget({
            mentionedAgentId: null,
            mentionedTarget: null,
            activeTarget: activeConvCollaborationTarget,
            lockedTarget: lockedSupportAgentTarget,
          });
          const retryCloudBody = retryDirectHostedAgentTarget
            ? encodeCloudDirectMessageEnvelope({
                schemaVersion: 1,
                kind: 'message',
                text,
                agentRuntimeRoute: resolveChatRuntimeRoute(
                  activeConvCanonicalSessionId ?? activeConvId,
                ),
                ...retryDirectHostedAgentTarget,
              })
            : text;
          const canonicalMessage = await sendCloudCollaborationMessage(
            activeCloudConversationId,
            retryCloudBody,
            retryAttachments,
            {
              clientMessageId: retryMessageId,
              messageKind: voiceMessage ? 'voice' : 'text',
              voiceMessage,
            },
          );
          setCloudCollaborationState(reconcileOptimisticCollaborationMessageUpdater(activeCloudConversationId, retryMessageId, canonicalMessage));
        } catch (error) {
          const failure = terminalCollaborationSendFailure({ error, fallback: 'Unable to retry message', conversationId: activeCloudConversationId, messageId: retryMessageId });
          if (failure) {
            setCloudCollaborationState(failure.updateOptimisticState);
            setDesktopChatError(failure.detail);
          }
        } finally {
          setIsDesktopChatSending(false);
        }
        return;
      }

      setDesktopChatError('Retry is unavailable for this conversation.');
      return;
    }

    if (activeLocalTurnShouldDelayChatSend({ activeConversationUsesCollaborationRouting, activeConvId, desktopLiveTurn })) {
      const leadingCommand = text.split(/\s+/, 1)[0] ?? text;
      if (attachmentsToSend.length === 0 && isSharedLocalSlashCommand(leadingCommand)) {
        setDesktopChatError('Commands are unavailable while this session is running. Your draft is preserved.');
        return;
      }
      queueLocalDraftForSession(activeConvId, text, attachmentsToSend);
      return;
    }

    if (activeConversationUsesCollaborationRouting && shouldRouteMentionThroughCloudGroup({
      mentionedHostId: mentionedTarget?.host.id,
      activeGroupSessionIsGroup,
      mentionsLocalAgent: localAgentMentioned,
      mentionsCollaborationAgent: mentionedTarget?.targetKind === 'agent',
      hasCloudGroupRecipients: cloudAgentMentionTargetIds.length > 0,
    })) {
      if (!activeConvCanonicalSessionId) {
        setDesktopChatError('Unable to open group chat.');
        return;
      }
      if (!sendCloudGroupControl) {
        setDesktopChatError('Group chat is still loading. Try again in a moment.');
        return;
      }
      if (cloudAgentMentionTargetIds.length === 0) {
        setDesktopChatError('Unable to resolve group recipients.');
        return;
      }
      const sentAt = formatDesktopEventTime();
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        activeConvCanonicalSessionId,
        canonicalHumanIdentityId,
        text,
        attachmentsToSend,
        sentAt,
        'cloud-group-ui',
        'sending',
        messageMentions,
        activeChatQuote,
      );
      if (preparedCanonicalMessage) {
        preparedCanonicalMessage.request.content = {
          ...(preparedCanonicalMessage.request.content && typeof preparedCanonicalMessage.request.content === 'object' ? preparedCanonicalMessage.request.content : {}),
          deliveryState: 'sending',
        };
      }
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        if (!preserveComposer) clearComposerAfterSend([activeConvId]);
        setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
        await persistCanonicalUserMessage(preparedCanonicalMessage);
        await sendCloudGroupControl({
          targetAccountIds: cloudAgentMentionTargetIds,
          kind: 'group-message',
          groupId: cloudAgentMentionSessionId,
          groupSpaceId: activeGroupSessionSpaceId,
          groupTitle: null,
          collaborationParticipants: cloudAgentMentionParticipants,
          message: {
            id: preparedCanonicalMessage?.messageId ?? `cloud-group-message-${Date.now()}`,
            senderAccountId: '',
            text,
            mentions: messageMentions,
            createdAtMs: Date.now(),
            messageAction: activeChatQuote?.source ? quoteMessageAction(activeChatQuote.source) : null,
            targetCloudAgentId,
            targetCloudAgentName: targetCloudAgentId ? mentionedTarget?.displayLabel ?? null : null,
            targetCloudAgentOwnerAccountId: targetCloudAgentId ? mentionedTarget?.peer.humanId ?? mentionedTarget?.peer.nodeId ?? null : null,
            targetCloudAgentOwnerName: targetCloudAgentId ? mentionedTarget?.peer.ownerName ?? null : null,
            agentRuntimeRoute: resolveChatRuntimeRoute(cloudAgentMentionSessionId),
            messageKind: voiceMessage ? 'voice' : 'text',
            voiceMessage,
          },
          attachments: attachmentsToSend,
        });
      } catch (error) {
        const failureDetail = collaborationSendFailureDetail(error, 'Unable to send group mention');
        setDesktopChatError(failureDetail);
        setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
          current,
          activeConvCanonicalSessionId,
          preparedCanonicalMessage?.messageId ?? null,
          failureDetail,
        ));
        await persistCanonicalGroupMessageFailure(
          preparedCanonicalMessage,
          failureDetail,
          cloudAgentMentionTargetIds,
        ).catch((saveError: unknown) => {
          setDesktopChatError(saveError instanceof Error ? saveError.message : 'Unable to save message');
        });
      } finally {
        setIsDesktopChatSending(false);
      }
      return;
    }

    if (activeConversationUsesCollaborationRouting && activeGroupSessionIsGroup && cloudGroupTargetIds.length > 0) {
      if (!activeConvCanonicalSessionId) {
        setDesktopChatError('Unable to open group chat.');
        return;
      }
      if (!sendCloudGroupControl) {
        setDesktopChatError('Group chat is still loading. Try again in a moment.');
        return;
      }
      const sentAt = formatDesktopEventTime();
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        activeConvCanonicalSessionId,
        canonicalHumanIdentityId,
        text,
        attachmentsToSend,
        sentAt,
        'cloud-group-ui',
        'sending',
        messageMentions,
        activeChatQuote,
      );
      if (preparedCanonicalMessage) {
        preparedCanonicalMessage.request.content = {
          ...(preparedCanonicalMessage.request.content && typeof preparedCanonicalMessage.request.content === 'object' ? preparedCanonicalMessage.request.content : {}),
          deliveryState: 'sending',
        };
      }
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        if (!preserveComposer) clearComposerAfterSend([activeConvId]);
        setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
        await persistCanonicalUserMessage(preparedCanonicalMessage);
        await sendCloudGroupControl({
          targetAccountIds: cloudGroupTargetIds,
          kind: 'group-message',
          groupId: cloudGroupMessageSessionId({ activeConvCanonicalSessionId, activeGroupSessionSpaceId }),
          groupSpaceId: activeGroupSessionSpaceId,
          groupTitle: null,
          collaborationParticipants: activeGroupSessionParticipants,
          message: {
            id: preparedCanonicalMessage?.messageId ?? `cloud-group-message-${Date.now()}`,
            senderAccountId: '',
            text,
            mentions: messageMentions,
            createdAtMs: Date.now(),
            messageAction: activeChatQuote?.source ? quoteMessageAction(activeChatQuote.source) : null,
            messageKind: voiceMessage ? 'voice' : 'text',
            voiceMessage,
          },
          attachments: attachmentsToSend,
        });
      } catch (error) {
        const failureDetail = collaborationSendFailureDetail(error, 'Unable to send group message');
        setDesktopChatError(failureDetail);
        setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
          current,
          activeConvCanonicalSessionId,
          preparedCanonicalMessage?.messageId ?? null,
          failureDetail,
        ));
        await persistCanonicalGroupMessageFailure(
          preparedCanonicalMessage,
          failureDetail,
          cloudGroupTargetIds,
        ).catch((saveError: unknown) => {
          setDesktopChatError(saveError instanceof Error ? saveError.message : 'Unable to save message');
        });
      } finally {
        setIsDesktopChatSending(false);
      }
      return;
    }

    if (activeConversationUsesCollaborationRouting && isCloudCollaborationConversationId(activeCloudConversationId)) {
      if (!sendCloudCollaborationMessage || !setCloudCollaborationState) {
        setDesktopChatError('Chat is still loading. Try again in a moment.');
        return;
      }
      const sentAt = formatDesktopEventTime();
      const optimisticMessageId = createCloudCollaborationClientMessageId();
      const appendedOptimisticCollaborationMessage = shouldAppendOptimisticCollaborationMessage(activeCloudConversationId);
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        if (!preserveComposer) clearComposerAfterSend([activeConvId]);
        if (appendedOptimisticCollaborationMessage) {
          setCloudCollaborationState((current) => appendOptimisticCollaborationMessage(current, activeCloudConversationId, text, sentAt, optimisticMessageId, attachmentsToSend, attachmentSummaryText(text, attachmentsToSend), activeChatQuote, messageMentions));
        }
        const directHostedAgentTarget = resolveDirectHostedAgentTarget({
          mentionedAgentId: targetCloudAgentId,
          mentionedTarget,
          activeTarget: activeConvCollaborationTarget,
          lockedTarget: lockedSupportAgentTarget,
        });
        const shouldEncodeDirectEnvelope = Boolean(activeChatQuote?.source || directHostedAgentTarget || messageMentions.length);
        const cloudBody = shouldEncodeDirectEnvelope
          ? encodeCloudDirectMessageEnvelope({
              schemaVersion: 1,
              kind: 'message',
              text,
              mentions: messageMentions,
              ...(directHostedAgentTarget ? {
                agentRuntimeRoute: resolveChatRuntimeRoute(
                  activeConvCanonicalSessionId ?? activeConvId,
                ),
              } : {}),
              ...(activeChatQuote?.source ? { messageAction: quoteMessageAction(activeChatQuote.source) } : {}),
              ...(directHostedAgentTarget ?? {}),
            })
          : text;
        const canonicalMessage = await sendCloudCollaborationMessage(
          activeCloudConversationId,
          cloudBody,
          attachmentsToSend,
          {
            clientMessageId: optimisticMessageId,
            messageKind: voiceMessage ? 'voice' : 'text',
            voiceMessage,
          },
        );
        if (appendedOptimisticCollaborationMessage && isCloudCollaborationConversationId(activeCloudConversationId)) {
          setCloudCollaborationState(reconcileOptimisticCollaborationMessageUpdater(activeCloudConversationId, optimisticMessageId, canonicalMessage));
        }
      } catch (error) {
        const failure = terminalCollaborationSendFailure({ error, fallback: 'Unable to send message', conversationId: activeCloudConversationId, messageId: optimisticMessageId, markOptimisticFailure: appendedOptimisticCollaborationMessage });
        if (failure) {
          setCloudCollaborationState(failure.updateOptimisticState);
          setDesktopChatError(failure.detail);
        }
      } finally {
        setIsDesktopChatSending(false);
      }
      return;
    }

    if (lockedSupportAgentTarget) {
      setDesktopChatError('Kordi Support is still loading. Try again in a moment.');
      return;
    }

    if (mentionedTarget && activeConversationUsesCollaborationRouting) {
      setDesktopChatError('This chat is unavailable. Try again from the chat list.');
      return;
    }

    if (activeConversationUsesCollaborationRouting && !localAgentMentioned) {
      setDesktopChatError('This chat is unavailable. Try again from the chat list.');
      return;
    }

    const isTransientDraftConversation = isLocalDraftChatConversationId(activeConvId);
    let targetSessionId = localChatTargetSessionIdForActiveConversation({
      activeConvId,
      activeConvCanonicalSessionId,
      desktopActiveSessionId: desktopChatState?.activeSessionId,
    });
    if (attachmentsToSend.length === 0 && (await handleLocalSlashCommand(text))) {
      setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, ''));
      resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
      setOpenComposerSelector(null);
      return;
    }

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
      queueLocalDraftForSession(localTargetSessionId, text, attachmentsToSend);
      return;
    }
    if (localSendDelayReason === 'session-starting') {
      setDesktopChatError(null);
      return;
    }

    const noProviderShortcutSessionId = activeConvCanonicalSessionId?.trim()
      || (isTransientDraftConversation ? generatedSelfAgentSessionId() : null);
    if (noProviderShortcutSessionId && shouldUseNoProviderSelfAgentShortcut({
      activeConversationUsesCollaborationRouting,
      activeConvCanonicalSessionId: activeConvCanonicalSessionId?.trim() || null,
      canonicalSessionState,
      hasAnyDesktopAuth,
    })) {
      localChatSendInFlightRef.current = { sessionId: localTargetSessionId };
      shouldAutoFollowChatRef.current = true;
      setIsDesktopChatSending(true);
      setDesktopChatError(null);
      const sentAt = formatDesktopEventTime();
      let canonicalBaseState = canonicalSessionState;
      const existingCanonicalSession = canonicalSessionState?.sessions.find((session) => session.id === noProviderShortcutSessionId) ?? null;
      if (!existingCanonicalSession && canonicalHumanIdentityId) {
        const primaryIdentityId = ownedAgentIdentityId(canonicalSessionState);
        if (primaryIdentityId) {
          const sessionTitle = optimisticSessionTitleFromMessage(text, attachmentsToSend, 'New chat');
          try {
            canonicalBaseState = await openOrCreateCanonicalSession({
              id: noProviderShortcutSessionId,
              kind: 'self-agent',
              title: sessionTitle,
              status: 'active',
              createdByIdentityId: canonicalHumanIdentityId,
              primaryIdentityId,
              participantIdentityIds: [canonicalHumanIdentityId, primaryIdentityId],
              metadata: {
                createdFrom: 'chat-create-flow',
                ...sessionTitleMetadata(sessionTitle === 'New chat' ? 'placeholder' : 'auto'),
              },
            });
          } catch (error) {
            localChatSendInFlightRef.current = null;
            setIsDesktopChatSending(false);
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to start chat session');
            return;
          }
        }
      }
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        noProviderShortcutSessionId,
        canonicalHumanIdentityId,
        text,
        attachmentsToSend,
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
      setPendingUserChatMessage(null);
      localChatSendInFlightRef.current = { sessionId: noProviderShortcutSessionId };
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
      if (!preserveComposer) {
        clearComposerAfterSend(chatDraftSessionIdsToClearForSend(activeConvId, noProviderShortcutSessionId));
      }
      localChatSendInFlightRef.current = null;
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
    const runtimeRouteForSend = resolvedPublishedAgentRuntimeRoute(
      activeConvMentionScope,
      resolveChatRuntimeRoute(targetSessionId ?? activeConvCanonicalSessionId ?? activeConvId),
    );
    const ensureLocalSessionId = async () => {
      if (targetSessionId) {
        if (!activeConvCollaborationTarget && desktopChatState?.activeSessionId !== targetSessionId) {
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
      if (runtimeRouteForSend?.model && publishCloudAgentRuntimeRouteChange) {
        await publishCloudAgentRuntimeRouteChange({
          sessionId: targetSessionId,
          model: runtimeRouteForSend.model,
          authProvider: runtimeRouteForSend.authProvider,
          authChoice: runtimeRouteForSend.authChoice,
          thinking: runtimeRouteForSend.thinking,
          initialSessionTitle: initialCloudAgentSessionTitle(
            text,
            chatComposerAttachments.length,
          ),
        });
      }
      setDesktopChatState(materializedState);
      setActiveConvId(targetSessionId);
      return targetSessionId;
    };

    localChatSendInFlightRef.current = { sessionId: localTargetSessionId };

    try {
      shouldAutoFollowChatRef.current = true;
      setIsDesktopChatSending(true);
      setDesktopChatError(null);
      const resolvedSessionId = await ensureLocalSessionId();
      localChatSendInFlightRef.current = { sessionId: resolvedSessionId };

      const sentAt = formatDesktopEventTime();
      const previewText = attachmentSummaryText(text, attachmentsToSend);
      const restoredContextMessages = restoredSelfAgentContextMessages(activeConvMessages);
      setPendingUserChatMessage(null);
      const parentSessionIdForMessage = targetSessionId ?? activeConvCanonicalSessionId ?? resolvedSessionId;
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        parentSessionIdForMessage,
        canonicalHumanIdentityId,
        text,
        attachmentsToSend,
        sentAt,
        'desktop-chat-ui',
        'sending',
        [],
        activeChatQuote,
      );
      const noProviderLocalShortcut = shouldUseNoProviderSelfAgentShortcut({
        activeConversationUsesCollaborationRouting,
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
            const sessionTitle = optimisticSessionTitleFromMessage(text, attachmentsToSend, 'New chat');
            canonicalBaseState = await openOrCreateCanonicalSession({
              id: canonicalSessionId,
              kind: 'self-agent',
              title: sessionTitle,
              status: 'active',
              createdByIdentityId: canonicalHumanIdentityId,
              primaryIdentityId,
              participantIdentityIds: [canonicalHumanIdentityId, primaryIdentityId],
              metadata: {
                createdFrom: 'chat-create-flow',
                ...sessionTitleMetadata(sessionTitle === 'New chat' ? 'placeholder' : 'auto'),
              },
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
            ? appendOptimisticOutboundMessage(baseState, resolvedSessionId, previewText, text, attachmentsToSend, sentAt, [], activeChatQuote)
            : current;
        });
        if (!preserveComposer) {
          clearComposerAfterSend(chatDraftSessionIdsToClearForSend(activeConvId, resolvedSessionId));
        }
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
      await sendLocalAgentChatMessage({
        targetConversationId: resolvedSessionId,
        canonicalSessionId: parentSessionIdForMessage,
        text,
        attachments: attachmentsToSend,
        sentAt,
        quote: activeChatQuote,
        contextMessages: [
          ...cloudAgentContextMessagesFromConversation(activeConvMentionScope ?? { metadata: null }),
          ...restoredContextMessages,
        ],
        clearDraftSessionIds: chatDraftSessionIdsToClearForSend(activeConvId, resolvedSessionId),
        materializedState,
        preserveComposer,
        setSendingState: true,
        runtimeRoute: runtimeRouteForSend,
      });
    } catch (error) {
      setPendingUserChatMessage(null);
      localChatSendInFlightRef.current = null;
      setIsDesktopChatSending(false);
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to send chat message');
    }
  }, [
    activeConversationUsesCollaboration,
    activeConvCollaborationTarget,
    activeConvSupportTicketEnabled,
    activeConvCanonicalSessionId,
    activeConvId,
    activeCloudConversationId,
    activeConvMessages,
    activeConvMentionScope,
    lockedSupportAgentTarget,
    sharedCloudAgents,
    resolveSharedCloudAgentsForMention,
    activeChatQuote,
    attachmentSummaryText,
    chatComposerAttachments,
    canonicalHumanIdentityId,
    composerDrafts.chat,
    composerSelections.chat.model,
    composerSelections.chat.thinking,
    desktopCollaborationState,
    desktopChatState,
    canonicalSessionState,
    hasAnyDesktopAuth,
    desktopLiveTurn,
    clearComposerAfterSend,
    handleLocalSlashCommand,
    isNativeShell,
    localChatSendInFlightRef,
    queueLocalDraftForSession,
    publishCloudAgentRuntimeRouteChange,
    refreshDesktopChat,
    resolveChatRuntimeRoute,
    setActiveConvId,
    setCanonicalSessionState,
    setCloudCollaborationState,
    sendCloudCollaborationMessage,
    sendCloudGroupControl,
    sendTargetedChatMessage,
    setDesktopChatError,
    setDesktopChatState,
    setIsDesktopChatSending,
    setOpenComposerSelector,
    setPendingUserChatMessage,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
    watchLocalTurnAndFlushQueue,
  ]);
  const handleRetryChatMessage = useCallback((message: Message) => (
    handleSendChatMessage(message.text, undefined, [], undefined, message)
  ), [handleSendChatMessage]);
  return { handleSendChatMessage, handleRetryChatMessage };
}
