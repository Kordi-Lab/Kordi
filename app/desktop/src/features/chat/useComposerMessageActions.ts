import { useCallback } from 'react';

import type { ComposerScope, DesktopChatState, Project } from '@/kordi-app/types';
import {
  cancelDesktopChatTurn,
  runDesktopChatSkillCommand,
  sendDesktopBridgeMessage,
  startDesktopChatMessage,
} from '@/lib/desktop';

import {
  desktopHotkeyHelpText,
  desktopSlashHelpText,
  formatDesktopEventTime,
  isSharedLocalSlashCommand,
  resizeComposerTextarea,
} from './composerController.shared';
import type { UseComposerControllerArgs } from './composerController.types';

type UseComposerMessageActionsArgs = Pick<
  UseComposerControllerArgs,
  | 'isNativeShell'
  | 'activeConversationIsBridge'
  | 'activeConvId'
  | 'activeConvMessages'
  | 'activeProjectId'
  | 'activeProjectSessionId'
  | 'desktopChatState'
  | 'desktopLiveTurn'
  | 'composerDrafts'
  | 'setComposerDrafts'
  | 'setProjectWorkspaces'
  | 'setOpenComposerSelector'
  | 'chatComposerAttachments'
  | 'setChatComposerAttachments'
  | 'chatModelOptions'
  | 'refreshDesktopAuth'
  | 'refreshDesktopChat'
  | 'handleCreateChatSession'
  | 'handleRenameDesktopSession'
  | 'setActiveNav'
  | 'setActiveSettingsSectionId'
  | 'setActiveDetailTab'
  | 'setIsDetailPanelCollapsed'
  | 'setDesktopSessionRenameDraft'
  | 'setIsEditingDesktopSessionTitle'
  | 'setDesktopChatState'
  | 'setDesktopChatError'
  | 'setIsDesktopChatSending'
  | 'setPendingUserChatMessage'
  | 'setDesktopBridgeState'
  | 'watchDesktopLiveTurn'
  | 'shouldAutoFollowChatRef'
> & {
  attachmentSummaryText: (text: string) => string;
  selectComposerValue: (scope: ComposerScope, type: 'model', value: string) => Promise<void>;
  appendProjectDraft: (value: string) => void;
  appendChatDraft: (value: string) => void;
};

function appendOptimisticOutboundMessage(
  current: DesktopChatState,
  targetSessionId: string,
  displayText: string,
  sentAt: string,
) {
  const optimisticMessage = {
    role: 'user' as const,
    sender: 'You',
    text: displayText,
    timeLabel: sentAt,
    timestampMs: Date.now(),
  };

  return {
    ...current,
    sessions: current.sessions.map((session) =>
      session.id === targetSessionId
        ? {
            ...session,
            subtitle: displayText,
            updatedAtLabel: sentAt,
            messageCount: session.messageCount + 1,
          }
        : session,
    ),
    activeSession:
      current.activeSession.id === targetSessionId
        ? {
            ...current.activeSession,
            subtitle: displayText,
            updatedAtLabel: sentAt,
            messageCount: current.activeSession.messageCount + 1,
            messages: [...current.activeSession.messages, optimisticMessage],
          }
        : current.activeSession,
  };
}

