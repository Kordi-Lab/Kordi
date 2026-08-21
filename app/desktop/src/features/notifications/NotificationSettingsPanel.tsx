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
        'relative h-6 w-10 shrink-0 rounded-full border outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[var(--app-quiet-control-focus-ring)] focus-visible:ring-offset-2',
        enabled
          ? 'border-[color:var(--app-sidebar-accent)] bg-[color:var(--app-sidebar-accent)]'
          : 'border-[color:var(--app-control-border)] bg-[color:var(--app-control-bg)] hover:bg-[color:var(--app-control-hover)]',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none',
          enabled ? 'translate-x-[18px]' : 'translate-x-0',
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
    <div className="max-w-[620px]">
      <div className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-y border-[color:var(--app-divider)] px-2 py-3.5">
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
      <section className="mt-6" aria-labelledby="notification-preferences-heading">
        <h2 id="notification-preferences-heading" className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
          Preferences
        </h2>
        <div className="mt-2 divide-y divide-[color:var(--app-divider)] border-y border-[color:var(--app-divider)]">
          {preferenceRows
            .filter((row) => !row.nativeOnly || isNativeShell)
            .map((row) => (
              <div
                key={row.key}
                className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-2 py-3.5"
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
      </section>
    </div>
  );
}
