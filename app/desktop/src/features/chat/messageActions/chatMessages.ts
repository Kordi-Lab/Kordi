import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { localAgentRuntimeRouteForBridgeState } from '@/features/bridge/agentModelRouting';
import { mergeDesktopBridgeState } from '@/features/bridge/useBridgeState';
import type {
  ComposerScope,
  Conversation,
  ConversationBridgeTarget,
  DesktopChatState,
  DesktopBridgeSessionParticipant,
} from '@/kordi-app/types';
import {
  cancelDesktopBridgeOutreach,
  createDesktopBridgeOutreach,
  createDesktopChatSession,
  fetchDesktopChatTurnState,
  openDesktopBridgeConversation,
  sendDesktopBridgeMessage,
  startDesktopChatMessage,
  updateDesktopChatSessionConfig,
} from '@/lib/desktop';

import { formatDesktopEventTime, resizeComposerTextarea } from '../composerController.shared';
import type { UseComposerControllerArgs } from '../composerController.types';
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
  findBridgeConversationForTarget,
  markOptimisticBridgeMessageFailed,
  persistCanonicalUserMessage,
  prepareCanonicalUserMessage,
} from './optimistic';
import { pendingOutreachFromState, relaySharedSessionMessage } from './relay';
import type { PendingBridgeOutreach } from './types';

export type LocalChatSendInFlight = {
  sessionId: string | null;
};

export function localChatSendIsInFlightForTarget(
  inFlight: LocalChatSendInFlight | null,
  targetSessionId: string | null,
) {
  if (!inFlight) return false;
  if (!inFlight.sessionId || !targetSessionId) return true;
  return inFlight.sessionId === targetSessionId;
}

