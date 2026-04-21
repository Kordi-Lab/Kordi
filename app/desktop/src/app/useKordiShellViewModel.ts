import { useCallback, useMemo } from 'react';
import type { MutableRefObject } from 'react';

import type { ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import type { ComposerScope, DesktopChatState } from '@/kordi-app/types';

type UseKordiShellViewModelArgs = {
  themeMode: 'dark' | 'light';
  lastBridgePollAt: number | null;
  chatTranscriptScrollRef: MutableRefObject<HTMLDivElement | null>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  desktopChatState: DesktopChatState | null;
  activeConversationIsBridge: boolean;
  chatModelOptions: ComposerModelOption[];
  selectComposerValue: (scope: ComposerScope, type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string) => Promise<void>;
  selectComposerAuthChoice: (scope: ComposerScope, providerId: string, choice: string) => Promise<void>;
  selectComposerProviderChoice: (scope: ComposerScope, option: ComposerProviderOption) => Promise<void>;
  handleStopDesktopChatTurn: () => Promise<void> | void;
  handleSendProjectMessage: () => Promise<void> | void;
  handleSendChatMessage: () => Promise<void> | void;
};

export function useKordiShellViewModel({
  themeMode,
  lastBridgePollAt,
  chatTranscriptScrollRef,
  shouldAutoFollowChatRef,
  desktopChatState,
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
    () => (lastBridgePollAt ? new Date(lastBridgePollAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null),
    [lastBridgePollAt],
  );

  const rootThemeClass = themeMode === 'light' ? 'theme-light' : 'theme-dark';

  const isChatScrolledNearBottom = useCallback((container: HTMLDivElement) => {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < 96;
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

  const wrappedSelectComposerValue = useCallback((scope: ComposerScope, type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string) => {
    void selectComposerValue(scope, type, value);
  }, [selectComposerValue]);

  const wrappedSelectComposerAuthChoice = useCallback((scope: ComposerScope, providerId: string, choice: string) => {
    void selectComposerAuthChoice(scope, providerId, choice);
  }, [selectComposerAuthChoice]);

  const wrappedSelectComposerProviderChoice = useCallback((scope: ComposerScope, option: ComposerProviderOption) => {
    void selectComposerProviderChoice(scope, option);
  }, [selectComposerProviderChoice]);

  const wrappedStopDesktopChatTurn = useCallback(() => {
    void handleStopDesktopChatTurn();
  }, [handleStopDesktopChatTurn]);

  const wrappedSendProjectMessage = useCallback(() => {
    void handleSendProjectMessage();
  }, [handleSendProjectMessage]);

  const wrappedSendChatMessage = useCallback(() => {
    void handleSendChatMessage();
  }, [handleSendChatMessage]);

  return {
    rootThemeClass,
    lastBridgePollAtLabel,
    onProjectTranscriptScroll,
    onChatTranscriptScroll,
    activeRuntimeSessionId: desktopChatState?.activeSessionId,
    activeRuntimeContextStatus: desktopChatState?.activeSession?.contextWindowStatus,
    activeRuntimeCacheText: desktopChatState?.activeSession?.cacheMonitorText,
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
