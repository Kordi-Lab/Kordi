import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { normalizeSelectedProviderId } from '@/kordi-app/auth/model';
import type {
  ComposerScope,
  ComposerSelectorType,
  DesktopBridgeState,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  DetailTab,
  Message,
  NavId,
  Project,
} from '@/kordi-app/types';
import {
  cancelDesktopChatTurn,
  runDesktopChatSkillCommand,
  sendDesktopBridgeMessage,
  startDesktopChatMessage,
  storeDesktopChatAttachment,
  updateDesktopChatSessionConfig,
} from '@/lib/desktop';

type ComposerSelectionState = Record<ComposerScope, { mode: string; model: string; thinking: string }>;
type ComposerDraftState = Record<ComposerScope, string>;
type ComposerSelectorState = { scope: ComposerScope; type: ComposerSelectorType } | null;
type AttachmentItem = { id: string; name: string; path: string; kind: 'image' | 'file' };
type MinimalModelOption = {
  value: string;
  label: string;
  detail?: string | null;
  provider?: string | null;
  providerLabel?: string | null;
};
type MinimalProviderOption = { providerId: string; value: string };
type PendingUserMessage = { text: string; time: string } | null;

const SHARED_LOCAL_SLASH_COMMANDS = new Set([
  '/settings',
  '/model',
  '/export',
  '/import',
  '/copy',
  '/name',
  '/session',
  '/hotkeys',
  '/fork',
  '/tree',
  '/login',
  '/logout',
  '/new',
  '/compact',
  '/resume',
  '/reload',
  '/install',
  '/skill',
  '/update',
  '/image',
  '/help',
  '/quit',
  '/exit',
]);

const DESKTOP_HOTKEY_LINES = [
  'Desktop shortcuts',
  '',
  'Enter — send message',
  'Shift+Enter — newline',
  '↑/↓ — navigate slash commands',
  'Tab — accept slash command',
  'Esc — close slash command menu',
  '⌘/Ctrl+. — open settings',
].join('\n');

const DESKTOP_SLASH_HELP_LINES = [
  'Available commands:',
  '',
  '/name      Rename current session',
  '/session   Show session info tab',
  '/new       Start a new session',
  '/reload    Refresh runtime-backed desktop state',
  '/tree      Navigate session tree',
  '/fork      Fork from a previous message',
  '/skill     Manage loaded skills',
  '',
  'Skill, prompt, and extension slash commands also appear in the command menu.',
].join('\n');

function formatDesktopEventTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatThinkingSelectionLabel(value: string) {
  switch (value) {
    case 'off':
      return 'Off';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra High';
    default:
      return value;
  }
}

function parseModelSelection(value: string) {
  const [provider, ...modelParts] = value.split('/');
  return {
    provider: provider?.trim() || '',
    modelId: modelParts.join('/').trim() || value,
  };
}

type UseComposerControllerArgs = {
  isNativeShell: boolean;
  activeConversationIsBridge: boolean;
  activeConvId: string;
  activeConvMessages: Message[];
  activeProjectId: string;
  activeProjectSessionId: string;
  desktopChatState: DesktopChatState | null;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  composerSelections: ComposerSelectionState;
  setComposerSelections: Dispatch<SetStateAction<ComposerSelectionState>>;
  composerDrafts: ComposerDraftState;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setProjectWorkspaces: Dispatch<SetStateAction<Project[]>>;
  setOpenComposerSelector: Dispatch<SetStateAction<ComposerSelectorState>>;
  chatComposerAttachments: AttachmentItem[];
  setChatComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  chatModelOptions: MinimalModelOption[];
  preferredModelValueForProvider: (providerId: string) => string | null;
  resolveComposerProviderId: (scope: ComposerScope, modelLabel: string) => string;
  handleSelectAuthChoice: (providerId: string, choice: string) => Promise<void>;
  refreshDesktopAuth: () => Promise<unknown>;
  refreshDesktopChat: (activeSessionId?: string) => Promise<unknown>;
  handleCreateChatSession: () => Promise<void>;
  handleRenameDesktopSession: (fallbackName?: string) => Promise<void>;
  setActiveNav: (nav: NavId) => void;
  setActiveSettingsSectionId: (sectionId: string) => void;
  setActiveDetailTab: (tab: DetailTab) => void;
  setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  setDesktopChatState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  setIsDesktopChatSending: Dispatch<SetStateAction<boolean>>;
  setPendingUserChatMessage: Dispatch<SetStateAction<PendingUserMessage>>;
  setDesktopBridgeState: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  watchDesktopLiveTurn: (turn: DesktopChatTurnSnapshot | string) => Promise<void>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
};

