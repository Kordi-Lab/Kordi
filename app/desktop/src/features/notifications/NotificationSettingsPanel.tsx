import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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

  return (
    <div className="max-w-[620px]">
      <div className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-y border-[color:var(--app-divider)] px-2 py-3.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-white">{permissionTitle}</div>
          <div aria-live="polite" className="mt-1 text-[12px] leading-5 text-slate-400">{permissionDescription}</div>
        </div>
        {permission !== 'granted' && permission !== 'checking' ? (
          <Button
            type="button"
            variant={permission === 'default' ? 'default' : 'quiet'}
            className="h-9 shrink-0 rounded-full px-4 text-[12px]"
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
