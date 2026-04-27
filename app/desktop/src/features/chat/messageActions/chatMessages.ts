import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { mergeDesktopBridgeState } from '@/features/bridge/useBridgeState';
import type { ComposerScope, DesktopChatState } from '@/kordi-app/types';
import {
  cancelDesktopBridgeOutreach,
  createDesktopBridgeOutreach,
  createDesktopChatSession,
  fetchDesktopChatTurnState,
  openDesktopBridgeConversation,
  sendDesktopBridgeMessage,
  startDesktopChatMessage,
} from '@/lib/desktop';

import { formatDesktopEventTime, resizeComposerTextarea } from '../composerController.shared';
import type { UseComposerControllerArgs } from '../composerController.types';
import { isLocalDraftChatConversationId } from '../draftSessions';
import { combineContext, parentSessionMessagesForOutreach, renderProjectContext, renderRecentMessageContext } from './context';
import {
  localAgentRuntimeText,
  localHumanAddressLabels,
  mentionForBridgeTarget,
  mentionedPersonIsActiveBridgeTarget,
  mentionsLocalAgent,
  outreachIdentityForBridgeTarget,
  resolveMentionedBridgeTarget,
  stripLeadingAddressMentions,
} from './mentions';
import {
  appendOptimisticBridgeMessage,
  appendOptimisticCanonicalMessage,
  appendOptimisticOutboundMessage,
  findBridgeConversationForTarget,
  markOptimisticBridgeMessageFailed,
  persistCanonicalUserMessage,
  prepareCanonicalUserMessage,
} from './optimistic';
import { pendingOutreachFromState, relaySharedSessionMessage } from './relay';
import type { PendingBridgeOutreach } from './types';

type UseChatMessageActionsArgs = Pick<
  UseComposerControllerArgs,
  | 'activeConversationIsBridge'
  | 'activeConvBridgeTarget'
  | 'activeConvCanonicalSessionId'
  | 'activeConvId'
  | 'activeConvMessages'
  | 'canonicalHumanIdentityId'
  | 'chatComposerAttachments'
  | 'composerDrafts'
  | 'desktopBridgeState'
  | 'desktopChatState'
  | 'desktopLiveTurn'
  | 'isNativeShell'
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
  setPendingBridgeOutreach: Dispatch<SetStateAction<PendingBridgeOutreach | null>>;
};

