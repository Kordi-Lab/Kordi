import { agentRuntimeRouteChangeNotice } from '@/features/cloud/cloudAgentRuntime';

import {
  formatDesktopEventTime,
  formatThinkingSelectionLabel,
  parseModelSelection,
} from './composerController.shared';
import type {
  ComposerRuntimeContext,
  MinimalModelOption,
} from './composerController.types';
import { appendOrReplaceTrailingSessionConfigNotice } from './sessionConfigNotices';

export function appendOptimisticSessionConfigMessage({
  current,
  targetSessionId,
  nextModelValue,
  nextThinkingValue,
  chatModelOptions,
}: {
  current: NonNullable<ComposerRuntimeContext['desktopChatState']>;
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
  const modelChanged = Boolean(
    parsedModel
      && (parsedModel.provider !== current.activeSession.provider
        || parsedModel.modelId !== current.activeSession.model),
  );
  const thinkingChanged = Boolean(
    nextThinkingValue && nextThinkingValue !== current.activeSession.thinking,
  );
  const nextProvider = modelChanged
    ? (selectedModelOption?.provider
      ?? parsedModel?.provider
      ?? current.activeSession.provider)
    : current.activeSession.provider;
  const nextModel = modelChanged
    ? (parsedModel?.modelId ?? current.activeSession.model)
    : current.activeSession.model;
  const qualifiedModel = nextModel.includes('/') || !nextProvider
    ? nextModel
    : `${nextProvider}/${nextModel}`;
  const nextMessages = appendOrReplaceTrailingSessionConfigNotice(
    current.activeSession.messages,
    {
      role: 'system',
      text: agentRuntimeRouteChangeNotice({
        model: qualifiedModel,
        authProvider: nextProvider,
        thinking: nextThinkingValue ?? current.activeSession.thinking,
      }),
      detail: 'Runtime updated',
      timeLabel,
      timestampMs,
    },
  );
  const messageCountDelta = nextMessages.appended ? 1 : 0;
  return {
    ...current,
    sessions: current.sessions.map((session) => (
      session.id === targetSessionId
        ? {
            ...session,
            updatedAtLabel: timeLabel,
            updatedAtMs: timestampMs,
            messageCount: session.messageCount + messageCountDelta,
          }
        : session
    )),
    activeSession: {
      ...current.activeSession,
      provider: modelChanged
        ? nextProvider
        : current.activeSession.provider,
      providerLabel: modelChanged
        ? (selectedModelOption?.providerLabel
          ?? current.activeSession.providerLabel)
        : current.activeSession.providerLabel,
      model: modelChanged
        ? (selectedModelOption?.label
          ?? parsedModel?.modelId
          ?? current.activeSession.model)
        : current.activeSession.model,
      modelLabel: modelChanged
        ? (selectedModelOption?.label
          ?? parsedModel?.modelId
          ?? current.activeSession.modelLabel)
        : current.activeSession.modelLabel,
      thinking: thinkingChanged
        ? (nextThinkingValue ?? current.activeSession.thinking)
        : current.activeSession.thinking,
      thinkingLabel: thinkingChanged
        ? formatThinkingSelectionLabel(
            nextThinkingValue ?? current.activeSession.thinking,
          )
        : current.activeSession.thinkingLabel,
      updatedAtLabel: timeLabel,
      updatedAtMs: timestampMs,
      messageCount: current.activeSession.messageCount + messageCountDelta,
      messages: nextMessages.messages,
    },
  };
}
