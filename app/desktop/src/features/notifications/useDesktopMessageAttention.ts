import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
} from '@tauri-apps/plugin-notification';
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import { documentHasActivePresentation } from '@/features/cloud/activeConversationReadPolicy';
import { transcriptIsAtLatest } from '@/features/cloud/activeConversationReadPolicy';
import type { Conversation } from '@/kordi-app/types';
import {
  messageAttentionSnapshot,
  newMessageAttentionEvents,
  shouldRequestDockAttention,
  type MessageAttentionSnapshot,
} from './messageAttentionPolicy';
import { useNotificationPreferences } from './notificationPreferences';

const PRESENTED_EVENT_STORAGE_KEY = 'kordi.presented-message-notification-ids.v1';
const MAX_PRESENTED_EVENT_IDS = 200;
const BOUNCE_BURST_MS = 2_000;
const MESSAGE_NOTIFICATION_OPENED_EVENT = 'kordi://message-notification-opened';

type UseDesktopMessageAttentionArgs = {
  isNativeShell: boolean;
  attentionReady: boolean;
  activeNav: string;
  activeConversationId: string;
  activeCanonicalSessionId?: string | null;
  chatTranscriptScrollRef: MutableRefObject<HTMLElement | null>;
  conversations: Conversation[];
  totalUnreadCount: number;
  onOpenSession: (sessionId: string, messageId: string) => void;
};