export function useChatMessageActions({
  activeConversationIsBridge,
  activeConvBridgeTarget,
  activeConvCanonicalSessionId,
  activeConvId,
  activeConvMessages,
  attachmentSummaryText,
  canonicalHumanIdentityId,
  chatComposerAttachments,
  composerDrafts,
  desktopBridgeState,
  desktopChatState,
  desktopLiveTurn,
  handleLocalSlashCommand,
  isNativeShell,
  pendingBridgeCancelRequestedRef,
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

    const mentionedTarget = chatComposerAttachments.length === 0 ? resolveMentionedBridgeTarget(text, desktopBridgeState) : null;

    if (mentionedTarget && (activeConversationIsBridge || activeConvBridgeTarget)) {
      try {
        shouldAutoFollowChatRef.current = true;
        pendingBridgeCancelRequestedRef.current = false;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        setComposerDrafts((current) => ({ ...current, chat: '' }));
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
          [],
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
      if (chatComposerAttachments.length > 0) {
        setDesktopChatError('Bridge chats do not support attachments yet.');
        return;
      }
      const sentAt = formatDesktopEventTime();
      const optimisticMessageId = `bridge-pending-${Date.now()}`;
      const hasMaterializedBridgeConversation = activeConversationIsBridge && activeConvId.startsWith('bridge:');
      const existingTargetConversation = activeConvBridgeTarget && desktopBridgeState
        ? findBridgeConversationForTarget(desktopBridgeState, activeConvBridgeTarget)
        : null;
      const shouldStayInCanonicalSession = Boolean(activeConvBridgeTarget && activeConvCanonicalSessionId);
      let targetConversationId = hasMaterializedBridgeConversation ? activeConvId : existingTargetConversation?.id ?? null;
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);

        if (!targetConversationId && activeConvBridgeTarget) {
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

        if (!targetConversationId) {
          throw new Error('Unable to resolve bridge conversation');
        }

        const preparedCanonicalMessage = prepareCanonicalUserMessage(
          activeConvCanonicalSessionId ?? targetConversationId,
          canonicalHumanIdentityId,
          text,
          [],
          sentAt,
          'desktop-bridge-ui',
          shouldStayInCanonicalSession ? 'sent' : 'sending',
        );
        setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
        setDesktopBridgeState((current) => appendOptimisticBridgeMessage(current, targetConversationId!, text, sentAt, optimisticMessageId));
        setComposerDrafts((current) => ({ ...current, chat: '' }));
        resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
        const resolvedConversationId = targetConversationId;
        void persistCanonicalUserMessage(preparedCanonicalMessage)
          .catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
          })
          .then(() => {
            if (shouldStayInCanonicalSession && activeConvBridgeTarget && activeConvCanonicalSessionId) {
              return createDesktopBridgeOutreach({
                hostId: activeConvBridgeTarget.hostId,
                targetNodeId: activeConvBridgeTarget.nodeId,
                targetKind: 'bridge-person',
                requestText: text,
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
              });
            }
            return sendDesktopBridgeMessage(resolvedConversationId, text);
          })
          .then((nextState) => {
            setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
          })
          .catch((error: unknown) => {
            setDesktopBridgeState((current) => markOptimisticBridgeMessageFailed(current, resolvedConversationId, optimisticMessageId));
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
    if (desktopLiveTurn && !desktopLiveTurn.completed) return;

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
        resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
        const parentSessionId = await ensureLocalSessionId();
        const sentAt = formatDesktopEventTime();
        const preparedCanonicalMessage = prepareCanonicalUserMessage(
          parentSessionId,
          canonicalHumanIdentityId,
          text,
          [],
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
          return appendOptimisticOutboundMessage(baseState, parentSessionId, text, text, [], sentAt, mentionForBridgeTarget(mentionedTarget));
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

    try {
      shouldAutoFollowChatRef.current = true;
      setDesktopChatError(null);
      const resolvedSessionId = await ensureLocalSessionId();

      const sentAt = formatDesktopEventTime();
      const attachmentPaths = chatComposerAttachments.map((item) => item.path);
      const previewText = attachmentSummaryText(text);
      setPendingUserChatMessage(null);
      const parentSessionIdForMessage = activeConvCanonicalSessionId ?? resolvedSessionId;
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        parentSessionIdForMessage,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'desktop-chat-ui',
      );
      const localAgentRelayTarget = chatComposerAttachments.length === 0
        && activeConvBridgeTarget
        && mentionsLocalAgent(text, desktopChatState, desktopBridgeState)
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
              text,
              localAgentRelayTarget.parentSessionTitle,
              localAgentRelayTarget.parentMessageId,
              null,
            )
              .then((nextState) => {
                setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
              })
              .catch((error: unknown) => {
                setDesktopChatError(error instanceof Error ? error.message : 'Unable to relay local agent request');
              })
            : null;
          const turn = await startDesktopChatMessage(resolvedSessionId, runtimeMessageText, attachmentPaths);
          return { turn, userRelayPromise };
        })
        .then(({ turn, userRelayPromise }) => {
          if (!localAgentRelayTarget) {
            void watchDesktopLiveTurn(turn);
            return;
          }

          void (async () => {
            try {
              await watchDesktopLiveTurn(turn);
              const completedTurn = await fetchDesktopChatTurnState(turn.id);
              const assistantText = stripLeadingAddressMentions(
                completedTurn.assistantText.trim(),
                localHumanAddressLabels(desktopBridgeState),
              );
              if (!completedTurn.succeeded || !assistantText) return;
              await userRelayPromise;
              const nextState = await relaySharedSessionMessage(
                localAgentRelayTarget.target,
                localAgentRelayTarget.parentSessionId,
                assistantText,
                localAgentRelayTarget.parentSessionTitle,
                localAgentRelayTarget.parentMessageId,
                completedTurn.id,
              );
              setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
            } finally {
              setIsDesktopChatSending(false);
            }
          })().catch((error: unknown) => {
            setDesktopChatError(error instanceof Error ? error.message : 'Unable to relay local agent response');
          });
        })
        .catch((error: unknown) => {
          if (localAgentRelayTarget) {
            setIsDesktopChatSending(false);
            setDesktopLiveTurnsBySession((current) => {
              if (!current[resolvedSessionId]) return current;
              const { [resolvedSessionId]: _removed, ...rest } = current;
              return rest;
            });
          }
          setPendingUserChatMessage(null);
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to send chat message');
        });
    } catch (error) {
      setPendingUserChatMessage(null);
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to send chat message');
    }
  }, [
    activeConversationIsBridge,
    activeConvBridgeTarget,
    activeConvCanonicalSessionId,
    activeConvId,
    activeConvMessages,
    attachmentSummaryText,
    chatComposerAttachments,
    canonicalHumanIdentityId,
    composerDrafts.chat,
    desktopBridgeState,
    desktopChatState,
    desktopLiveTurn,
    handleLocalSlashCommand,
    isNativeShell,
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
