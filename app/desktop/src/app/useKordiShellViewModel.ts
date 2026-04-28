import { useCallback, useMemo } from 'react';
import type { MutableRefObject } from 'react';

import type { ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import type { ComposerScope, Conversation, DesktopChatState, ResolvedThemeMode } from '@/kordi-app/types';
import { formatDesktopClockTime } from '@/lib/time';

type UseKordiShellViewModelArgs = {
  themeMode: ResolvedThemeMode;
  lastBridgePollAt: number | null;
  chatTranscriptScrollRef: MutableRefObject<HTMLDivElement | null>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  desktopChatState: DesktopChatState | null;
  activeConv: Conversation;
  activeConversationIsBridge: boolean;
  chatModelOptions: ComposerModelOption[];
  selectComposerValue: (scope: ComposerScope, type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string) => Promise<void>;
  selectComposerAuthChoice: (scope: ComposerScope, providerId: string, choice: string) => Promise<void>;
  selectComposerProviderChoice: (scope: ComposerScope, option: ComposerProviderOption) => Promise<void>;
  handleStopDesktopChatTurn: () => Promise<void> | void;
  handleSendProjectMessage: (draftOverride?: string) => Promise<void> | void;
  handleSendChatMessage: (draftOverride?: string) => Promise<void> | void;
};

export function useKordiShellViewModel({
  themeMode,
  lastBridgePollAt,
  chatTranscriptScrollRef,
  shouldAutoFollowChatRef,
  desktopChatState,
  activeConv,
  activeConversationIsBridge,
  chatModelOptions,
  selectComposerValue,
  selectComposerAuthChoice,
  selectComposerProviderChoice,
  handleStopDesktopChatTurn,
  handleSendProjectMessage,
  handleSendChatMessage,
}: UseKordiShellViewModelArgs) {
  const lastBridgePollAtLabel = useMemo(
    () => (lastBridgePollAt ? formatDesktopClockTime(lastBridgePollAt, { includeSeconds: true }) : null),
    [lastBridgePollAt],
  );

  const rootThemeClass = themeMode === 'light' ? 'theme-light' : 'theme-dark';

  const isChatScrolledNearBottom = useCallback((container: HTMLDivElement) => {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < 140;
  }, []);

  const onProjectTranscriptScroll = useCallback(() => {
    const container = chatTranscriptScrollRef.current;
    if (!container) return;
    shouldAutoFollowChatRef.current = isChatScrolledNearBottom(container);
  }, [chatTranscriptScrollRef, isChatScrolledNearBottom, shouldAutoFollowChatRef]);

  const onChatTranscriptScroll = useCallback(() => {
    const container = chatTranscriptScrollRef.current;
    if (!container) return;
    shouldAutoFollowChatRef.current = isChatScrolledNearBottom(container);
  }, [chatTranscriptScrollRef, isChatScrolledNearBottom, shouldAutoFollowChatRef]);

  const wrappedSelectComposerValue = useCallback((scope: ComposerScope, type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string) => (
    selectComposerValue(scope, type, value)
  ), [selectComposerValue]);

  const wrappedSelectComposerAuthChoice = useCallback((scope: ComposerScope, providerId: string, choice: string) => {
    void selectComposerAuthChoice(scope, providerId, choice);
  }, [selectComposerAuthChoice]);

  const wrappedSelectComposerProviderChoice = useCallback((scope: ComposerScope, option: ComposerProviderOption) => {
    void selectComposerProviderChoice(scope, option);
  }, [selectComposerProviderChoice]);

  const wrappedStopDesktopChatTurn = useCallback(() => {
    void handleStopDesktopChatTurn();
  }, [handleStopDesktopChatTurn]);

  const wrappedSendProjectMessage = useCallback((draftOverride?: string) => {
    void handleSendProjectMessage(draftOverride);
  }, [handleSendProjectMessage]);

  const wrappedSendChatMessage = useCallback((draftOverride?: string) => {
    void handleSendChatMessage(draftOverride);
  }, [handleSendChatMessage]);

  return {
    rootThemeClass,
    lastBridgePollAtLabel,
    onProjectTranscriptScroll,
    onChatTranscriptScroll,
    activeRuntimeSessionId: desktopChatState?.activeSessionId,
    activeRuntimeContextStatus: desktopChatState?.activeSession?.contextWindowStatus ?? (!activeConversationIsBridge ? activeConv.contextWindowStatus : undefined),
    activeRuntimeCacheText: desktopChatState?.activeSession?.cacheMonitorText ?? (!activeConversationIsBridge ? activeConv.cacheMonitorText : undefined),
    activeSessionProject: !activeConversationIsBridge ? (desktopChatState?.activeSession?.project ?? null) : null,
    chatModelOptionsForShell: chatModelOptions.length > 0 ? chatModelOptions : undefined,
    wrappedSelectComposerValue,
    wrappedSelectComposerAuthChoice,
    wrappedSelectComposerProviderChoice,
    wrappedStopDesktopChatTurn,
    wrappedSendProjectMessage,
    wrappedSendChatMessage,
  };
}
