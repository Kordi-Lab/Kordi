import type { Message, QueuedDesktopChatMessage } from '@/kordi-app/types';
import { upsertCanonicalMessageFast } from '@/lib/desktop';
import { prepareCanonicalQueuedMessage } from './messageActions/optimistic';

const pendingQueueWrites = new Map<string, Promise<unknown>>();

export function queuedTranscriptRequestIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.turn?.status === 'queued' && !message.turn.completed) {
      const requestId = message.replyToMessageId ?? message.turn.replyToMessageId;
      if (requestId) ids.add(requestId);
    } else if (message.role === 'user' && message.statusChips?.includes('queued') && message.id) {
      ids.add(message.id);
    }
  }
  return ids;
}

export function persistQueuedDesktopMessage(
  message: QueuedDesktopChatMessage,
  senderIdentityId: string | null | undefined,
  status: 'queued' | 'sent' | 'cancelled' = 'queued',
) {
  if (message.scope !== 'chat') return Promise.resolve(null);
  const previous = pendingQueueWrites.get(message.id) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const prepared = prepareCanonicalQueuedMessage(message, senderIdentityId, status);
    return prepared ? upsertCanonicalMessageFast(prepared.request) : null;
  });
  pendingQueueWrites.set(message.id, pending);
  void pending.finally(() => {
    if (pendingQueueWrites.get(message.id) === pending) pendingQueueWrites.delete(message.id);
  }).catch(() => undefined);
  return pending;
}

export const QUEUED_DESKTOP_MESSAGES_STORAGE_KEY = 'kordi.desktop.queuedDesktopMessages.v1';

export type QueuedDesktopMessagesBySession = Record<string, QueuedDesktopChatMessage[]>;
export type QueuedDesktopMessagesStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function removeQueuedDesktopMessageById(
  current: QueuedDesktopMessagesBySession,
  sessionId: string,
  queuedMessageId: string,
): QueuedDesktopMessagesBySession {
  const existing = current[sessionId] ?? [];
  const remaining = existing.filter((message) => message.id !== queuedMessageId);
  if (remaining.length === existing.length) return current;

  const next = { ...current };
  if (remaining.length > 0) {
    next[sessionId] = remaining;
  } else {
    delete next[sessionId];
  }
  return next;
}

function browserQueuedDesktopMessagesStorage(): QueuedDesktopMessagesStorage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function loadQueuedDesktopMessagesBySession(
  storage: QueuedDesktopMessagesStorage | null | undefined = undefined,
): QueuedDesktopMessagesBySession {
  try {
    const resolvedStorage = storage === undefined ? browserQueuedDesktopMessagesStorage() : storage;
    if (!resolvedStorage) return {};
    const raw = resolvedStorage.getItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as QueuedDesktopMessagesBySession;
  } catch {
    return {};
  }
}

export function saveQueuedDesktopMessagesBySession(
  messages: QueuedDesktopMessagesBySession,
  storage: QueuedDesktopMessagesStorage | null | undefined = undefined,
) {
  try {
    const resolvedStorage = storage === undefined ? browserQueuedDesktopMessagesStorage() : storage;
    if (!resolvedStorage) return;
    const hasQueuedMessages = Object.values(messages).some((items) => items.length > 0);
    if (!hasQueuedMessages) {
      resolvedStorage.removeItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY);
      return;
    }
    resolvedStorage.setItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Best-effort draft preservation only; UI state remains authoritative.
  }
}
