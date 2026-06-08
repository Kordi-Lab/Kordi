import type { MessageActionSource } from './messageActionMetadata';

export type MessageSelectionState = {
  conversationId: string;
  sourcesByMessageId: Map<string, MessageActionSource>;
};

export function setMessageSelectionSource(
  current: MessageSelectionState | null,
  conversationId: string,
  source: MessageActionSource,
  selected: boolean,
): MessageSelectionState | null {
  const nextMap = current?.conversationId === conversationId
    ? new Map(current.sourcesByMessageId)
    : new Map<string, MessageActionSource>();

  if (selected) {
    nextMap.set(source.sourceMessageId, source);
  } else {
    nextMap.delete(source.sourceMessageId);
  }

  if (nextMap.size === 0) return null;
  return { conversationId, sourcesByMessageId: nextMap };
}

export function toggleMessageSelectionSource(
  current: MessageSelectionState | null,
  conversationId: string,
  source: MessageActionSource,
): MessageSelectionState | null {
  const currentlySelected = current?.conversationId === conversationId
    && current.sourcesByMessageId.has(source.sourceMessageId);
  return setMessageSelectionSource(current, conversationId, source, !currentlySelected);
}
