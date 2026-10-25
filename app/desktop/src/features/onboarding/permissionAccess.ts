import { invokeDesktop, isNativeDesktopShell, openDesktopExternalUrl } from '@/lib/desktop';
import { isMacPlatform } from '@/features/connectors/connectorsClient';
import { nativeNotificationPermissionState, requestNativeNotificationPermission } from '@/features/notifications/nativeNotifications';
import { desktopDeviceAccess, privacySettingsUrl } from '@/features/commonGround/deviceAccess';

export type PermissionId = 'notifications' | 'microphone' | 'camera' | 'speech' | 'calendar' | 'reminders';
export type PermissionStatus = 'allowed' | 'not-requested' | 'denied' | 'restricted' | 'unavailable' | 'unknown';
export type PermissionDefinition = { id: PermissionId; name: string; description: string; settingsPane?: string };
export const permissionDefinitions: readonly PermissionDefinition[] = [
  { id: 'notifications', name: 'Notifications', description: 'Alerts for new messages. Sound and previews are configured separately in Notifications settings.' },
  { id: 'microphone', name: 'Microphone', description: 'Voice messages and audio calls. Allowing access here does not start a recording.', settingsPane: 'Privacy_Microphone' },
  { id: 'camera', name: 'Camera', description: 'Video messages and calls. Allowing access here does not start a call or send video.', settingsPane: 'Privacy_Camera' },
  { id: 'speech', name: 'Speech recognition', description: 'Transcription of voice messages on this Mac.', settingsPane: 'Privacy_SpeechRecognition' },
  { id: 'calendar', name: 'Calendar', description: 'Calendar features and an optional source for cards. Choose sources and calendar sync separately.' },
  { id: 'reminders', name: 'Reminders', description: 'An optional source for cards. Granting access does not select it for a build.' },
];

export function normalizePermission(value: string): PermissionStatus {
  if (value === 'granted' || value === 'allowed') return 'allowed';
  if (value === 'default' || value === 'prompt' || value === 'not_determined') return 'not-requested';
  if (value === 'denied' || value === 'restricted' || value === 'unavailable') return value;
  return 'unknown';
}

export const permissionStatusLabels: Record<PermissionStatus, string> = {
  allowed: 'Allowed', 'not-requested': 'Not requested', denied: 'Access is off', restricted: 'Restricted by this device',
  unavailable: 'Unavailable on this device', unknown: 'Could not check access',
};

export function permissionAction(status: PermissionStatus, settingsAvailable: boolean) {
  if (status === 'not-requested') return 'Allow';
  if (status === 'unavailable' || status === 'restricted') return null;
  if (status === 'unknown') return 'Check again';
  return settingsAvailable ? 'Open Settings' : null;
}

export function nativeMacPermissions() { return isNativeDesktopShell() && isMacPlatform(); }

export async function readHelpPermission(id: PermissionId): Promise<PermissionStatus> {
  if (id === 'notifications') {
    if (isNativeDesktopShell()) return normalizePermission(await nativeNotificationPermissionState());
    return typeof Notification === 'undefined' ? 'unavailable' : normalizePermission(Notification.permission);
  }
  if (id === 'calendar' || id === 'reminders') {
    const access = desktopDeviceAccess();
    return access ? normalizePermission((await access.status())[id]) : 'unavailable';
  }
  if (nativeMacPermissions()) {
    return normalizePermission(await invokeDesktop<string>('desktop_media_permission', { source: id, request: false }));
  }
  if (id === 'speech') return 'unavailable';
  if (!navigator.mediaDevices?.getUserMedia) return 'unavailable';
  // Querying does not activate hardware. Unsupported browser queries stay unknown.
  return normalizePermission((await navigator.permissions.query({ name: id })).state);
}

export async function requestHelpPermission(id: PermissionId): Promise<void> {
  if (id === 'notifications') {
    if (isNativeDesktopShell()) await requestNativeNotificationPermission();
    else if (typeof Notification !== 'undefined') await Notification.requestPermission();
    return;
  }
  if (id === 'calendar' || id === 'reminders') {
    const access = desktopDeviceAccess();
    if (!access) throw new Error('This permission is available in the Mac app.');
    await access.request(id);
    return;
  }
  if (nativeMacPermissions()) {
    await invokeDesktop<string>('desktop_media_permission', { source: id, request: true });
    return;
  }
  if (id === 'speech') throw new Error('Speech recognition setup is available in the Mac app.');
  const stream = await navigator.mediaDevices.getUserMedia(id === 'camera' ? { video: true } : { audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

export async function openPermissionSettings(definition: PermissionDefinition) {
  if (!nativeMacPermissions()) throw new Error('Use your browser or device settings to manage access for Kordi.');
  const url = definition.id === 'notifications'
    ? 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
    : definition.id === 'calendar' || definition.id === 'reminders'
      ? privacySettingsUrl(definition.id)
      : `x-apple.systempreferences:com.apple.preference.security?${definition.settingsPane}`;
  await openDesktopExternalUrl(url);
}
