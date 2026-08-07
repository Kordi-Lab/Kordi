import { useCallback, useMemo, useRef, useState } from 'react';

import { clearNativeTextSelection } from '@/features/contentSelection';
import type { ForwardMessageSource } from '@/features/chat/messageActionMetadata';
import {
  selectAllMessageSources,
  setMessageSelectionSource,
  toggleMessageSelectionSource,
  type MessageSelectionState,
} from '@/features/chat/messageSelection';
import type { Conversation, Message } from '@/kordi-app/types';

type UseMessageSelectionActionsArgs = {
  activeConversation: Conversation;
  sourceForSelectableMessage: (message: Message) => ForwardMessageSource | null;
};

export function useMessageSelectionActions({
  activeConversation,
  sourceForSelectableMessage,
}: UseMessageSelectionActionsArgs) {
  const [messageSelection, setMessageSelection] = useState<MessageSelectionState | null>(null);
  const selectionDragRef = useRef<{
    conversationId: string;
    shouldSelect: boolean;
  } | null>(null);

  const isMessageSelectable = useCallback(
    (message: Message) => Boolean(sourceForSelectableMessage(message)),
    [sourceForSelectableMessage],
  );

  const onSelectMessage = useCallback((message: Message) => {
    const source = sourceForSelectableMessage(message);
    if (!source) return;
    clearNativeTextSelection();
    setMessageSelection({
      conversationId: activeConversation.id,
      sourcesByMessageId: new Map([[source.sourceMessageId, source]]),
    });
  }, [activeConversation.id, sourceForSelectableMessage]);

  const onToggleSelectedMessage = useCallback((message: Message) => {
    const source = sourceForSelectableMessage(message);
    if (!source) return;
    clearNativeTextSelection();
    setMessageSelection((current) => toggleMessageSelectionSource(
      current,
      activeConversation.id,
      source,
    ));
  }, [activeConversation.id, sourceForSelectableMessage]);

  const onCancelMessageSelection = useCallback(() => {
    clearNativeTextSelection();
    selectionDragRef.current = null;
    setMessageSelection(null);
  }, []);

  const onSelectAllMessages = useCallback(() => {
    const sources = activeConversation.messages
      .map(sourceForSelectableMessage)
      .filter((source): source is ForwardMessageSource => Boolean(source));
    clearNativeTextSelection();
    selectionDragRef.current = null;
    setMessageSelection(selectAllMessageSources(activeConversation.id, sources));
  }, [activeConversation.id, activeConversation.messages, sourceForSelectableMessage]);

  const onSelectionDragStart = useCallback((message: Message, shouldSelect: boolean) => {
    const source = sourceForSelectableMessage(message);
    if (!source) return;
    clearNativeTextSelection();
    selectionDragRef.current = { conversationId: activeConversation.id, shouldSelect };
    setMessageSelection((current) => setMessageSelectionSource(
      current,
      activeConversation.id,
      source,
      shouldSelect,
    ));
  }, [activeConversation.id, sourceForSelectableMessage]);

  const onSelectionDragEnter = useCallback((message: Message) => {
    const drag = selectionDragRef.current;
    if (!drag || drag.conversationId !== activeConversation.id) return;
    const source = sourceForSelectableMessage(message);
    if (!source) return;
    setMessageSelection((current) => setMessageSelectionSource(
      current,
      activeConversation.id,
      source,
      drag.shouldSelect,
    ));
  }, [activeConversation.id, sourceForSelectableMessage]);

  const onSelectionDragEnd = useCallback(() => {
    selectionDragRef.current = null;
  }, []);

  const activeMessageSelection = messageSelection?.conversationId === activeConversation.id
    ? messageSelection
    : null;
  const selectedMessageIds = useMemo(
    () => new Set(activeMessageSelection?.sourcesByMessageId.keys() ?? []),
    [activeMessageSelection?.sourcesByMessageId],
  );

  return {
    activeMessageSelection,
    selectedMessageIds,
    selectedMessageCount: selectedMessageIds.size,
    isMessageSelectable,
    onSelectMessage,
    onToggleSelectedMessage,
    onCancelMessageSelection,
    onSelectAllMessages,
    onSelectionDragStart,
    onSelectionDragEnter,
    onSelectionDragEnd,
  };
}
