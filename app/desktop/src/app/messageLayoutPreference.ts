import { useSyncExternalStore } from 'react';

export type MessageLayout = 'chat' | 'threads';
export const MESSAGE_LAYOUT_STORAGE_KEY = 'kordi.messageLayout.v1';
const listeners = new Set<() => void>();
let snapshot: MessageLayout | undefined;

export function readStoredMessageLayout(storage?: Pick<Storage, 'getItem'>): MessageLayout {
  try {
    const value = (storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined))
      ?.getItem(MESSAGE_LAYOUT_STORAGE_KEY);
    return value === 'threads' ? 'threads' : 'chat';
  } catch {
    return 'chat';
  }
}

function getSnapshot(): MessageLayout {
  return snapshot ??= readStoredMessageLayout();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== MESSAGE_LAYOUT_STORAGE_KEY) return;
  snapshot = readStoredMessageLayout();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    snapshot = readStoredMessageLayout();
    window.addEventListener('storage', onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function setMessageLayout(layout: MessageLayout) {
  snapshot = layout;
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(MESSAGE_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // Keep the current window usable when persistent storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

export function useMessageLayout() {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'chat' as const);
}