export function useComposerController({
  isNativeShell,
  activeConversationIsBridge,
  activeConvId,
  activeConvMessages,
  activeProjectId,
  activeProjectSessionId,
  desktopChatState,
  desktopLiveTurn,
  composerSelections,
  setComposerSelections,
  composerDrafts,
  setComposerDrafts,
  setProjectWorkspaces,
  setOpenComposerSelector,
  chatComposerAttachments,
  setChatComposerAttachments,
  chatModelOptions,
  preferredModelValueForProvider,
  resolveComposerProviderId,
  handleSelectAuthChoice,
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
}: UseComposerControllerArgs) {
  const toggleComposerSelector = useCallback((scope: ComposerScope, type: ComposerSelectorType) => {
    setOpenComposerSelector((current) => (current?.scope === scope && current.type === type ? null : { scope, type }));
  }, [setOpenComposerSelector]);

  const selectComposerValue = useCallback(async (scope: ComposerScope, type: ComposerSelectorType, value: string) => {
    const resolvedModelValue = type === 'provider'
      ? preferredModelValueForProvider(value)
      : type === 'model'
        ? value
        : null;
    const nextModelValue = resolvedModelValue ?? (type === 'model' ? value : undefined);
    const nextThinkingValue = type === 'thinking' ? value : undefined;
    const currentSelection = composerSelections[scope];
    const modelChanged = Boolean(nextModelValue && nextModelValue !== currentSelection.model);
    const thinkingChanged = Boolean(nextThinkingValue && nextThinkingValue !== currentSelection.thinking);

    setComposerSelections((current) => ({
      ...current,
      [scope]: {
        ...current[scope],
        ...(type === 'provider'
          ? (resolvedModelValue ? { model: resolvedModelValue } : {})
          : type === 'model'
            ? { model: value }
            : type === 'thinking'
              ? { thinking: value }
              : { [type]: value }),
      },
    }));
    setOpenComposerSelector(null);

    const targetSessionId = scope === 'project' ? activeProjectSessionId : desktopChatState?.activeSessionId;
    if (isNativeShell && targetSessionId) {
      try {
        setDesktopChatError(null);

        if ((modelChanged || thinkingChanged) && desktopChatState?.activeSessionId === targetSessionId) {
          shouldAutoFollowChatRef.current = true;
          const timeLabel = formatDesktopEventTime();
          const timestampMs = Date.now();

          setDesktopChatState((current) => {
            if (!current || current.activeSessionId !== targetSessionId) return current;

            const selectedModelOption = nextModelValue
              ? chatModelOptions.find((option) => option.value === nextModelValue)
              : null;
            const parsedModel = nextModelValue ? parseModelSelection(nextModelValue) : null;
            const systemMessage = {
              role: 'system',
              text: modelChanged
                ? `Switched model to ${nextModelValue}`
                : `Thinking set to ${formatThinkingSelectionLabel(nextThinkingValue ?? current.activeSession.thinking)}`,
              detail: modelChanged ? 'Model updated' : 'Thinking updated',
              timeLabel,
              timestampMs,
            };

            return {
              ...current,
              sessions: current.sessions.map((session) => (
                session.id === targetSessionId
                  ? {
                      ...session,
                      updatedAtLabel: timeLabel,
                      messageCount: session.messageCount + 1,
                    }
                  : session
              )),
              activeSession: {
                ...current.activeSession,
                provider: modelChanged
                  ? (selectedModelOption?.provider ?? parsedModel?.provider ?? current.activeSession.provider)
                  : current.activeSession.provider,
                providerLabel: modelChanged
                  ? (selectedModelOption?.providerLabel ?? current.activeSession.providerLabel)
                  : current.activeSession.providerLabel,
                model: modelChanged
                  ? (selectedModelOption?.label ?? parsedModel?.modelId ?? current.activeSession.model)
                  : current.activeSession.model,
                modelLabel: modelChanged
                  ? (selectedModelOption?.label ?? parsedModel?.modelId ?? current.activeSession.modelLabel)
                  : current.activeSession.modelLabel,
                thinking: thinkingChanged
                  ? (nextThinkingValue ?? current.activeSession.thinking)
                  : current.activeSession.thinking,
                thinkingLabel: thinkingChanged
                  ? formatThinkingSelectionLabel(nextThinkingValue ?? current.activeSession.thinking)
                  : current.activeSession.thinkingLabel,
                updatedAtLabel: timeLabel,
                messageCount: current.activeSession.messageCount + 1,
                messages: [
                  ...current.activeSession.messages,
                  systemMessage,
                ],
              },
            };
          });
        }

        const nextState = await updateDesktopChatSessionConfig(
          targetSessionId,
          nextModelValue,
          nextThinkingValue,
        );
        setDesktopChatState(nextState);
      } catch (error) {
        await refreshDesktopChat(targetSessionId);
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to update session');
      }
    }
  }, [activeProjectSessionId, chatModelOptions, composerSelections, desktopChatState?.activeSessionId, isNativeShell, preferredModelValueForProvider, refreshDesktopChat, setComposerSelections, setDesktopChatError, setDesktopChatState, setOpenComposerSelector, shouldAutoFollowChatRef]);

  const selectComposerAuthChoice = useCallback(async (scope: ComposerScope, providerId: string, choice: string) => {
    await handleSelectAuthChoice(providerId, choice);

    const currentProviderId = resolveComposerProviderId(scope, composerSelections[scope].model);
    const normalizedProviderId = normalizeSelectedProviderId(providerId) ?? providerId;
    if (normalizedProviderId !== currentProviderId) {
      const nextModelValue = desktopChatState?.modelOptions.find((option) => option.provider === normalizedProviderId)?.value;
      if (nextModelValue) {
        await selectComposerValue(scope, 'model', nextModelValue);
        return;
      }
    }

    setOpenComposerSelector((current) => (current?.scope === scope && current.type === 'auth' ? null : current));
  }, [composerSelections, desktopChatState?.modelOptions, handleSelectAuthChoice, resolveComposerProviderId, selectComposerValue, setOpenComposerSelector]);

  const selectComposerProviderChoice = useCallback(async (scope: ComposerScope, option: MinimalProviderOption) => {
    const normalizedProviderId = normalizeSelectedProviderId(option.providerId) ?? option.providerId;
    const choice = option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;

    if (choice) {
      await handleSelectAuthChoice(option.providerId, choice);
    }

    await selectComposerValue(scope, 'provider', normalizedProviderId);
  }, [handleSelectAuthChoice, selectComposerValue]);

  const updateComposerDraft = useCallback((scope: ComposerScope, value: string, target: HTMLTextAreaElement) => {
    setComposerDrafts((current) => ({
      ...current,
      [scope]: value,
    }));

    target.style.height = '0px';
    target.style.height = `${Math.min(target.scrollHeight, 220)}px`;
  }, [setComposerDrafts]);

  const attachmentSummaryText = useCallback((text: string) => {
    if (chatComposerAttachments.length === 0) return text;
    const summary = chatComposerAttachments.map((item) => item.name).join(', ');
    return text.trim().length > 0 ? `${text}\n\nAttached: ${summary}` : `Attached: ${summary}`;
  }, [chatComposerAttachments]);

  const saveDesktopAttachments = useCallback(async (files: File[]) => {
    if (!isNativeShell || files.length === 0) {
      return [] as AttachmentItem[];
    }

    const saved = await Promise.all(
      files.map(async (file) => {
        const data = Array.from(new Uint8Array(await file.arrayBuffer()));
        const path = await storeDesktopChatAttachment(file.name || 'attachment.bin', data);
        return {
          id: `${file.name}-${path}`,
          name: file.name || 'attachment',
          path,
          kind: file.type.startsWith('image/') ? ('image' as const) : ('file' as const),
        };
      }),
    );

    setChatComposerAttachments((current) => {
      const seen = new Set(current.map((item) => item.path));
      return [...current, ...saved.filter((item) => !seen.has(item.path))];
    });
    return saved;
  }, [isNativeShell, setChatComposerAttachments]);

  const removeChatComposerAttachment = useCallback((id: string) => {
    setChatComposerAttachments((current) => current.filter((item) => item.id !== id));
  }, [setChatComposerAttachments]);

  const setChatComposerText = useCallback((value: string) => {
    setComposerDrafts((current) => ({ ...current, chat: value }));
    window.requestAnimationFrame(() => {
      const textarea = document.querySelector('textarea[placeholder="Message a person, an agent, or delegate a task…"]') as HTMLTextAreaElement | null;
      if (!textarea) return;
      textarea.value = value;
      textarea.style.height = '0px';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
    });
  }, [setComposerDrafts]);

  const setProjectComposerText = useCallback((value: string) => {
    setComposerDrafts((current) => ({ ...current, project: value }));
    window.requestAnimationFrame(() => {
      const textarea = document.querySelector('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]') as HTMLTextAreaElement | null;
      if (!textarea) return;
      textarea.value = value;
      textarea.style.height = '0px';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
    });
  }, [setComposerDrafts]);

  const appendDesktopSystemMessage = useCallback((text: string) => {
    const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

  const acceptChatSlashCommand = useCallback((value: string) => {
    setChatComposerText(value);
  }, [setChatComposerText]);

  const acceptProjectSlashCommand = useCallback((value: string) => {
    setProjectComposerText(value);
  }, [setProjectComposerText]);

  const handleLocalSlashCommand = useCallback(async (rawText: string, scope: ComposerScope = 'chat') => {
    const text = rawText.trim();
    const command = text.split(/\s+/, 1)[0] ?? text;
    if (!SHARED_LOCAL_SLASH_COMMANDS.has(command)) {
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
        appendDesktopSystemMessage(DESKTOP_SLASH_HELP_LINES);
        return true;
      case '/hotkeys':
        appendDesktopSystemMessage(DESKTOP_HOTKEY_LINES);
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
  }, [activeConvMessages, appendDesktopSystemMessage, chatModelOptions, desktopChatState?.activeSession.title, desktopChatState?.activeSessionId, handleCreateChatSession, handleRenameDesktopSession, refreshDesktopAuth, refreshDesktopChat, selectComposerValue, setActiveDetailTab, setActiveNav, setActiveSettingsSectionId, setDesktopSessionRenameDraft, setIsDetailPanelCollapsed, setIsEditingDesktopSessionTitle, setOpenComposerSelector]);

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

    if (!desktopChatState?.activeSessionId) return;
    if (desktopLiveTurn && !desktopLiveTurn.completed) return;

    if (chatComposerAttachments.length === 0 && (await handleLocalSlashCommand(text))) {
      setComposerDrafts((current) => ({ ...current, chat: '' }));
      setOpenComposerSelector(null);
      return;
    }

    try {
      shouldAutoFollowChatRef.current = true;
      setDesktopChatError(null);
      const sentAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const attachmentPaths = chatComposerAttachments.map((item) => item.path);
      const displayText = attachmentSummaryText(text);
      setPendingUserChatMessage(null);
      setDesktopChatState((current) => {
        if (!current || current.activeSessionId !== desktopChatState.activeSessionId) return current;
        return {
          ...current,
          sessions: current.sessions.map((session) =>
            session.id === current.activeSessionId
              ? {
                  ...session,
                  subtitle: displayText,
                  updatedAtLabel: sentAt,
                  messageCount: session.messageCount + 1,
                }
              : session,
          ),
          activeSession: {
            ...current.activeSession,
            subtitle: displayText,
            updatedAtLabel: sentAt,
            messageCount: current.activeSession.messageCount + 1,
            messages: [
              ...current.activeSession.messages,
              {
                role: 'user',
                sender: 'You',
                text: displayText,
                timeLabel: sentAt,
                timestampMs: Date.now(),
              },
            ],
          },
        };
      });
      setComposerDrafts((current) => ({ ...current, chat: '' }));
      setChatComposerAttachments([]);
      requestAnimationFrame(() => {
        const textarea = document.querySelector('textarea[placeholder="Message a person, an agent, or delegate a task…"]') as HTMLTextAreaElement | null;
        if (textarea) {
          textarea.style.height = '0px';
          textarea.style.height = '24px';
        }
      });
      const turn = await startDesktopChatMessage(desktopChatState.activeSessionId, text, attachmentPaths);
      void watchDesktopLiveTurn(turn);
    } catch (error) {
      setPendingUserChatMessage(null);
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to send chat message');
    }
  }, [activeConversationIsBridge, activeConvId, attachmentSummaryText, chatComposerAttachments, composerDrafts.chat, desktopChatState?.activeSessionId, desktopLiveTurn, handleLocalSlashCommand, isNativeShell, setChatComposerAttachments, setComposerDrafts, setDesktopBridgeState, setDesktopChatError, setDesktopChatState, setIsDesktopChatSending, setOpenComposerSelector, setPendingUserChatMessage, shouldAutoFollowChatRef, watchDesktopLiveTurn]);

  const handleSendProjectMessage = useCallback(async () => {
    const text = composerDrafts.project.trim();
    if (!activeProjectSessionId || (!text && chatComposerAttachments.length === 0)) return;

    if (!isNativeShell) {
      shouldAutoFollowChatRef.current = true;
      const sentAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const displayText = attachmentSummaryText(text);

      setProjectWorkspaces((current) =>
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
      setComposerDrafts((current) => ({ ...current, project: '' }));
      setChatComposerAttachments([]);
      return;
    }

    if (desktopLiveTurn && !desktopLiveTurn.completed) return;

    try {
      shouldAutoFollowChatRef.current = true;
      setDesktopChatError(null);
      const sentAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const attachmentPaths = chatComposerAttachments.map((item) => item.path);
      const displayText = attachmentSummaryText(text);
      setDesktopChatState((current) => {
        if (!current || current.activeSessionId !== activeProjectSessionId) return current;
        return {
          ...current,
          sessions: current.sessions.map((session) =>
            session.id === activeProjectSessionId
              ? {
                  ...session,
                  subtitle: displayText,
                  updatedAtLabel: sentAt,
                  messageCount: session.messageCount + 1,
                }
              : session,
          ),
          activeSession: {
            ...current.activeSession,
            subtitle: displayText,
            updatedAtLabel: sentAt,
            messageCount: current.activeSession.messageCount + 1,
            messages: [
              ...current.activeSession.messages,
              {
                role: 'user',
                sender: 'You',
                text: displayText,
                timeLabel: sentAt,
                timestampMs: Date.now(),
              },
            ],
          },
        };
      });
      setComposerDrafts((current) => ({ ...current, project: '' }));
      setChatComposerAttachments([]);
      requestAnimationFrame(() => {
        const textarea = document.querySelector('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]') as HTMLTextAreaElement | null;
        if (textarea) {
          textarea.style.height = '0px';
          textarea.style.height = '24px';
        }
      });
      const turn = await startDesktopChatMessage(activeProjectSessionId, text, attachmentPaths);
      void watchDesktopLiveTurn(turn);
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to send project message');
    }
  }, [activeProjectId, activeProjectSessionId, attachmentSummaryText, chatComposerAttachments, composerDrafts.project, desktopLiveTurn, isNativeShell, setChatComposerAttachments, setComposerDrafts, setDesktopChatError, setDesktopChatState, setIsDesktopChatSending, setProjectWorkspaces, shouldAutoFollowChatRef, watchDesktopLiveTurn]);

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
    toggleComposerSelector,
    selectComposerValue,
    selectComposerAuthChoice,
    selectComposerProviderChoice,
    updateComposerDraft,
    saveDesktopAttachments,
    removeChatComposerAttachment,
    setChatComposerText,
    setProjectComposerText,
    acceptChatSlashCommand,
    acceptProjectSlashCommand,
    handleSendChatMessage,
    handleSendProjectMessage,
    handleStopDesktopChatTurn,
  };
}
