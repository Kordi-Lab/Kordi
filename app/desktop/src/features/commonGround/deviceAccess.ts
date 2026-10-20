import { isMacPlatform } from '@/features/connectors/connectorsClient';
import { invokeDesktop } from '@/lib/desktop';
import type { CgDeviceAccess, CgDeviceStatuses } from './host';
import type { CgDeviceItem, CgDeviceSource } from './types';

/** The Tauri commands that read Calendar and Reminders titles, on the macOS app only. */
export function desktopDeviceAccess(): CgDeviceAccess | null {
  if (typeof window === 'undefined' || typeof window.__TAURI_INTERNALS__ === 'undefined' || !isMacPlatform()) return null;
  return {
    status: () => invokeDesktop<CgDeviceStatuses>('common_ground_device_status'),
    request: (source: CgDeviceSource) => invokeDesktop<CgDeviceStatuses>('common_ground_device_request', { source }),
    titles: (source: CgDeviceSource) => invokeDesktop<CgDeviceItem[]>('common_ground_device_titles', { source }),
  };
}

export function privacySettingsUrl(source: CgDeviceSource): string {
  const pane = source === 'calendar' ? 'Privacy_Calendars' : 'Privacy_Reminders';
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}
