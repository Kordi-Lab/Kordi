import { useCallback, useState } from 'react';

import { CHAT_COMPOSER_TEXTAREA_SELECTOR, focusComposerTextareaForNativeInput } from '@/features/chat/composerController.shared';
import { threadRootSource } from '@/features/chat/messageThreads';
import type { ComposerQuoteState, Message, MessageReplyDestination } from '@/kordi-app/types';

export function useChatThreadSelection({
  conversationId,
  sessionId,
  activeReplyAction,
  isNativeShell,
  routeReplyMessage,
  clearReply,
}: {
  conversationId: string;
  sessionId: string;
  activeReplyAction?: ComposerQuoteState['action'];
  isNativeShell: boolean;
  routeReplyMessage?: (message: Message, destination: MessageReplyDestination) => void;
  clearReply?: () => void;
}) {
  const [openThreadState, setOpenThreadState] = useState<{
    conversationId: string;
    rootId: string;
    optimisticReplyCount?: number;
  } | null>(null);
  const activeThreadRootId = openThreadState?.conversationId === conversationId
    ? openThreadState.rootId
    : null;
  const openThread = useCallback((message: Message) => {
    const source = threadRootSource(message, sessionId);
    if (!source) return;
    setOpenThreadState({ conversationId, rootId: source.sourceMessageId });
  }, [conversationId, sessionId]);
  const replyToMessage = useCallback((message: Message, destination: MessageReplyDestination) => {
    if (destination === 'thread') openThread(message);
    else {
      setOpenThreadState(null);
      routeReplyMessage?.(message, destination);
    }
  }, [openThread, routeReplyMessage]);
  const closeThread = useCallback(() => {
    setOpenThreadState(null);
    if (activeReplyAction === 'thread') clearReply?.();
    requestAnimationFrame(() => {
      focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, isNativeShell);
    });
  }, [activeReplyAction, clearReply, isNativeShell]);

  return { activeThreadRootId, closeThread, openThread, openThreadState, replyToMessage, setOpenThreadState };
}
