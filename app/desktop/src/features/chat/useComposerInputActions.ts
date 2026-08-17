import { useCallback } from 'react';

import { isLegacyCanonicalCollaborationSessionId, isCanonicalCloudSessionId } from '@/features/canonical/sessionResolver';
import { isLocalProvider, normalizeSelectedProviderId } from '@/kordi-app/auth/model';
import { fallbackComposerThinkingValue } from '@/kordi-app/components';
import { storeDesktopChatAttachmentPath, updateDesktopChatSessionConfig } from '@/lib/desktop';

import {
  composerAttachmentItemFromFile,
  composerAttachmentItemFromStoredPath,
  composerAttachmentKindFromName,
  composerAttachmentNameFromPath,
  friendlyAttachmentName,
  updatedComposerAttachmentMetadata,
} from './composerAttachments';
export { composerAttachmentItemFromStoredPath } from './composerAttachments';
import { updateScopeDraft } from './composerDrafts';
import { appendOptimisticSessionConfigMessage } from './composerSessionConfigState';

import { isLocalDraftChatConversationId, isProjectDraftSessionId } from './draftSessions';

import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  focusComposerTextarea,
  resizeComposerTextarea,
} from './composerController.shared';
import type { ComposerScope, ComposerSelectorType } from '@/kordi-app/types';
import type {
  AttachmentItem,
  ComposerConfigTargetOverride,
  ComposerDraftState,
  ComposerSelection,
  ComposerSelectionState,
  ComposerSelectorState,
  MinimalProviderOption,
  SaveDesktopAttachmentOptions,
  UseComposerInputActionsArgs,
} from './composerController.types';

export function desktopChatStateAfterConfigUpdate<T>(current: T, next: T, isolated: boolean): T {
  return isolated ? current : next;
}

