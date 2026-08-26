import { invoke } from '@tauri-apps/api/core';

export type NativeNotificationRequest = {
  title: string;
  body: string;
  sound: boolean;
  sessionId: string;
  messageId: string;
};

export function nativeNotificationPermissionState() {
  return invoke<NotificationPermission>('desktop_notification_permission_state');
}

export function requestNativeNotificationPermission() {
  return invoke<NotificationPermission>('desktop_request_notification_permission');
}

export function showNativeNotification(request: NativeNotificationRequest) {
  return invoke<void>('desktop_show_message_notification', { request });
}
