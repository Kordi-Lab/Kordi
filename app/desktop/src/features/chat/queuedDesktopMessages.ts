import type { QueuedDesktopChatMessage } from '@/kordi-app/types';

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
  return window.sessionStorage;
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
