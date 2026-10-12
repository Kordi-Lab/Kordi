import type { DocumentUpdatedEvent } from './documentShareTypes';

type Listener = (event: DocumentUpdatedEvent) => void;

const listenersByAttachment = new Map<string, Set<Listener>>();

/** Open readers subscribe by attachment id to hear about saves made elsewhere. */
export function subscribeDocumentUpdates(attachmentId: string, listener: Listener) {
  const listeners = listenersByAttachment.get(attachmentId) ?? new Set<Listener>();
  listeners.add(listener);
  listenersByAttachment.set(attachmentId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByAttachment.delete(attachmentId);
  };
}

/** Hands `document.updated` events from the cloud sync stream to open readers. */
export function notifyDocumentSyncEvents(events: ReadonlyArray<{ eventType?: string; payload?: unknown }>) {
  for (const event of events) {
    if (event.eventType !== 'document.updated' || !event.payload || typeof event.payload !== 'object') continue;
    const { attachmentId, revision, change } = event.payload as { attachmentId?: unknown; revision?: unknown; change?: unknown };
    if (typeof attachmentId !== 'string' || typeof revision !== 'number') continue;
    const kind = change === 'annotations' || change === 'content' ? change : undefined;
    for (const listener of [...(listenersByAttachment.get(attachmentId) ?? [])]) listener({ attachmentId, revision, ...(kind ? { change: kind } : {}) });
  }
}
