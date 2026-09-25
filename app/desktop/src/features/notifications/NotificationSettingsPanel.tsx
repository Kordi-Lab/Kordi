import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import {
  setNotificationPreference,
  useNotificationPreferences,
  type NotificationPreferences,
} from './notificationPreferences';
import {
  nativeNotificationPermissionState,
  requestNativeNotificationPermission,
} from './nativeNotifications';

type NotificationPermissionState = NotificationPermission | 'checking' | 'unavailable';

const preferenceRows: Array<{
  key: keyof NotificationPreferences;
  label: string;
  description: string;
  nativeOnly?: boolean;
}> = [
  {
    key: 'messages',
    label: 'Message notifications',
    description: 'Show an alert when a new message needs your attention.',
  },
  {
    key: 'sound',
    label: 'Notification sound',
    description: 'Play the system notification sound for message alerts.',
  },
  {
    key: 'previews',
    label: 'Message previews',
    description: 'Include the sender and a short message preview in alerts.',
  },
  {
    key: 'badge',
    label: 'Dock badge',
    description: 'Show the total unread count on the Kordi Dock icon.',
    nativeOnly: true,
  },
  {
    key: 'dockBounce',
    label: 'Dock attention',
    description: 'Bounce the Dock icon once when Kordi is in the background.',
    nativeOnly: true,
  },
];

export function NotificationSettingsPanel({ isNativeShell }: { isNativeShell: boolean }) {
  const preferences = useNotificationPreferences();
  const [permission, setPermission] = useState<NotificationPermissionState>('checking');
  const [isUpdatingPermission, setIsUpdatingPermission] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (isNativeShell) {
        const nativePermission = await nativeNotificationPermissionState().catch(() => 'unavailable' as const);
        if (!cancelled) setPermission(nativePermission);
        return;
      }
      if (typeof Notification === 'undefined') {
        if (!cancelled) setPermission('unavailable');
        return;
      }
      if (!cancelled) setPermission(Notification.permission);
    };
    const refreshOnFocus = () => {
      void refresh();
    };
    void refresh();
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [isNativeShell]);

  const enableNotifications = async () => {
    setIsUpdatingPermission(true);
    try {
      if (isNativeShell) {
        setPermission(await requestNativeNotificationPermission());
      } else if (typeof Notification !== 'undefined') {
        setPermission(await Notification.requestPermission());
      }
    } catch {
      setPermission('unavailable');
    } finally {
      setIsUpdatingPermission(false);
    }
  };

  const openSystemSettings = () => {
    void invoke('desktop_open_external_url', {
      url: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    });
  };

  const permissionTitle = permission === 'granted'
    ? 'Notifications are allowed'
    : permission === 'denied'
      ? 'Notifications are blocked'
      : permission === 'checking'
        ? 'Checking notification access'
        : permission === 'unavailable'
          ? 'Notification access unavailable'
          : isNativeShell ? 'Allow notifications on this Mac' : 'Allow notifications in your browser';
  const permissionDescription = permission === 'granted'
    ? 'Kordi can alert you when new messages arrive while the app is in the background.'
    : permission === 'denied'
      ? isNativeShell
        ? 'Open System Settings and allow notifications for Kordi.'
        : 'Allow notifications for Kordi in your browser settings.'
      : permission === 'checking'
        ? 'Kordi is checking your notification setting.'
        : permission === 'unavailable'
          ? `Try again to check the ${isNativeShell ? 'macOS' : 'browser'} notification setting.`
          : 'Allow banners and sounds so Kordi can alert you when new messages arrive in the background.';

  const permissionAction = permission !== 'granted' && permission !== 'checking' ? (
    <Button
      type="button"
      variant={permission === 'default' ? 'default' : 'quiet'}
      className="h-8 shrink-0 rounded-lg px-3.5 text-[12px]"
      onClick={permission === 'denied' && isNativeShell ? openSystemSettings : enableNotifications}
      disabled={isUpdatingPermission}
    >
      {isUpdatingPermission
        ? 'Requesting…'
        : permission === 'denied' && isNativeShell
          ? 'Open System Settings'
          : permission === 'unavailable'
            ? 'Check again'
            : 'Allow notifications'}
    </Button>
  ) : null;

  return (
    <div className="app-notification-settings">
      <SettingsSection title="Notification access">
        <SettingsRow
          title={permissionTitle}
          description={<span aria-live="polite">{permissionDescription}</span>}
          control={permissionAction}
        />
      </SettingsSection>
      <SettingsSection title="Preferences">
        {preferenceRows
          .filter((row) => !row.nativeOnly || isNativeShell)
          .map((row) => (
            <SettingsRow
              key={row.key}
              title={row.label}
              description={row.description}
              control={(
                <SettingsSwitch
                  enabled={preferences[row.key]}
                  label={row.label}
                  onChange={(enabled) => setNotificationPreference(row.key, enabled)}
                />
              )}
            />
          ))}
      </SettingsSection>
    </div>
  );
}
