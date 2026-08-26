import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { showNativeNotification } from '@/features/notifications/nativeNotifications';
import { readNotificationPreferences } from '@/features/notifications/notificationPreferences';

export function notifyBackgroundSessionCompletion(turn: DesktopChatTurnSnapshot, isNativeShell: boolean) {
  if (typeof window === 'undefined') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  const preferences = readNotificationPreferences();
  if (!preferences.messages) return;

  const title = turn.succeeded
    ? 'Kordi: Background session finished'
    : turn.status === 'cancelled'
      ? 'Kordi: Background session stopped'
      : 'Kordi: Background session needs attention';

  if (isNativeShell) {
    void showNativeNotification({
      title,
      body: 'Open Kordi to review the update.',
      sound: preferences.sound,
      sessionId: turn.sessionId,
      messageId: turn.transcriptEntryId?.trim() || turn.id,
    }).catch(() => {});
    return;
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  new Notification(title, {
    body: 'Open Kordi to review the update.',
    tag: `kordi-session-${turn.sessionId}`,
  });
}
