import type { QueuedDesktopChatMessage } from '@/kordi-app/types';

export const QUEUED_DESKTOP_MESSAGES_STORAGE_KEY = 'kordi.desktop.queuedDesktopMessages.v1';

export type QueuedDesktopMessagesBySession = Record<string, QueuedDesktopChatMessage[]>;
export type QueuedDesktopMessagesStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserQueuedDesktopMessagesStorage(): QueuedDesktopMessagesStorage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function loadQueuedDesktopMessagesBySession(
  storage: QueuedDesktopMessagesStorage | null = browserQueuedDesktopMessagesStorage(),
): QueuedDesktopMessagesBySession {
  if (!storage) return {};
  try {
    const raw = storage.getItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY);
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
  storage: QueuedDesktopMessagesStorage | null = browserQueuedDesktopMessagesStorage(),
) {
  if (!storage) return;
  try {
    const hasQueuedMessages = Object.values(messages).some((items) => items.length > 0);
    if (!hasQueuedMessages) {
      storage.removeItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY);
      return;
    }
    storage.setItem(QUEUED_DESKTOP_MESSAGES_STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Best-effort draft preservation only; UI state remains authoritative.
  }
}
