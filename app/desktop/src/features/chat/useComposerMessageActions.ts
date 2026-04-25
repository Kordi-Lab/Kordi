import { useCallback } from 'react';

import { BRIDGE_MESSAGE_DIRECTION_OUTBOUND } from '@/features/bridge/messages';
import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import { mergeDesktopBridgeState } from '@/features/bridge/useBridgeState';
import type { ComposerScope, DesktopBridgeState, DesktopChatState, Project } from '@/kordi-app/types';
import {
  cancelDesktopChatTurn,
  createDesktopBridgeOutreach,
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
import type { AttachmentItem, UseComposerControllerArgs } from './composerController.types';

type UseComposerMessageActionsArgs = Pick<
  UseComposerControllerArgs,
  | 'isNativeShell'
  | 'activeConversationIsBridge'
  | 'activeConvId'
  | 'activeConvMessages'
  | 'activeProjectId'
  | 'activeProjectSessionId'
  | 'desktopChatState'
  | 'desktopBridgeState'
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

function toOptimisticAttachments(attachments: AttachmentItem[]) {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    name: attachment.name,
    formatLabel: attachment.formatLabel,
    previewUrl: attachment.previewUrl,
  }));
}

function appendOptimisticOutboundMessage(
  current: DesktopChatState,
  targetSessionId: string,
  previewText: string,
  messageText: string,
  attachments: AttachmentItem[],
  sentAt: string,
) {
  const optimisticMessage = {
    role: 'user' as const,
    sender: 'You',
    text: messageText,
    attachments: toOptimisticAttachments(attachments),
    timeLabel: sentAt,
    timestampMs: Date.now(),
  };

  return {
    ...current,
    sessions: current.sessions.map((session) =>
      session.id === targetSessionId
        ? {
            ...session,
            subtitle: previewText,
            updatedAtLabel: sentAt,
            messageCount: session.messageCount + 1,
          }
        : session,
    ),
    activeSession:
      current.activeSession.id === targetSessionId
        ? {
            ...current.activeSession,
            subtitle: previewText,
            updatedAtLabel: sentAt,
            messageCount: current.activeSession.messageCount + 1,
            messages: [...current.activeSession.messages, optimisticMessage],
          }
        : current.activeSession,
  };
}

function appendOptimisticBridgeMessage(
  current: DesktopBridgeState | null,
  conversationId: string,
  text: string,
  sentAt: string,
  optimisticMessageId: string,
): DesktopBridgeState | null {
  if (!current) return current;

  const timestampMs = Date.now();
  const nextConversations = current.conversations.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    return {
      ...conversation,
      subtitle: text,
      updatedAtMs: timestampMs,
      updatedAtLabel: sentAt,
      awaitingReply: isBridgeAgentRuntime(conversation.peerRuntime),
      messages: [
        ...conversation.messages,
        {
          id: optimisticMessageId,
          direction: BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
          sender: 'You',
          text,
          timeLabel: sentAt,
          timestampMs,
          deliveryState: 'sending',
        },
      ],
    };
  }).sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    ...current,
    conversations: nextConversations,
  };
}

function markOptimisticBridgeMessageFailed(
  current: DesktopBridgeState | null,
  conversationId: string,
  optimisticMessageId: string,
): DesktopBridgeState | null {
  if (!current) return current;

  return {
    ...current,
    conversations: current.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      return {
        ...conversation,
        awaitingReply: false,
        messages: conversation.messages.map((message) => (
          message.id === optimisticMessageId
            ? { ...message, deliveryState: 'failed' }
            : message
        )),
      };
    }),
  };
}

function normalizeMentionLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function renderProjectContext(state: DesktopChatState | null) {
  const project = state?.activeSession.project;
  if (!project) return null;

  const lines = [
    `Project: ${project.name}`,
    project.sharedContext ? `Context: ${project.sharedContext}` : null,
    project.backgroundSystem ? `Standing instruction: ${project.backgroundSystem}` : null,
    project.sharedSources.length > 0
      ? `Shared sources: ${project.sharedSources.map((source) => [source.label, source.detail].filter(Boolean).join(' — ')).join('; ')}`
      : null,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join('\n') : null;
}

function mentionTextStartsWithLabel(text: string, label: string) {
  const normalizedText = normalizeMentionLabel(text);
  const normalizedLabel = normalizeMentionLabel(label);
  if (normalizedText === normalizedLabel) return true;
  if (!normalizedText.startsWith(normalizedLabel)) return false;
  const next = normalizedText.slice(normalizedLabel.length, normalizedLabel.length + 1);
  return !next || /[\s:;,.!?—-]/.test(next);
}

function resolveMentionedBridgeTarget(text: string, bridgeState: DesktopBridgeState | null) {
  if (!bridgeState) return null;
  const mentionMatches = Array.from(text.matchAll(/(^|\s)@/g));
  if (mentionMatches.length === 0) return null;

  const candidates = bridgeState.hosts.flatMap((host) => host.visiblePeers.flatMap((peer) => {
    const labels = [peer.displayName, peer.ownerName, peer.nodeId]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((label) => ({ label, normalized: normalizeMentionLabel(label) }));
    return labels.map((label) => ({ host, peer, label }));
  }));

  for (const mention of mentionMatches) {
    const mentionStart = (mention.index ?? 0) + mention[1].length;
    const rawAfterAt = text.slice(mentionStart + 1);
    const leadingWhitespace = rawAfterAt.length - rawAfterAt.trimStart().length;
    const afterAt = rawAfterAt.trimStart();
    if (!afterAt) continue;
    const match = candidates
      .filter((candidate) => mentionTextStartsWithLabel(afterAt, candidate.label.label))
      .sort((left, right) => right.label.normalized.length - left.label.normalized.length)[0];
    if (!match) continue;

    let mentionEnd = mentionStart + 1 + leadingWhitespace + match.label.label.length;
    if (/[:;,.!?—-]/.test(text[mentionEnd] ?? '')) {
      mentionEnd += 1;
    }
    const requestText = `${text.slice(0, mentionStart)}${text.slice(mentionEnd)}`.replace(/\s+/g, ' ').trim();
    if (!requestText) continue;

    return {
      host: match.host,
      peer: match.peer,
      targetKind: isBridgeAgentRuntime(match.peer.runtime) ? 'bridge-agent' as const : 'bridge-person' as const,
      requestText,
    };
  }

  return null;
}

function insertMentionIntoDraft(current: string, label: string) {
  const mention = `@${label}`;
  const match = /(^|\s)@([^\s@]*)$/.exec(current);
  if (match && typeof match.index === 'number') {
    return `${current.slice(0, match.index)}${match[1]}${mention} `;
  }
  if (!current.trim()) {
    return `${mention} `;
  }
  return `${mention} ${current}`;
}

export function useComposerMessageActions({
  isNativeShell,
  activeConversationIsBridge,
  activeConvId,
  activeConvMessages,
  activeProjectId,
  activeProjectSessionId,
  desktopChatState,
  desktopBridgeState,
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
      const sentAt = formatDesktopEventTime();
      const optimisticMessageId = `bridge-pending-${Date.now()}`;
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        setDesktopBridgeState((current) => appendOptimisticBridgeMessage(current, activeConvId, text, sentAt, optimisticMessageId));
        setComposerDrafts((current) => ({ ...current, chat: '' }));
        resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
        const nextState = await sendDesktopBridgeMessage(activeConvId, text);
        setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
      } catch (error) {
        setDesktopBridgeState((current) => markOptimisticBridgeMessageFailed(current, activeConvId, optimisticMessageId));
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
      resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
      setOpenComposerSelector(null);
      return;
    }

    const mentionedTarget = chatComposerAttachments.length === 0 ? resolveMentionedBridgeTarget(text, desktopBridgeState) : null;
    if (mentionedTarget) {
      try {
        shouldAutoFollowChatRef.current = true;
        setIsDesktopChatSending(true);
        setDesktopChatError(null);
        setComposerDrafts((current) => ({ ...current, chat: '' }));
        resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]');
        const nextState = await createDesktopBridgeOutreach({
          hostId: mentionedTarget.host.id,
          targetNodeId: mentionedTarget.peer.nodeId,
          targetKind: mentionedTarget.targetKind,
          requestText: mentionedTarget.requestText,
          contextText: renderProjectContext(desktopChatState),
          parentSessionId: targetSessionId,
          projectId: desktopChatState?.activeSession.project?.root,
          projectName: desktopChatState?.activeSession.project?.name,
        });
        setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
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
      if (desktopChatState?.activeSessionId !== targetSessionId) {
        await refreshDesktopChat(targetSessionId);
      }

      const sentAt = formatDesktopEventTime();
      const attachmentPaths = chatComposerAttachments.map((item) => item.path);
      const previewText = attachmentSummaryText(text);
      setPendingUserChatMessage(null);
      setDesktopChatState((current) => (
        current
          ? appendOptimisticOutboundMessage(current, targetSessionId, previewText, text, chatComposerAttachments, sentAt)
          : current
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
    appendDesktopSystemMessage,
    attachmentSummaryText,
    chatComposerAttachments,
    composerDrafts.chat,
    desktopBridgeState,
    desktopChatState,
    desktopLiveTurn,
    handleLocalSlashCommand,
    isNativeShell,
    refreshDesktopChat,
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
        const nextState = await createDesktopBridgeOutreach({
          hostId: mentionedTarget.host.id,
          targetNodeId: mentionedTarget.peer.nodeId,
          targetKind: mentionedTarget.targetKind,
          requestText: mentionedTarget.requestText,
          contextText: renderProjectContext(desktopChatState),
          parentSessionId: activeProjectSessionId,
          projectId: desktopChatState?.activeSession.project?.root,
          projectName: desktopChatState?.activeSession.project?.name,
        });
        setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
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
      setDesktopChatState((current) => {
        if (!current || current.activeSessionId !== activeProjectSessionId) return current;
        return appendOptimisticOutboundMessage(current, activeProjectSessionId, previewText, text, chatComposerAttachments, sentAt);
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
    appendDesktopSystemMessage,
    appendProjectDraft,
    attachmentSummaryText,
    chatComposerAttachments,
    composerDrafts.project,
    desktopBridgeState,
    desktopChatState,
    desktopLiveTurn,
    isNativeShell,
    setChatComposerAttachments,
    setDesktopBridgeState,
    setDesktopChatError,
    setDesktopChatState,
    setIsDesktopChatSending,
    setProjectWorkspaces,
    shouldAutoFollowChatRef,
    watchDesktopLiveTurn,
  ]);

  const acceptChatMentionTarget = useCallback((label: string) => {
    setComposerDrafts((current) => ({ ...current, chat: insertMentionIntoDraft(current.chat, label) }));
    resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]', insertMentionIntoDraft(composerDrafts.chat, label));
  }, [composerDrafts.chat, setComposerDrafts]);

  const acceptProjectMentionTarget = useCallback((label: string) => {
    setComposerDrafts((current) => ({ ...current, project: insertMentionIntoDraft(current.project, label) }));
    resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]', insertMentionIntoDraft(composerDrafts.project, label));
  }, [composerDrafts.project, setComposerDrafts]);

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
    acceptChatMentionTarget,
    acceptProjectMentionTarget,
  };
}
