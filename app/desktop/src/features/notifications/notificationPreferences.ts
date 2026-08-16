import { useSyncExternalStore } from 'react';

export type NotificationPreferences = {
  messages: boolean;
  sound: boolean;
  previews: boolean;
  badge: boolean;
  dockBounce: boolean;
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  messages: true,
  sound: true,
  previews: true,
  badge: true,
  dockBounce: true,
};

const STORAGE_KEY = 'kordi.notification-preferences.v1';
const listeners = new Set<() => void>();
let cachedPreferences: NotificationPreferences | null = null;

function readPreferences() {
  if (cachedPreferences) return cachedPreferences;
  if (typeof window === 'undefined') return DEFAULT_NOTIFICATION_PREFERENCES;
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<NotificationPreferences>;
    cachedPreferences = {
      messages: stored.messages ?? true,
      sound: stored.sound ?? true,
      previews: stored.previews ?? true,
      badge: stored.badge ?? true,
      dockBounce: stored.dockBounce ?? true,
    };
  } catch {
    cachedPreferences = DEFAULT_NOTIFICATION_PREFERENCES;
  }
  return cachedPreferences;
}

export function setNotificationPreference(
  key: keyof NotificationPreferences,
  enabled: boolean,
) {
  cachedPreferences = { ...readPreferences(), [key]: enabled };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedPreferences));
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNotificationPreferences() {
  return useSyncExternalStore(subscribe, readPreferences, () => DEFAULT_NOTIFICATION_PREFERENCES);
}
