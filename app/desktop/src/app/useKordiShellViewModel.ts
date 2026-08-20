import { useCallback, useMemo } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import type { ComposerScope, Conversation, DesktopChatState, Message, ResolvedThemeMode } from '@/kordi-app/types';
import type { DesktopChatContextMessage } from '@/lib/desktop';
import { formatDesktopClockTime } from '@/lib/time';
import type {
  AttachmentItem,
  ComposerConfigTargetOverride,
} from '@/features/chat/composerController.types';
import { transcriptIsAtLatest } from '@/features/cloud/activeConversationReadPolicy';

type UseKordiShellViewModelArgs = {
  themeMode: ResolvedThemeMode;
  lastCollaborationSyncAt: number | null;
  chatTranscriptScrollRef: MutableRefObject<HTMLDivElement | null>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  setChatTranscriptAtLatest: Dispatch<SetStateAction<boolean>>;
  desktopChatState: DesktopChatState | null;
  activeConv: Conversation;
  activeConversationUsesCollaboration: boolean;
  chatModelOptions: ComposerModelOption[];
  selectComposerValue: (scope: ComposerScope, type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string, configTargetOverride?: ComposerConfigTargetOverride) => Promise<void>;
  selectComposerAuthChoice: (scope: ComposerScope, providerId: string, choice: string, configTargetOverride?: ComposerConfigTargetOverride) => Promise<void>;
  selectComposerProviderChoice: (scope: ComposerScope, option: ComposerProviderOption, configTargetOverride?: ComposerConfigTargetOverride) => Promise<void>;
  handleStopDesktopChatTurn: () => Promise<void> | void;
  handleSendProjectMessage: (draftOverride?: string) => Promise<void> | void;
  handleSendChatMessage: (draftOverride?: string, targetSessionId?: string, contextMessages?: DesktopChatContextMessage[], attachmentOverride?: AttachmentItem[]) => Promise<void> | void;
  handleRetryChatMessage: (message: Message) => Promise<void> | void;
};

export function useKordiShellViewModel({
  themeMode,
  lastCollaborationSyncAt,
  chatTranscriptScrollRef,
  shouldAutoFollowChatRef,
  setChatTranscriptAtLatest,
  desktopChatState,
  activeConv,
  activeConversationUsesCollaboration,
  chatModelOptions,
  selectComposerValue,
  selectComposerAuthChoice,
  selectComposerProviderChoice,
  handleStopDesktopChatTurn,
  handleSendProjectMessage,
  handleSendChatMessage,
  handleRetryChatMessage,
}: UseKordiShellViewModelArgs) {
  const lastCollaborationSyncAtLabel = useMemo(
    () => (lastCollaborationSyncAt ? formatDesktopClockTime(lastCollaborationSyncAt, { includeSeconds: true }) : null),
    [lastCollaborationSyncAt],
  );

  const rootThemeClass = themeMode === 'light' ? 'theme-light' : 'theme-dark';

  const onProjectTranscriptScroll = useCallback(() => {
    const container = chatTranscriptScrollRef.current;
    if (!container) return;
    const isAtLatest = transcriptIsAtLatest(container);
    shouldAutoFollowChatRef.current = isAtLatest;
    setChatTranscriptAtLatest(isAtLatest);
  }, [chatTranscriptScrollRef, setChatTranscriptAtLatest, shouldAutoFollowChatRef]);

  const onChatTranscriptScroll = useCallback(() => {
    const container = chatTranscriptScrollRef.current;
    if (!container) return;
    const isAtLatest = transcriptIsAtLatest(container);
    shouldAutoFollowChatRef.current = isAtLatest;
    setChatTranscriptAtLatest(isAtLatest);
  }, [chatTranscriptScrollRef, setChatTranscriptAtLatest, shouldAutoFollowChatRef]);

  const wrappedSelectComposerValue = useCallback((scope: ComposerScope, type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string, configTargetOverride?: ComposerConfigTargetOverride) => (
    selectComposerValue(scope, type, value, configTargetOverride)
  ), [selectComposerValue]);

  const wrappedSelectComposerAuthChoice = useCallback((scope: ComposerScope, providerId: string, choice: string, configTargetOverride?: ComposerConfigTargetOverride) => {
    void selectComposerAuthChoice(scope, providerId, choice, configTargetOverride);
  }, [selectComposerAuthChoice]);

  const wrappedSelectComposerProviderChoice = useCallback((scope: ComposerScope, option: ComposerProviderOption, configTargetOverride?: ComposerConfigTargetOverride) => {
    void selectComposerProviderChoice(scope, option, configTargetOverride);
  }, [selectComposerProviderChoice]);

  const wrappedStopDesktopChatTurn = useCallback(() => {
    void handleStopDesktopChatTurn();
  }, [handleStopDesktopChatTurn]);

  const wrappedSendProjectMessage = useCallback((draftOverride?: string) => {
    void handleSendProjectMessage(draftOverride);
  }, [handleSendProjectMessage]);

  const wrappedSendChatMessage = useCallback((draftOverride?: string, targetSessionId?: string, contextMessages?: DesktopChatContextMessage[], attachmentOverride?: AttachmentItem[]) => {
    return handleSendChatMessage(draftOverride, targetSessionId, contextMessages, attachmentOverride);
  }, [handleSendChatMessage]);

  const wrappedRetryChatMessage = useCallback((message: Message) => {
    return handleRetryChatMessage(message);
  }, [handleRetryChatMessage]);

  return {
    rootThemeClass,
    lastCollaborationSyncAtLabel,
    onProjectTranscriptScroll,
    onChatTranscriptScroll,
    activeRuntimeSessionId: desktopChatState?.activeSessionId,
    activeRuntimeContextStatus: desktopChatState?.activeSession?.contextWindowStatus ?? (!activeConversationUsesCollaboration ? activeConv.contextWindowStatus : undefined),
    activeRuntimeCacheText: desktopChatState?.activeSession?.cacheMonitorText ?? (!activeConversationUsesCollaboration ? activeConv.cacheMonitorText : undefined),
    activeSessionProject: !activeConversationUsesCollaboration ? (desktopChatState?.activeSession?.project ?? null) : null,
    chatModelOptionsForShell: chatModelOptions.length > 0 ? chatModelOptions : undefined,
    wrappedSelectComposerValue,
    wrappedSelectComposerAuthChoice,
    wrappedSelectComposerProviderChoice,
    wrappedStopDesktopChatTurn,
    wrappedSendProjectMessage,
    wrappedSendChatMessage,
    wrappedRetryChatMessage,
  };
}
