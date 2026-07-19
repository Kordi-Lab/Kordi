import { useCallback } from 'react';

import type { Project } from '@/kordi-app/types';
import { createDesktopProjectSession, startDesktopChatMessage } from '@/lib/desktop';
import { isProjectDraftSessionId } from '../draftSessions';

import { formatDesktopEventTime, resizeComposerTextarea } from '../composerController.shared';
import type { UseComposerControllerArgs } from '../composerController.types';
import { resolveMentionedBridgeTarget } from './mentions';
import { appendOptimisticCanonicalMessage, appendOptimisticOutboundMessage, optimisticSessionTitleFromMessage, persistCanonicalUserMessage, prepareCanonicalUserMessage, toOptimisticAttachments } from './optimistic';

type UseProjectMessageActionsArgs = Pick<
  UseComposerControllerArgs,
  | 'activeConvMessages'
  | 'activeProjectId'
  | 'activeProjectSessionId'
  | 'activeProjectRoot'
  | 'selectProjectSession'
  | 'canonicalHumanIdentityId'
  | 'chatComposerAttachments'
  | 'composerDrafts'
  | 'desktopBridgeState'
  | 'desktopChatState'
  | 'desktopLiveTurn'
  | 'isNativeShell'
  | 'setCanonicalSessionState'
  | 'setChatComposerAttachments'
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
  activeProjectRoot,
  selectProjectSession,
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
    if (!text && chatComposerAttachments.length === 0) return;

    let resolvedProjectSessionId = isProjectDraftSessionId(activeProjectSessionId) ? '' : activeProjectSessionId;
    let resolvedDesktopChatState = desktopChatState;
    const ensureProjectSession = async () => {
      if (resolvedProjectSessionId) {
        return { sessionId: resolvedProjectSessionId, state: resolvedDesktopChatState };
      }
      const projectRoot = activeProjectRoot?.trim();
      if (!projectRoot) {
        throw new Error('Create or select a project before sending a project message.');
      }
      const sessionTitle = optimisticSessionTitleFromMessage(text, chatComposerAttachments, 'New chat');
      const nextState = await createDesktopProjectSession(projectRoot, sessionTitle);
      resolvedDesktopChatState = nextState;
      resolvedProjectSessionId = nextState.activeSessionId;
      setDesktopChatState(nextState);
      selectProjectSession(activeProjectId, resolvedProjectSessionId);
      return { sessionId: resolvedProjectSessionId, state: nextState };
    };

    if (!isNativeShell) {
      if (!activeProjectSessionId) return;
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
                            sender: 'Me',
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

    const mentionedTarget = resolveMentionedBridgeTarget(text, desktopBridgeState, null, { targetKind: 'bridge-agent' });
    if (mentionedTarget) {
      setDesktopChatError('This chat is unavailable. Try again from the chat list.');
      return;
    }

    try {
      shouldAutoFollowChatRef.current = true;
      setDesktopChatError(null);
      const { sessionId: projectSessionId } = await ensureProjectSession();
      const sentAt = formatDesktopEventTime();
      const attachmentPaths = chatComposerAttachments.map((item) => item.path);
      const previewText = attachmentSummaryText(text);
      const preparedCanonicalMessage = prepareCanonicalUserMessage(
        projectSessionId,
        canonicalHumanIdentityId,
        text,
        chatComposerAttachments,
        sentAt,
        'desktop-chat-ui',
      );
      setCanonicalSessionState((current) => appendOptimisticCanonicalMessage(current, preparedCanonicalMessage));
      setDesktopChatState((current) => {
        if (!current || current.activeSessionId !== projectSessionId) return current;
        return appendOptimisticOutboundMessage(current, projectSessionId, previewText, text, chatComposerAttachments, sentAt);
      });
      appendProjectDraft('');
      setChatComposerAttachments([]);
      resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]');
      void persistCanonicalUserMessage(preparedCanonicalMessage)
        .catch((error: unknown) => {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to save message');
        })
        .then(() => startDesktopChatMessage(projectSessionId, text, attachmentPaths))
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
    activeProjectRoot,
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
    setDesktopChatError,
    setDesktopChatState,
    setIsDesktopChatSending,
    setProjectWorkspaces,
    selectProjectSession,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
  ]);


}
