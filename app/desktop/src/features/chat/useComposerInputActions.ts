import { useCallback } from 'react';

import { normalizeSelectedProviderId } from '@/kordi-app/auth/model';
import { storeDesktopChatAttachment, updateDesktopChatSessionConfig } from '@/lib/desktop';

import {
  formatDesktopEventTime,
  formatThinkingSelectionLabel,
  parseModelSelection,
  resizeComposerTextarea,
} from './composerController.shared';
import type { ComposerScope, ComposerSelectorType } from '@/kordi-app/types';
import type {
  AttachmentItem,
  ComposerDraftState,
  ComposerSelectionState,
  ComposerSelectorState,
  MinimalModelOption,
  MinimalProviderOption,
  UseComposerControllerArgs,
} from './composerController.types';

type UseComposerInputActionsArgs = Pick<
  UseComposerControllerArgs,
  | 'isNativeShell'
  | 'activeProjectSessionId'
  | 'desktopChatState'
  | 'composerSelections'
  | 'setComposerSelections'
  | 'setComposerDrafts'
  | 'setOpenComposerSelector'
  | 'chatComposerAttachments'
  | 'setChatComposerAttachments'
  | 'chatModelOptions'
  | 'preferredModelValueForProvider'
  | 'resolveComposerProviderId'
  | 'handleSelectAuthChoice'
  | 'refreshDesktopChat'
  | 'setDesktopChatState'
  | 'setDesktopChatError'
  | 'shouldAutoFollowChatRef'
>;

function appendOptimisticSessionConfigMessage({
  current,
  targetSessionId,
  nextModelValue,
  nextThinkingValue,
  chatModelOptions,
}: {
  current: NonNullable<UseComposerControllerArgs['desktopChatState']>;
  targetSessionId: string;
  nextModelValue?: string;
  nextThinkingValue?: string;
  chatModelOptions: MinimalModelOption[];
}) {
  const selectedModelOption = nextModelValue
    ? chatModelOptions.find((option) => option.value === nextModelValue)
    : null;
  const parsedModel = nextModelValue ? parseModelSelection(nextModelValue) : null;
  const timeLabel = formatDesktopEventTime();
  const timestampMs = Date.now();
  const modelChanged = Boolean(nextModelValue && nextModelValue !== current.activeSession.model);
  const thinkingChanged = Boolean(nextThinkingValue && nextThinkingValue !== current.activeSession.thinking);
  const systemMessage = {
    role: 'system' as const,
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
}

function attachmentFormatLabel(name: string, mimeType?: string) {
  const extension = name.split('.').pop()?.trim();
  if (extension) {
    return extension.toUpperCase();
  }

  const subtype = mimeType?.split('/').pop()?.trim();
  if (subtype) {
    return subtype.toUpperCase();
  }

  return 'FILE';
}

function attachmentSummaryTextValue(text: string, attachments: AttachmentItem[]) {
  const trimmedText = text.trim();
  if (trimmedText.length > 0) {
    return text;
  }

  if (attachments.length === 0) {
    return text;
  }

  if (attachments.length === 1) {
    return `Attached ${attachments[0].name}`;
  }

  return `${attachments.length} attachments`;
}

export function useComposerInputActions({
  isNativeShell,
  activeProjectSessionId,
  desktopChatState,
  composerSelections,
  setComposerSelections,
  setComposerDrafts,
  setOpenComposerSelector,
  chatComposerAttachments,
  setChatComposerAttachments,
  chatModelOptions,
  preferredModelValueForProvider,
  resolveComposerProviderId,
  handleSelectAuthChoice,
  refreshDesktopChat,
  setDesktopChatState,
  setDesktopChatError,
  shouldAutoFollowChatRef,
}: UseComposerInputActionsArgs) {
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

    setComposerSelections((current: ComposerSelectionState) => ({
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
          setDesktopChatState((current) => {
            if (!current || current.activeSessionId !== targetSessionId) return current;
            return appendOptimisticSessionConfigMessage({
              current,
              targetSessionId,
              nextModelValue,
              nextThinkingValue,
              chatModelOptions,
            });
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
  }, [
    activeProjectSessionId,
    chatModelOptions,
    composerSelections,
    desktopChatState?.activeSessionId,
    isNativeShell,
    preferredModelValueForProvider,
    refreshDesktopChat,
    setComposerSelections,
    setDesktopChatError,
    setDesktopChatState,
    setOpenComposerSelector,
    shouldAutoFollowChatRef,
  ]);

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

    setOpenComposerSelector((current: ComposerSelectorState) => (current?.scope === scope && current.type === 'auth' ? null : current));
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
    setComposerDrafts((current: ComposerDraftState) => ({
      ...current,
      [scope]: value,
    }));

    target.style.height = '0px';
    target.style.height = `${Math.min(target.scrollHeight, 220)}px`;
  }, [setComposerDrafts]);

  const attachmentSummaryText = useCallback((text: string) => (
    attachmentSummaryTextValue(text, chatComposerAttachments)
  ), [chatComposerAttachments]);

  const saveDesktopAttachments = useCallback(async (files: File[]) => {
    if (!isNativeShell || files.length === 0) {
      return [] as AttachmentItem[];
    }

    const saved = await Promise.all(
      files.map(async (file) => {
        const data = Array.from(new Uint8Array(await file.arrayBuffer()));
        const path = await storeDesktopChatAttachment(file.name || 'attachment.bin', data);
        const mimeType = file.type || undefined;
        const kind = file.type.startsWith('image/') ? ('image' as const) : ('file' as const);
        return {
          id: `${file.name}-${path}`,
          name: file.name || 'attachment',
          path,
          kind,
          mimeType,
          formatLabel: attachmentFormatLabel(file.name || 'attachment', mimeType),
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
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
    setChatComposerAttachments((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed?.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((item) => item.id !== id);
    });
  }, [setChatComposerAttachments]);

  const setChatComposerText = useCallback((value: string) => {
    setComposerDrafts((current: ComposerDraftState) => ({ ...current, chat: value }));
    resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]', value);
  }, [setComposerDrafts]);

  const setProjectComposerText = useCallback((value: string) => {
    setComposerDrafts((current: ComposerDraftState) => ({ ...current, project: value }));
    resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]', value);
  }, [setComposerDrafts]);

  const acceptChatSlashCommand = useCallback((value: string) => {
    setChatComposerText(value);
  }, [setChatComposerText]);

  const acceptProjectSlashCommand = useCallback((value: string) => {
    setProjectComposerText(value);
  }, [setProjectComposerText]);

  return {
    toggleComposerSelector,
    selectComposerValue,
    selectComposerAuthChoice,
    selectComposerProviderChoice,
    updateComposerDraft,
    attachmentSummaryText,
    saveDesktopAttachments,
    removeChatComposerAttachment,
    setChatComposerText,
    setProjectComposerText,
    acceptChatSlashCommand,
    acceptProjectSlashCommand,
  };
}