export function composerConfigTargetSessionId({
  scope,
  activeConversationUsesCollaboration = false,
  activeConvId,
  activeConvCanonicalSessionId,
  activeProjectSessionId,
  desktopActiveSessionId,
}: {
  scope: ComposerScope;
  activeConversationUsesCollaboration?: boolean;
  activeConvId: string;
  activeConvCanonicalSessionId?: string | null;
  activeProjectSessionId: string;
  desktopActiveSessionId?: string | null;
}) {
  if (scope === 'project') return activeProjectSessionId;
  if (activeConversationUsesCollaboration) return null;
  if (isLocalDraftChatConversationId(activeConvId)) return activeConvId;

  const sessionId = activeConvCanonicalSessionId?.trim() || activeConvId.trim();
  if (!sessionId) return desktopActiveSessionId ?? null;
  if (activeConvId.startsWith('bridge:') || isLegacyCanonicalCollaborationSessionId(sessionId) || isCanonicalCloudSessionId(sessionId)) {
    return null;
  }
  return activeConvId;
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
  environment,
  conversation,
  project,
  runtime,
  draft,
  authNavigation,
  messageRuntime,
}: UseComposerInputActionsArgs) {
  const { isNativeShell } = environment;
  const {
    activeConversationUsesCollaboration,
    activeConvId,
    activeConvCanonicalSessionId,
  } = conversation;
  const { activeProjectSessionId } = project;
  const { desktopChatState } = runtime;
  const {
    composerSelections,
    setComposerSelections,
    setComposerDrafts,
    setOpenComposerSelector,
    chatComposerAttachments,
    setChatComposerAttachments,
    chatModelOptions,
    preferredModelValueForProvider,
    resolveComposerProviderId,
  } = draft;
  const { handleSelectAuthChoice, refreshDesktopChat } = authNavigation;
  const {
    setDesktopChatState,
    setDesktopChatError,
    shouldAutoFollowChatRef,
    publishCloudAgentRuntimeRouteChange,
  } = messageRuntime;
  const toggleComposerSelector = useCallback((scope: ComposerScope, type: ComposerSelectorType) => {
    setOpenComposerSelector((current) => (current?.scope === scope && current.type === type ? null : { scope, type }));
  }, [setOpenComposerSelector]);

  const selectComposerValue = useCallback(async (scope: ComposerScope, type: ComposerSelectorType, value: string, configTargetOverride?: ComposerConfigTargetOverride) => {
    const isolatedTarget = typeof configTargetOverride === 'object' && configTargetOverride !== null
      ? configTargetOverride
      : null;
    const resolvedModelValue = type === 'provider'
      ? preferredModelValueForProvider(value)
      : type === 'model'
        ? value
        : null;
    const nextModelValue = resolvedModelValue ?? (type === 'model' ? value : undefined);
    const currentSelection = isolatedTarget?.selection ?? composerSelections[scope];
    const modelThinkingLevels = nextModelValue
      ? chatModelOptions.find((option) => option.value === nextModelValue)?.thinkingLevels ?? []
      : [];
    const nextModelThinkingValue = nextModelValue
      ? fallbackComposerThinkingValue(modelThinkingLevels, currentSelection.thinking)
      : undefined;
    const nextThinkingValue = type === 'thinking' ? value : nextModelThinkingValue;
    const modelChanged = Boolean(nextModelValue && nextModelValue !== currentSelection.model);
    const thinkingChanged = Boolean(nextThinkingValue && nextThinkingValue !== currentSelection.thinking);
    let nextSelection: ComposerSelection = currentSelection;
    if (type === 'provider' && resolvedModelValue) {
      nextSelection = {
        ...currentSelection,
        model: resolvedModelValue,
        ...(nextModelThinkingValue ? { thinking: nextModelThinkingValue } : {}),
      };
    } else if (type === 'model') {
      nextSelection = {
        ...currentSelection,
        model: value,
        ...(nextModelThinkingValue ? { thinking: nextModelThinkingValue } : {}),
      };
    } else if (type === 'thinking') {
      nextSelection = { ...currentSelection, thinking: value };
    } else if (type === 'mode') {
      nextSelection = { ...currentSelection, mode: value };
    }

    if (isolatedTarget) {
      isolatedTarget.onSelectionChange(nextSelection);
    } else {
      setComposerSelections((current: ComposerSelectionState) => ({
        ...current,
        [scope]: nextSelection,
      }));
    }
    setOpenComposerSelector(null);
    if (scope === 'chat') {
      focusComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
    }

    const overrideSessionId = typeof configTargetOverride === 'string'
      ? configTargetOverride
      : isolatedTarget?.sessionId;
    const cloudRuntimeSessionId = activeConvCanonicalSessionId?.trim()
      || activeConvId.trim();
    if (
      isNativeShell
      && scope === 'chat'
      && activeConversationUsesCollaboration
      && !isolatedTarget
      && (modelChanged || thinkingChanged)
      && nextSelection.model
      && cloudRuntimeSessionId
      && publishCloudAgentRuntimeRouteChange
    ) {
      try {
        setDesktopChatError(null);
        await publishCloudAgentRuntimeRouteChange({
          sessionId: cloudRuntimeSessionId,
          model: nextSelection.model,
          thinking: nextThinkingValue ?? nextSelection.thinking,
        });
      } catch (error) {
        setComposerSelections((current: ComposerSelectionState) => ({
          ...current,
          [scope]: current[scope].model === nextSelection.model
            ? currentSelection
            : current[scope],
        }));
        setDesktopChatError(
          error instanceof Error
            ? error.message
            : 'Unable to synchronize the session model',
        );
      }
      return;
    }
    const targetSessionId = overrideSessionId?.trim() || composerConfigTargetSessionId({
      scope,
      activeConversationUsesCollaboration,
      activeConvId,
      activeConvCanonicalSessionId,
      activeProjectSessionId,
      desktopActiveSessionId: desktopChatState?.activeSessionId,
    });
    if (isNativeShell && targetSessionId && !isProjectDraftSessionId(targetSessionId)) {
      try {
        setDesktopChatError(null);

        if (!isolatedTarget && (modelChanged || thinkingChanged) && desktopChatState?.activeSessionId === targetSessionId) {
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
        if (isolatedTarget) {
          const matchingModelValue = chatModelOptions.find((option) => (
            option.provider === nextState.activeSession.provider
            && option.label === nextState.activeSession.model
          ))?.value ?? `${nextState.activeSession.provider}/${nextState.activeSession.model}`;
          isolatedTarget.onSelectionChange({
            ...nextSelection,
            model: matchingModelValue,
            thinking: nextState.activeSession.thinking,
          });
        }
        setDesktopChatState((current) => (
          desktopChatStateAfterConfigUpdate(current, nextState, Boolean(isolatedTarget))
        ));
      } catch (error) {
        if (isolatedTarget) {
          isolatedTarget.onSelectionChange(currentSelection);
        } else {
          await refreshDesktopChat(targetSessionId);
        }
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to update session');
      }
    }
  }, [
    activeConvId,
    activeConvCanonicalSessionId,
    activeConversationUsesCollaboration,
    activeProjectSessionId,
    chatModelOptions,
    composerSelections,
    desktopChatState?.activeSessionId,
    isNativeShell,
    preferredModelValueForProvider,
    publishCloudAgentRuntimeRouteChange,
    refreshDesktopChat,
    setComposerSelections,
    setDesktopChatError,
    setDesktopChatState,
    setOpenComposerSelector,
    shouldAutoFollowChatRef,
  ]);

  const selectComposerAuthChoice = useCallback(async (scope: ComposerScope, providerId: string, choice: string, configTargetOverride?: ComposerConfigTargetOverride) => {
    await handleSelectAuthChoice(providerId, choice);

    const isolatedTarget = typeof configTargetOverride === 'object' && configTargetOverride !== null
      ? configTargetOverride
      : null;
    const currentSelection = isolatedTarget?.selection ?? composerSelections[scope];
    const currentProviderId = resolveComposerProviderId(scope, currentSelection.model);
    const normalizedProviderId = normalizeSelectedProviderId(providerId) ?? providerId;
    const nextModelValue = preferredModelValueForProvider(providerId) ?? preferredModelValueForProvider(normalizedProviderId);
    const currentModelValue = currentSelection.model.toLowerCase();
    const shouldSwitchModelForAuth = normalizedProviderId !== currentProviderId
      || providerId === 'openai-codex'
      || (providerId === 'openai' && currentProviderId === 'openai' && currentModelValue.includes('gpt-5.5'));
    if (shouldSwitchModelForAuth && nextModelValue && nextModelValue !== currentSelection.model) {
      await selectComposerValue(scope, 'model', nextModelValue, configTargetOverride);
      return;
    }

    setOpenComposerSelector((current: ComposerSelectorState) => (current?.scope === scope && current.type === 'auth' ? null : current));
  }, [composerSelections, handleSelectAuthChoice, preferredModelValueForProvider, resolveComposerProviderId, selectComposerValue, setOpenComposerSelector]);

  const selectComposerProviderChoice = useCallback(async (scope: ComposerScope, option: MinimalProviderOption, configTargetOverride?: ComposerConfigTargetOverride) => {
    const normalizedProviderId = normalizeSelectedProviderId(option.providerId) ?? option.providerId;
    const choice = option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;

    if (choice) {
      await handleSelectAuthChoice(option.providerId, choice);
    }

    const nextModelValue = preferredModelValueForProvider(option.providerId) ?? preferredModelValueForProvider(normalizedProviderId);
    if (nextModelValue) {
      await selectComposerValue(scope, 'model', nextModelValue, configTargetOverride);
      return;
    }

    if (isLocalProvider(normalizedProviderId)) {
      setDesktopChatError('Run and save a local model from Authentication before selecting this provider.');
      setOpenComposerSelector(null);
      return;
    }

    await selectComposerValue(scope, 'provider', normalizedProviderId, configTargetOverride);
  }, [handleSelectAuthChoice, preferredModelValueForProvider, selectComposerValue, setDesktopChatError, setOpenComposerSelector]);

  const updateComposerDraft = useCallback((scope: ComposerScope, value: string, target: HTMLTextAreaElement) => {
    const sessionId = scope === 'chat' ? activeConvId : activeProjectSessionId;
    setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, scope, sessionId ?? '', value));

    target.style.height = '0px';
    target.style.height = `${Math.min(target.scrollHeight, 220)}px`;
  }, [activeConvId, activeProjectSessionId, setComposerDrafts]);

  const attachmentSummaryText = useCallback((text: string, attachments = chatComposerAttachments) => (
    attachmentSummaryTextValue(text, attachments)
  ), [chatComposerAttachments]);

  const saveDesktopAttachments = useCallback(async (
    files: File[],
    options: SaveDesktopAttachmentOptions = {},
  ) => {
    if (!isNativeShell || files.length === 0) {
      return [] as AttachmentItem[];
    }

    try {
      setDesktopChatError(null);
      const saved = await Promise.all(
        files.map((file) => composerAttachmentItemFromFile(file, options)),
      );

      setChatComposerAttachments((current) => {
        const seen = new Set(current.map((item) => item.path));
        return [...current, ...saved.filter((item) => !seen.has(item.path))];
      });
      return saved;
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to attach file');
      return [] as AttachmentItem[];
    }
  }, [isNativeShell, setChatComposerAttachments, setDesktopChatError]);

  const saveDesktopAttachmentPaths = useCallback(async (paths: string[]) => {
    if (!isNativeShell || paths.length === 0) {
      return [] as AttachmentItem[];
    }

    try {
      setDesktopChatError(null);
      const saved = await Promise.all(paths.map(async (sourcePath) => {
        const rawName = composerAttachmentNameFromPath(sourcePath);
        const kind = composerAttachmentKindFromName(rawName);
        const displayName = friendlyAttachmentName(rawName, kind);
        const stored = await storeDesktopChatAttachmentPath(sourcePath, displayName);
        return composerAttachmentItemFromStoredPath({ sourcePath, stored, displayName });
      }));

      setChatComposerAttachments((current) => {
        const seen = new Set(current.map((item) => item.path));
        return [...current, ...saved.filter((item) => !seen.has(item.path))];
      });
      return saved;
    } catch (error) {
      setDesktopChatError(error instanceof Error ? error.message : 'Unable to attach file');
      return [] as AttachmentItem[];
    }
  }, [isNativeShell, setChatComposerAttachments, setDesktopChatError]);

  const removeChatComposerAttachment = useCallback((id: string) => {
    setChatComposerAttachments((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed?.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((item) => item.id !== id);
    });
  }, [setChatComposerAttachments]);

  const updateChatComposerAttachment = useCallback((
    id: string,
    update: Pick<AttachmentItem, 'subtype' | 'altText' | 'memeRightsConfirmed'>,
  ) => {
    setChatComposerAttachments((current) => current.map((attachment) => (
      attachment.id === id ? updatedComposerAttachmentMetadata(attachment, update) : attachment
    )));
  }, [setChatComposerAttachments]);

  const setChatComposerText = useCallback((value: string) => {
    setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, value));
    resizeComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR, value);
  }, [activeConvId, setComposerDrafts]);

  const setProjectComposerText = useCallback((value: string) => {
    setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'project', activeProjectSessionId, value));
    resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]', value);
  }, [activeProjectSessionId, setComposerDrafts]);

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
    saveDesktopAttachmentPaths,
    removeChatComposerAttachment,
    updateChatComposerAttachment,
    setChatComposerText,
    setProjectComposerText,
    acceptChatSlashCommand,
    acceptProjectSlashCommand,
  };
}
