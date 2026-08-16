import { invoke } from '@tauri-apps/api/core';
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  setNotificationPreference,
  useNotificationPreferences,
  type NotificationPreferences,
} from './notificationPreferences';

type NotificationPermissionState = NotificationPermission | 'unavailable';

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

function PreferenceToggle({
  enabled,
  label,
  onChange,
}: {
  enabled: boolean;
  label: string;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
      className={cn(
        'relative h-6 w-10 shrink-0 rounded-full border transition-colors',
        enabled
          ? 'border-blue-400/40 bg-blue-500/80'
          : 'border-white/10 bg-white/10',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform',
          enabled ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function NotificationSettingsPanel({ isNativeShell }: { isNativeShell: boolean }) {
  const preferences = useNotificationPreferences();
  const [permission, setPermission] = useState<NotificationPermissionState>('default');

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (isNativeShell) {
        const granted = await isPermissionGranted().catch(() => false);
        const nativePermission = typeof Notification === 'undefined'
          ? 'default'
          : Notification.permission;
        if (!cancelled) {
          setPermission(granted ? 'granted' : nativePermission);
        }
        return;
      }
      if (typeof Notification === 'undefined') {
        if (!cancelled) setPermission('unavailable');
        return;
      }
      if (!cancelled) setPermission(Notification.permission);
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [isNativeShell]);

  const enableNotifications = async () => {
    if (isNativeShell) {
      setPermission(await requestPermission().catch(() => 'denied'));
      return;
    }
    if (typeof Notification !== 'undefined') {
      setPermission(await Notification.requestPermission());
    }
  };

  const openSystemSettings = () => {
    void invoke('desktop_open_external_url', {
      url: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    });
  };

  const permissionLabel = permission === 'granted'
    ? isNativeShell ? 'Allowed by macOS' : 'Allowed by your browser'
    : permission === 'denied'
      ? isNativeShell ? 'Blocked by macOS' : 'Blocked by your browser'
      : permission === 'unavailable'
        ? 'Unavailable'
        : 'Permission not requested';

  return (
    <div className="app-settings-option-list max-w-[680px]">
      <div className="app-settings-option-row flex items-center justify-between gap-5 px-1 py-3.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-white">System permission</div>
          <div className="mt-1 text-[12px] leading-5 text-slate-400">{permissionLabel}</div>
        </div>
        {permission !== 'granted' && permission !== 'unavailable' ? (
          <Button
            type="button"
            variant="quiet"
            className="h-8 shrink-0 rounded-full px-3 text-[12px]"
            onClick={permission === 'denied' && isNativeShell ? openSystemSettings : enableNotifications}
          >
            {permission === 'denied' && isNativeShell ? 'Open System Settings' : 'Enable'}
          </Button>
        ) : null}
      </div>
      {preferenceRows
        .filter((row) => !row.nativeOnly || isNativeShell)
        .map((row) => (
          <div
            key={row.key}
            className="app-settings-option-row flex items-center justify-between gap-5 px-1 py-3.5"
          >
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-white">{row.label}</div>
              <div className="mt-1 text-[12px] leading-5 text-slate-400">{row.description}</div>
            </div>
            <PreferenceToggle
              enabled={preferences[row.key]}
              label={row.label}
              onChange={(enabled) => setNotificationPreference(row.key, enabled)}
            />
          </div>
        ))}
    </div>
  );
}