export function chatSendIsBusy({
  isDesktopChatSending = false,
  desktopLiveTurn,
  localSendInFlight = false,
}: {
  isDesktopChatSending?: boolean;
  desktopLiveTurn?: { completed?: boolean } | null;
  localSendInFlight?: boolean;
}) {
  return Boolean(isDesktopChatSending || localSendInFlight || (desktopLiveTurn && !desktopLiveTurn.completed));
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

export function bridgeGroupSessionSendTargets(
  conversation: Pick<Conversation, 'canonicalParticipants'>,
  fallbackTarget?: ConversationBridgeTarget | null,
) {
  const targets = new Map<string, ConversationBridgeTarget>();
  const fallbackHostId = cleanText(fallbackTarget?.hostId);

  for (const participant of conversation.canonicalParticipants ?? []) {
    if (participant.kind !== 'human' || participantIsSelf(participant)) continue;
    const nodeId = cleanText(participant.bridgeNodeId);
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

  if (targets.size === 0 && fallbackTarget?.hostId && fallbackTarget.nodeId) {
    targets.set(`${fallbackTarget.hostId}:${fallbackTarget.nodeId}:${fallbackTarget.humanId ?? ''}`, {
      ...fallbackTarget,
      runtime: 'person',
      agentId: null,
    });
  }

  return [...targets.values()];
}

export function bridgeGroupSessionParticipants(conversation: Pick<Conversation, 'canonicalParticipants'>): DesktopBridgeSessionParticipant[] {
  const participants = new Map<string, DesktopBridgeSessionParticipant>();
  for (const participant of conversation.canonicalParticipants ?? []) {
    if (participant.kind !== 'human') continue;
    const displayName = cleanText(participant.name);
    if (!displayName) continue;
    const bridgeNodeId = cleanText(participant.bridgeNodeId);
    const humanId = cleanText(participant.humanId);
    const isSelf = participantIsSelf(participant);
    if (isSelf && !bridgeNodeId && !humanId) continue;
    participants.set(participant.id || `${bridgeNodeId ?? ''}:${humanId ?? ''}:${displayName}`, {
      identityId: cleanText(participant.id),
      displayName,
      role: isSelf ? 'self' : (cleanText(participant.role) ?? 'person'),
      bridgeNodeId,
      humanId,
    });
  }
  return [...participants.values()];
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
  | 'refreshDesktopChat'
  | 'setActiveConvId'
  | 'setCanonicalSessionState'
  | 'setChatComposerAttachments'
  | 'setComposerDrafts'
  | 'setDesktopBridgeState'
  | 'setDesktopChatError'
  | 'setDesktopChatState'
  | 'setDesktopLiveTurnsBySession'
  | 'setIsDesktopChatSending'
  | 'setOpenComposerSelector'
  | 'setPendingUserChatMessage'
  | 'shouldAutoFollowChatRef'
  | 'watchDesktopLiveTurn'
> & {
  attachmentSummaryText: (text: string) => string;
  handleLocalSlashCommand: (rawText: string, scope?: ComposerScope) => Promise<boolean>;
  pendingBridgeCancelRequestedRef: MutableRefObject<boolean>;
  localChatSendInFlightRef: MutableRefObject<LocalChatSendInFlight | null>;
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
  isDesktopChatSending,
  isNativeShell,
  pendingBridgeCancelRequestedRef,
  localChatSendInFlightRef,
  refreshDesktopChat,
  setActiveConvId,
  setCanonicalSessionState,
  setChatComposerAttachments,
  setComposerDrafts,
  setDesktopBridgeState,
  setDesktopChatError,
  setDesktopChatState,
  setDesktopLiveTurnsBySession,
  setIsDesktopChatSending,
  setOpenComposerSelector,
  setPendingBridgeOutreach,
  setPendingUserChatMessage,
  shouldAutoFollowChatRef,
  watchDesktopLiveTurn,
}: UseChatMessageActionsArgs) {
  return useCallback(async (draftOverride?: string) => {
    if (!isNativeShell) return;
    const rawText = draftOverride ?? composerDrafts.chat;
    const text = rawText.trim();
    if (!text && chatComposerAttachments.length === 0) return;
    if (chatSendIsBusy({ isDesktopChatSending, desktopLiveTurn })) return;

    const mentionedTarget = resolveMentionedBridgeTarget(text, desktopBridgeState, activeConvMentionScope, { targetKind: 'bridge-agent' });

    if (mentionedTarget && (activeConversationIsBridge || activeConvBridgeTarget)) {
      try {
        shouldAutoFollowChatRef.current = true;
        pendingBridgeCancelRequestedRef.current = false;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        setComposerDrafts((current) => ({ ...current, chat: '' }));
        setChatComposerAttachments([]);
        resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
        const sentAt = formatDesktopEventTime();
        const parentSessionId = activeConvCanonicalSessionId ?? activeConvId;
        const mentionIsSessionMessage = Boolean(
          activeConvCanonicalSessionId && mentionedPersonIsActiveBridgeTarget(mentionedTarget, activeConvBridgeTarget),
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
          .then((parentMessageId) => createDesktopBridgeOutreach({
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
            parentSessionMessages: mentionIsSessionMessage ? [] : parentSessionMessagesForOutreach(activeConvMessages),
            parentMessageId,
            projectId: mentionIsSessionMessage ? null : desktopChatState?.activeSession.project?.root,
            projectName: mentionIsSessionMessage ? null : desktopChatState?.activeSession.project?.name,
            ...bridgeAttachmentTransportFields(chatComposerAttachments),
          }))
          .then((nextState) => {
            if (mentionedTarget.targetKind === 'bridge-agent') {
              const pending = pendingOutreachFromState(nextState, parentSessionId, mentionedTarget.peer.nodeId);
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

    if ((activeConversationIsBridge || activeConvBridgeTarget) && !mentionsLocalAgent(text, desktopChatState, desktopBridgeState)) {
      const sentAt = formatDesktopEventTime();
      const previewText = attachmentSummaryText(text);
      const bridgeMessageText = text;
      const optimisticMessageId = `bridge-pending-${Date.now()}`;
      const hasMaterializedBridgeConversation = activeConversationIsBridge && activeConvId.startsWith('bridge:');
      const existingTargetConversation = activeConvBridgeTarget && desktopBridgeState
        ? findBridgeConversationForTarget(desktopBridgeState, activeConvBridgeTarget)
        : null;
      const shouldStayInCanonicalSession = Boolean(activeConvBridgeTarget && activeConvCanonicalSessionId);
      const groupSessionScope = {
        canonicalSessionId: activeConvCanonicalSessionId ?? activeConvId,
        participantSpaceId: activeConvMentionScope?.participantSpaceId,
        directness: activeConvMentionScope?.directness,
        canonicalParticipants: activeConvMentionScope?.canonicalParticipants,
      };
      const isGroupSessionMessage = shouldStayInCanonicalSession && isBridgeGroupSession(groupSessionScope);
      const groupSendTargets = isGroupSessionMessage
        ? bridgeGroupSessionSendTargets(groupSessionScope, activeConvBridgeTarget)
        : [];
      const groupSessionParticipants = isGroupSessionMessage
        ? bridgeGroupSessionParticipants(groupSessionScope)
        : [];
      const sendPlan = bridgeConversationSendPlan({
        activeConvId,
        hasMaterializedBridgeConversation,
        existingTargetConversationId: existingTargetConversation?.id ?? null,
        shouldStayInCanonicalSession,
      });
      let targetConversationId = sendPlan.targetConversationId;
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
        const preparedCanonicalMessage = prepareCanonicalUserMessage(
          optimisticParentSessionId,
          canonicalHumanIdentityId,
          text,
          chatComposerAttachments,
          sentAt,
          'desktop-bridge-ui',
          shouldStayInCanonicalSession ? 'sent' : 'sending',
        );
        setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
        if (targetConversationId && !isGroupSessionMessage) {
          setDesktopBridgeState((current) => appendOptimisticBridgeMessage(current, targetConversationId!, bridgeMessageText, sentAt, optimisticMessageId, chatComposerAttachments, previewText));
        }
        setComposerDrafts((current) => ({ ...current, chat: '' }));
        setChatComposerAttachments([]);
        resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
        const resolvedConversationId = targetConversationId;
        void persistCanonicalUserMessage(preparedCanonicalMessage)
          .catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
          })
          .then(async () => {
            if (isGroupSessionMessage && activeConvCanonicalSessionId) {
              if (groupSendTargets.length === 0) {
                throw new Error('Unable to resolve group recipients');
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
              return null;
            }
            if (shouldStayInCanonicalSession && activeConvBridgeTarget && activeConvCanonicalSessionId) {
              return createDesktopBridgeOutreach({
                hostId: activeConvBridgeTarget.hostId,
                targetNodeId: activeConvBridgeTarget.nodeId,
                targetKind: 'bridge-person',
                requestText: bridgeMessageText,
                targetDisplayName: activeConvBridgeTarget.displayName ?? activeConvBridgeTarget.ownerName ?? null,
                targetOwnerName: activeConvBridgeTarget.ownerName ?? activeConvBridgeTarget.displayName ?? null,
                targetRuntime: 'person',
                targetHumanId: activeConvBridgeTarget.humanId ?? null,
                targetAgentId: null,
                triggerText: null,
                contextText: null,
                contextPolicy: 'session-message',
                parentSessionId: activeConvCanonicalSessionId,
                parentSessionTitle: null,
                parentSessionMessages: [],
                parentTurnId: null,
                parentMessageId: preparedCanonicalMessage?.messageId ?? null,
                projectId: null,
                projectName: null,
                ...bridgeAttachmentTransportFields(chatComposerAttachments),
              });
            }
            if (!resolvedConversationId) {
              throw new Error('Unable to resolve bridge conversation');
            }
            return sendDesktopBridgeMessage(resolvedConversationId, bridgeMessageText, chatComposerAttachments);
          })
          .then((nextState) => {
            if (nextState) {
              setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
            }
          })
          .catch((error: unknown) => {
            if (resolvedConversationId) {
              setDesktopBridgeState((current) => markOptimisticBridgeMessageFailed(current, resolvedConversationId, optimisticMessageId));
            }
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to send bridge message');
          });
      } catch (error) {
        if (targetConversationId) {
          setDesktopBridgeState((current) => markOptimisticBridgeMessageFailed(current, targetConversationId!, optimisticMessageId));
        }
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to send bridge message');
      } finally {
        setIsDesktopChatSending(false);
      }
      return;
    }

    const isTransientDraftConversation = isLocalDraftChatConversationId(activeConvId);
    let targetSessionId = isTransientDraftConversation
      ? null
      : activeConvId && !activeConvId.startsWith('bridge:') && !isLocalDraftChatConversationId(activeConvId)
        ? activeConvId
        : desktopChatState?.activeSessionId;
    if (isLocalDraftChatConversationId(targetSessionId)) {
      targetSessionId = null;
    }
    if (chatComposerAttachments.length === 0 && (await handleLocalSlashCommand(text))) {
      setComposerDrafts((current) => ({ ...current, chat: '' }));
      resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
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
        setComposerDrafts((current) => ({ ...current, chat: '' }));
        setChatComposerAttachments([]);
        resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
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
    if (chatSendIsBusy({ localSendInFlight: localChatSendIsInFlightForTarget(localChatSendInFlightRef.current, localTargetSessionId) })) return;
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
      const willRelayToLocalAgent = Boolean(
        activeConvBridgeTarget
        && mentionsLocalAgent(text, desktopChatState, desktopBridgeState),
      );
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        parentSessionIdForMessage,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'desktop-chat-ui',
        willRelayToLocalAgent ? 'sent' : 'sending',
      );
      const localAgentRelayTarget = willRelayToLocalAgent && activeConvBridgeTarget
        ? {
            target: activeConvBridgeTarget,
            parentSessionId: parentSessionIdForMessage,
            parentMessageId: preparedCanonicalMessage?.messageId ?? null,
            parentSessionTitle: desktopChatState?.activeSession.title ?? null,
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
      setComposerDrafts((current) => ({ ...current, chat: '' }));
      setChatComposerAttachments([]);
      resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
      const runtimeMessageText = localAgentRelayTarget
        ? localAgentRuntimeText(text, desktopChatState, desktopBridgeState)
        : text;
      if (localAgentRelayTarget) {
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
          const userRelayPromise = localAgentRelayTarget
            ? relaySharedSessionMessage(
              localAgentRelayTarget.target,
              localAgentRelayTarget.parentSessionId,
              publicLocalAgentMentionText(text, desktopBridgeState),
              localAgentRelayTarget.parentSessionTitle,
              localAgentRelayTarget.parentMessageId,
              null,
              undefined,
              undefined,
              chatComposerAttachments,
            )
              .then((nextState) => {
                setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
              })
              .catch((error: unknown) => {
                setDesktopChatError(error instanceof Error ? error.message : 'Unable to relay local agent request');
              })
            : null;
          const turn = await startDesktopChatMessage(
            resolvedSessionId,
            runtimeMessageText,
            attachmentPaths,
            localAgentRelayTarget ? localAgentRuntimeRouteForBridgeState(desktopBridgeState, desktopChatState) : null,
          );
          const localAgentBridgeRequestId = `bridge_req_${turn.id.replace(/[^a-zA-Z0-9]/g, '')}`;
          let processingRelayPromise: Promise<void> | null = null;
          if (localAgentRelayTarget) {
            await userRelayPromise;
            processingRelayPromise = relaySharedSessionMessage(
              localAgentRelayTarget.target,
              localAgentRelayTarget.parentSessionId,
              'processing...',
              localAgentRelayTarget.parentSessionTitle,
              localAgentRelayTarget.parentMessageId,
              turn.id,
              'processing',
              localAgentBridgeRequestId,
            )
              .then((nextState) => {
                setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
              })
              .catch((error: unknown) => {
                setDesktopChatError(error instanceof Error ? error.message : 'Unable to relay local agent progress');
              });
          }
          return { turn, processingRelayPromise, localAgentBridgeRequestId };
        })
        .then(({ turn, processingRelayPromise, localAgentBridgeRequestId }) => {
          if (!localAgentRelayTarget) {
            void watchDesktopLiveTurn(turn).finally(() => {
              if (localChatSendInFlightRef.current?.sessionId === turn.sessionId) {
                localChatSendInFlightRef.current = null;
              }
            });
            setIsDesktopChatSending(false);
            return;
          }

          void (async () => {
            try {
              await watchDesktopLiveTurn(turn);
              await processingRelayPromise;
              const completedTurn = await fetchDesktopChatTurnState(turn.id);
              const assistantText = stripLeadingAddressMentions(
                completedTurn.assistantText.trim(),
                localHumanAddressLabels(desktopBridgeState),
              );
              if (!completedTurn.succeeded || !assistantText) return;
              const nextState = await relaySharedSessionMessage(
                localAgentRelayTarget.target,
                localAgentRelayTarget.parentSessionId,
                assistantText,
                localAgentRelayTarget.parentSessionTitle,
                localAgentRelayTarget.parentMessageId,
                completedTurn.id,
                'responded',
                localAgentBridgeRequestId,
              );
              setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
            } finally {
              if (localChatSendInFlightRef.current?.sessionId === resolvedSessionId) {
                localChatSendInFlightRef.current = null;
              }
              setIsDesktopChatSending(false);
            }
          })().catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to relay local agent response');
          });
        })
        .catch((error: unknown) => {
          if (localAgentRelayTarget) {
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
    isDesktopChatSending,
    isNativeShell,
    localChatSendInFlightRef,
    refreshDesktopChat,
    setActiveConvId,
    setCanonicalSessionState,
    setChatComposerAttachments,
    setComposerDrafts,
    setDesktopBridgeState,
    setDesktopChatError,
    setDesktopChatState,
    setIsDesktopChatSending,
    setOpenComposerSelector,
    setPendingUserChatMessage,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
  ]);


}
