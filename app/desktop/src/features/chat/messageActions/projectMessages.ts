import { useCallback } from 'react';

import { mergeDesktopBridgeState } from '@/features/bridge/useBridgeState';
import type { Project } from '@/kordi-app/types';
import { createDesktopBridgeOutreach, startDesktopChatMessage } from '@/lib/desktop';

import { formatDesktopEventTime, resizeComposerTextarea } from '../composerController.shared';
import type { UseComposerControllerArgs } from '../composerController.types';
import { combineContext, parentSessionMessagesForOutreach, renderProjectContext, renderRecentMessageContext } from './context';
import { mentionForBridgeTarget, outreachIdentityForBridgeTarget, resolveMentionedBridgeTarget } from './mentions';
import { appendOptimisticCanonicalMessage, appendOptimisticOutboundMessage, persistCanonicalUserMessage, prepareCanonicalUserMessage, toOptimisticAttachments } from './optimistic';

type UseProjectMessageActionsArgs = Pick<
  UseComposerControllerArgs,
  | 'activeConvMessages'
  | 'activeProjectId'
  | 'activeProjectSessionId'
  | 'canonicalHumanIdentityId'
  | 'chatComposerAttachments'
  | 'composerDrafts'
  | 'desktopBridgeState'
  | 'desktopChatState'
  | 'desktopLiveTurn'
  | 'isNativeShell'
  | 'setCanonicalSessionState'
  | 'setChatComposerAttachments'
  | 'setDesktopBridgeState'
  | 'setDesktopChatError'
  | 'setDesktopChatState'
  | 'setIsDesktopChatSending'
  | 'setProjectWorkspaces'
  | 'shouldAutoFollowChatRef'
  | 'watchDesktopLiveTurn'
> & {
  appendProjectDraft: (value: string) => void;
  attachmentSummaryText: (text: string) => string;
};

export function useProjectMessageActions({
  activeConvMessages,
  activeProjectId,
  activeProjectSessionId,
  appendProjectDraft,
  attachmentSummaryText,
  canonicalHumanIdentityId,
  chatComposerAttachments,
  composerDrafts,
  desktopBridgeState,
  desktopChatState,
  desktopLiveTurn,
  isNativeShell,
  setCanonicalSessionState,
  setChatComposerAttachments,
  setDesktopBridgeState,
  setDesktopChatError,
  setDesktopChatState,
  setIsDesktopChatSending,
  setProjectWorkspaces,
  shouldAutoFollowChatRef,
  watchDesktopLiveTurn,
}: UseProjectMessageActionsArgs) {
  return useCallback(async (draftOverride?: string) => {
    const rawText = draftOverride ?? composerDrafts.project;
    const text = rawText.trim();
    if (!activeProjectSessionId || (!text && chatComposerAttachments.length === 0)) return;

    if (!isNativeShell) {
      shouldAutoFollowChatRef.current = true;
      const sentAt = formatDesktopEventTime();

      setProjectWorkspaces((current: Project[]) =>
        current.map((project) =>
          project.id !== activeProjectId
            ? project
            : {
                ...project,
                sessions: project.sessions.map((session) =>
                  session.id !== activeProjectSessionId
                    ? session
                    : {
                        ...session,
                        lastActive: sentAt,
                        messages: [
                          ...session.messages,
                          {
                            role: 'user',
                            sender: 'You',
                            text,
                            attachments: toOptimisticAttachments(chatComposerAttachments),
                            time: sentAt,
                          },
                        ],
                      },
                ),
              },
        ),
      );
      appendProjectDraft('');
      setChatComposerAttachments([]);
      return;
    }

    if (desktopLiveTurn && !desktopLiveTurn.completed) return;

    const mentionedTarget = chatComposerAttachments.length === 0 ? resolveMentionedBridgeTarget(text, desktopBridgeState) : null;
    if (mentionedTarget) {
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        appendProjectDraft('');
        resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]');
        const sentAt = formatDesktopEventTime();
        const preparedCanonicalMessage = prepareCanonicalUserMessage(
          activeProjectSessionId,
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
          if (!current || current.activeSessionId !== activeProjectSessionId) return current;
          return appendOptimisticOutboundMessage(current, activeProjectSessionId, text, text, [], sentAt, mentionForBridgeTarget(mentionedTarget));
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
            parentSessionId: activeProjectSessionId,
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
      const sentAt = formatDesktopEventTime();
      const attachmentPaths = chatComposerAttachments.map((item) => item.path);
      const previewText = attachmentSummaryText(text);
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        activeProjectSessionId,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'desktop-chat-ui',
      );
      setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
      setDesktopChatState((current) => {
        if (!current || current.activeSessionId !== activeProjectSessionId) return current;
        return appendOptimisticOutboundMessage(current, activeProjectSessionId, previewText, text, chatComposerAttachments, sentAt);
      });
      appendProjectDraft('');
      setChatComposerAttachments([]);
      resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]');
      void persistCanonicalUserMessage(preparedCanonicalMessage)
        .catch((error: unknown) => {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
        })
        .then(() => startDesktopChatMessage(activeProjectSessionId, text, attachmentPaths))
        .then((turn) => {
          void watchDesktopLiveTurn(turn);
        })
        .catch((error: unknown) => {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to send project message');
        });
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to send project message');
    }
  }, [
    activeConvMessages,
    activeProjectId,
    activeProjectSessionId,
    canonicalHumanIdentityId,
    appendProjectDraft,
    attachmentSummaryText,
    chatComposerAttachments,
    composerDrafts.project,
    desktopBridgeState,
    desktopChatState,
    desktopLiveTurn,
    isNativeShell,
    setCanonicalSessionState,
    setChatComposerAttachments,
    setDesktopBridgeState,
    setDesktopChatError,
    setDesktopChatState,
    setIsDesktopChatSending,
    setProjectWorkspaces,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
  ]);


}
