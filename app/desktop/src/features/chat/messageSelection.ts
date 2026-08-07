import type { ForwardMessageSource } from './messageActionMetadata';

const MESSAGE_SELECTION_DRAG_THRESHOLD_PX = 6;

export type MessageSelectionPoint = {
  x: number;
  y: number;
};

export function hasMessageSelectionDragExceededThreshold(
  start: MessageSelectionPoint,
  current: MessageSelectionPoint,
  thresholdPx = MESSAGE_SELECTION_DRAG_THRESHOLD_PX,
) {
  return Math.hypot(current.x - start.x, current.y - start.y) >= thresholdPx;
}

export type MessageSelectionState = {
  conversationId: string;
  sourcesByMessageId: Map<string, ForwardMessageSource>;
};

export function selectAllMessageSources(
  conversationId: string,
  sources: readonly ForwardMessageSource[],
): MessageSelectionState | null {
  const sourcesByMessageId = new Map(
    sources.map((source) => [source.sourceMessageId, source]),
  );
  return sourcesByMessageId.size > 0 ? { conversationId, sourcesByMessageId } : null;
}

export function formatSelectedMessagesForCopy(sources: readonly ForwardMessageSource[]) {
  return sources
    .map((source) => {
      const sender = source.senderLabel.trim() || 'Unknown sender';
      const text = source.textPreview.trim();
      const fallback = source.attachmentCount > 0
        ? `[${source.attachmentCount} attachment${source.attachmentCount === 1 ? '' : 's'}]`
        : '[Message]';
      return `${sender}: ${text || fallback}`;
    })
    .join('\n');
}

export function setMessageSelectionSource(
  current: MessageSelectionState | null,
  conversationId: string,
  source: ForwardMessageSource,
  selected: boolean,
): MessageSelectionState | null {
  const nextMap = current?.conversationId === conversationId
    ? new Map(current.sourcesByMessageId)
    : new Map<string, ForwardMessageSource>();

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
  source: ForwardMessageSource,
): MessageSelectionState | null {
  const currentlySelected = current?.conversationId === conversationId
    && current.sourcesByMessageId.has(source.sourceMessageId);
  return setMessageSelectionSource(current, conversationId, source, !currentlySelected);
}