function loadPresentedEventIds() {
  if (typeof window === 'undefined') return new Set<string>();
  try {
    const values: unknown = JSON.parse(
      window.sessionStorage.getItem(PRESENTED_EVENT_STORAGE_KEY) ?? '[]',
    );
    return new Set(Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function savePresentedEventIds(ids: Set<string>) {
  if (typeof window === 'undefined') return;
  const values = [...ids].slice(-MAX_PRESENTED_EVENT_IDS);
  window.sessionStorage.setItem(PRESENTED_EVENT_STORAGE_KEY, JSON.stringify(values));
}

function notificationRoute(extra?: Record<string, unknown>) {
  const sessionId = typeof extra?.sessionId === 'string' ? extra.sessionId : '';
  const messageId = typeof extra?.messageId === 'string' ? extra.messageId : '';
  return sessionId && messageId ? { sessionId, messageId } : null;
}

export function useDesktopMessageAttention({
  isNativeShell,
  attentionReady,
  activeNav,
  activeConversationId,
  activeCanonicalSessionId,
  chatTranscriptScrollRef,
  conversations,
  totalUnreadCount,
  onOpenSession,
}: UseDesktopMessageAttentionArgs) {
  const preferences = useNotificationPreferences();
  const previousSnapshotRef = useRef<MessageAttentionSnapshot | null>(null);
  const presentedEventIdsRef = useRef(loadPresentedEventIds());
  const lastBounceAtRef = useRef(0);
  const nativeWindowFocusedRef = useRef(
    typeof document !== 'undefined'
      ? documentHasActivePresentation(document)
      : false,
  );
  const onOpenSessionRef = useRef(onOpenSession);

  useEffect(() => {
    onOpenSessionRef.current = onOpenSession;
  }, [onOpenSession]);

  useEffect(() => {
    if (!isNativeShell) return;
    const windowHandle = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void windowHandle.isFocused().then((focused) => {
      if (!disposed) nativeWindowFocusedRef.current = focused;
    }).catch(() => {});
    void windowHandle.onFocusChanged(({ payload: focused }) => {
      nativeWindowFocusedRef.current = focused;
    }).then((listener) => {
      if (disposed) {
        listener();
      } else {
        unlisten = listener;
      }
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isNativeShell]);

  useEffect(() => {
    if (!isNativeShell) return;
    const windowHandle = getCurrentWindow();
    void windowHandle.setBadgeCount(
      preferences.badge && totalUnreadCount > 0 ? totalUnreadCount : undefined,
    ).catch(() => {});
  }, [isNativeShell, preferences.badge, totalUnreadCount]);

  useEffect(() => {
    if (!isNativeShell) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<Record<string, unknown>>(
      MESSAGE_NOTIFICATION_OPENED_EVENT,
      (event) => {
        const route = notificationRoute(event.payload);
        if (route) onOpenSessionRef.current(route.sessionId, route.messageId);
      },
    )).then((listener) => {
      if (disposed) {
        listener();
      } else {
        unlisten = listener;
      }
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isNativeShell]);

  useEffect(() => {
    const currentSnapshot = messageAttentionSnapshot(conversations);
    if (!attentionReady || previousSnapshotRef.current === null) {
      previousSnapshotRef.current = currentSnapshot;
      return;
    }
    const events = newMessageAttentionEvents({
      previous: previousSnapshotRef.current,
      conversations,
    });
    previousSnapshotRef.current = currentSnapshot;
    if (events.length === 0 || !preferences.messages) return;

    const appIsActive = isNativeShell
      ? nativeWindowFocusedRef.current
      : documentHasActivePresentation(document);
    const activeSessionId = activeCanonicalSessionId?.trim() || activeConversationId;
    const transcriptAtLatest = chatTranscriptScrollRef.current
      ? transcriptIsAtLatest(chatTranscriptScrollRef.current)
      : false;
    const qualifyingEvents = events.filter((event) => {
      if (presentedEventIdsRef.current.has(event.eventId)) return false;
      const exactVisibleSession = appIsActive
        && activeNav === 'chats'
        && event.sessionId === activeSessionId
        && transcriptAtLatest;
      return !exactVisibleSession;
    });
    if (qualifyingEvents.length === 0) return;

    qualifyingEvents.forEach((event) => presentedEventIdsRef.current.add(event.eventId));
    savePresentedEventIds(presentedEventIdsRef.current);
    const present = async () => {
      if (isNativeShell) {
        const windowHandle = getCurrentWindow();
        const now = Date.now();
        const requestDockAttention = shouldRequestDockAttention({
          enabled: preferences.dockBounce,
          windowFocused: nativeWindowFocusedRef.current,
          lastRequestedAt: lastBounceAtRef.current,
          now,
          minimumIntervalMs: BOUNCE_BURST_MS,
        });
        const dockAttentionPromise = requestDockAttention
          ? windowHandle.requestUserAttention(UserAttentionType.Informational)
          : Promise.resolve();
        if (requestDockAttention) lastBounceAtRef.current = now;

        const permissionGranted = await isPermissionGranted().catch(() => false);
        const presentationPromises: Promise<unknown>[] = [dockAttentionPromise];
        if (permissionGranted) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            presentationPromises.push(...qualifyingEvents.map((event) => invoke(
              'desktop_show_message_notification',
              {
                request: {
                  title: preferences.previews ? event.title : 'Kordi',
                  body: preferences.previews ? event.previewText : 'New message',
                  sound: preferences.sound,
                  sessionId: event.sessionId,
                  messageId: event.messageId,
                },
              },
            )));
          } catch {
            // Native presentation is best-effort; badge and Dock attention must continue.
          }
        }
        await Promise.allSettled(presentationPromises);
        return;
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        qualifyingEvents.forEach((event) => {
          const notification = new Notification(preferences.previews ? event.title : 'Kordi', {
            body: preferences.previews ? event.previewText : 'New message',
            tag: `kordi-message-${event.eventId}`,
          });
          notification.onclick = () => onOpenSessionRef.current(event.sessionId, event.messageId);
        });
      }
    };
    void present().catch(() => {});
  }, [
    activeCanonicalSessionId,
    activeConversationId,
    activeNav,
    attentionReady,
    chatTranscriptScrollRef,
    conversations,
    isNativeShell,
    preferences.dockBounce,
    preferences.messages,
    preferences.previews,
    preferences.sound,
  ]);
}