export function useComposerMessageActions({
  isNativeShell,
  activeConversationIsBridge,
  activeConvId,
  activeConvMessages,
  activeProjectId,
  activeProjectSessionId,
  desktopChatState,
  desktopLiveTurn,
  composerDrafts,
  setComposerDrafts,
  setProjectWorkspaces,
  setOpenComposerSelector,
  chatComposerAttachments,
  setChatComposerAttachments,
  chatModelOptions,
  refreshDesktopAuth,
  refreshDesktopChat,
  handleCreateChatSession,
  handleRenameDesktopSession,
  setActiveNav,
  setActiveSettingsSectionId,
  setActiveDetailTab,
  setIsDetailPanelCollapsed,
  setDesktopSessionRenameDraft,
  setIsEditingDesktopSessionTitle,
  setDesktopChatState,
  setDesktopChatError,
  setIsDesktopChatSending,
  setPendingUserChatMessage,
  setDesktopBridgeState,
  watchDesktopLiveTurn,
  shouldAutoFollowChatRef,
  attachmentSummaryText,
  selectComposerValue,
  appendProjectDraft,
  appendChatDraft,
}: UseComposerMessageActionsArgs) {
  const appendDesktopSystemMessage = useCallback((text: string) => {
    const timeLabel = formatDesktopEventTime();
    setDesktopChatState((current) => {
      if (!current) return current;
      return {
        ...current,
        activeSession: {
          ...current.activeSession,
          messages: [
            ...current.activeSession.messages,
            {
              role: 'system',
              sender: 'Kordi',
              text,
              timeLabel,
              timestampMs: Date.now(),
            },
          ],
        },
      };
    });
  }, [setDesktopChatState]);

  const handleLocalSlashCommand = useCallback(async (rawText: string, scope: ComposerScope = 'chat') => {
    const text = rawText.trim();
    const command = text.split(/\s+/, 1)[0] ?? text;
    if (!isSharedLocalSlashCommand(command)) {
      return false;
    }

    const args = text.slice(command.length).trim();

    switch (command) {
      case '/new':
        await handleCreateChatSession();
        return true;
      case '/settings':
        setActiveNav('settings');
        return true;
      case '/login':
      case '/logout':
        setActiveNav('settings');
        setActiveSettingsSectionId('auth');
        return true;
      case '/session':
        setIsDetailPanelCollapsed(false);
        setActiveDetailTab('info');
        return true;
      case '/model': {
        if (args) {
          const match = chatModelOptions.find((option) => {
            const haystack = `${option.value} ${option.label} ${option.detail ?? ''}`.toLowerCase();
            return haystack.includes(args.toLowerCase());
          });
          if (match) {
            await selectComposerValue(scope, 'model', match.value);
            return true;
          }
        }
        setOpenComposerSelector({ scope, type: 'model' });
        return true;
      }
      case '/name':
        if (!desktopChatState?.activeSessionId) return true;
        if (args) {
          setDesktopSessionRenameDraft(args);
          await handleRenameDesktopSession(desktopChatState.activeSession.title);
        } else {
          setDesktopSessionRenameDraft(desktopChatState.activeSession.title);
          setIsEditingDesktopSessionTitle(true);
        }
        return true;
      case '/copy': {
        const lastAssistant = [...activeConvMessages].reverse().find((message) => message.role === 'owned-agent');
        if (!lastAssistant?.text?.trim()) {
          appendDesktopSystemMessage('No assistant response available to copy yet.');
          return true;
        }
        await navigator.clipboard.writeText(lastAssistant.text);
        appendDesktopSystemMessage('Copied the latest assistant response to your clipboard.');
        return true;
      }
      case '/help':
        appendDesktopSystemMessage(desktopSlashHelpText());
        return true;
      case '/hotkeys':
        appendDesktopSystemMessage(desktopHotkeyHelpText());
        return true;
      case '/reload':
        await Promise.all([refreshDesktopChat(desktopChatState?.activeSessionId), refreshDesktopAuth()]);
        appendDesktopSystemMessage('Reloaded desktop chat state, auth, and slash commands.');
        return true;
      case '/skill': {
        if (!desktopChatState?.activeSessionId) return true;
        const note = await runDesktopChatSkillCommand(desktopChatState.activeSessionId, text);
        await refreshDesktopChat(desktopChatState.activeSessionId);
        appendDesktopSystemMessage(note);
        return true;
      }
      default:
        appendDesktopSystemMessage(`${command} is not wired on desktop yet.`);
        return true;
    }
  }, [
    activeConvMessages,
    appendDesktopSystemMessage,
    chatModelOptions,
    desktopChatState?.activeSession.title,
    desktopChatState?.activeSessionId,
    handleCreateChatSession,
    handleRenameDesktopSession,
    refreshDesktopAuth,
    refreshDesktopChat,
    selectComposerValue,
    setActiveDetailTab,
    setActiveNav,
    setActiveSettingsSectionId,
    setDesktopSessionRenameDraft,
    setIsDetailPanelCollapsed,
    setIsEditingDesktopSessionTitle,
    setOpenComposerSelector,
  ]);

  const handleSendChatMessage = useCallback(async () => {
    if (!isNativeShell) return;
    const text = composerDrafts.chat.trim();
    if (!text && chatComposerAttachments.length === 0) return;

    if (activeConversationIsBridge) {
      if (chatComposerAttachments.length > 0) {
        setDesktopChatError('Bridge chats do not support attachments yet.');
        return;
      }
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        const nextState = await sendDesktopBridgeMessage(activeConvId, text);
        setDesktopBridgeState(nextState);
        setComposerDrafts((current) => ({ ...current, chat: '' }));
      } catch (error) {
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to send bridge message');
      } finally {
        setIsDesktopChatSending(false);
      }
      return;
    }

    const targetSessionId = activeConvId && !activeConvId.startsWith('bridge:')
      ? activeConvId
      : desktopChatState?.activeSessionId;

    if (!targetSessionId) return;
    if (desktopLiveTurn && !desktopLiveTurn.completed) return;

    if (chatComposerAttachments.length === 0 && (await handleLocalSlashCommand(text))) {
      setComposerDrafts((current) => ({ ...current, chat: '' }));
      setOpenComposerSelector(null);
      return;
    }

    try {
      shouldAutoFollowChatRef.current = true;
      setDesktopChatError(null);
      if (desktopChatState?.activeSessionId !== targetSessionId) {
        await refreshDesktopChat(targetSessionId);
      }

      const sentAt = formatDesktopEventTime();
      const attachmentPaths = chatComposerAttachments.map((item) => item.path);
      const displayText = attachmentSummaryText(text);
      setPendingUserChatMessage(null);
      setDesktopChatState((current) => (
        current ? appendOptimisticOutboundMessage(current, targetSessionId, displayText, sentAt) : current
      ));
      setComposerDrafts((current) => ({ ...current, chat: '' }));
      setChatComposerAttachments([]);
      resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
      const turn = await startDesktopChatMessage(targetSessionId, text, attachmentPaths);
      void watchDesktopLiveTurn(turn);
    } catch (error) {
      setPendingUserChatMessage(null);
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to send chat message');
    }
  }, [
    activeConversationIsBridge,
    activeConvId,
    attachmentSummaryText,
    chatComposerAttachments,
    composerDrafts.chat,
    desktopChatState?.activeSessionId,
    desktopLiveTurn,
    handleLocalSlashCommand,
    isNativeShell,
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

  const handleSendProjectMessage = useCallback(async () => {
    const text = composerDrafts.project.trim();
    if (!activeProjectSessionId || (!text && chatComposerAttachments.length === 0)) return;

    if (!isNativeShell) {
      shouldAutoFollowChatRef.current = true;
      const sentAt = formatDesktopEventTime();
      const displayText = attachmentSummaryText(text);

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
                            text: displayText,
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

    try {
      shouldAutoFollowChatRef.current = true;
      setDesktopChatError(null);
      const sentAt = formatDesktopEventTime();
      const attachmentPaths = chatComposerAttachments.map((item) => item.path);
      const displayText = attachmentSummaryText(text);
      setDesktopChatState((current) => {
        if (!current || current.activeSessionId !== activeProjectSessionId) return current;
        return appendOptimisticOutboundMessage(current, activeProjectSessionId, displayText, sentAt);
      });
      appendProjectDraft('');
      setChatComposerAttachments([]);
      resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]');
      const turn = await startDesktopChatMessage(activeProjectSessionId, text, attachmentPaths);
      void watchDesktopLiveTurn(turn);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to send project message');
    }
  }, [
    activeProjectId,
    activeProjectSessionId,
    appendProjectDraft,
    attachmentSummaryText,
    chatComposerAttachments,
    composerDrafts.project,
    desktopLiveTurn,
    isNativeShell,
    setChatComposerAttachments,
    setDesktopChatError,
    setDesktopChatState,
    setProjectWorkspaces,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
  ]);

  const handleStopDesktopChatTurn = useCallback(async () => {
    if (!desktopLiveTurn || desktopLiveTurn.completed) return;

    try {
      setDesktopChatError(null);
      const nextTurn = await cancelDesktopChatTurn(desktopLiveTurn.id);
      void watchDesktopLiveTurn(nextTurn);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to stop chat turn');
    }
  }, [desktopLiveTurn, setDesktopChatError, watchDesktopLiveTurn]);

  return {
    handleSendChatMessage,
    handleSendProjectMessage,
    handleStopDesktopChatTurn,
    acceptChatSlashCommand: appendChatDraft,
    acceptProjectSlashCommand: appendProjectDraft,
  };
}
