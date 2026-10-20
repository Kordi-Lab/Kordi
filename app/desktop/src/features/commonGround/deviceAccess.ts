import { Bell, CalendarDays } from 'lucide-react';

import { isMacPlatform } from '@/features/connectors/connectorsClient';
import { invokeDesktop } from '@/lib/desktop';
import type { CgDeviceAccess, CgDeviceStatuses } from './host';
import type { CgAgentFile, CgDeviceItem, CgDeviceSource } from './types';

export const DEVICE_SOURCES: Array<{ id: CgDeviceSource; name: string; label: string; tone: string; Icon: typeof Bell }> = [
  { id: 'calendar', name: 'Calendar', label: 'Mac Calendar', tone: 'pink', Icon: CalendarDays },
  { id: 'reminders', name: 'Reminders', label: 'Mac Reminders', tone: 'amber', Icon: Bell },
];

function isMacDesktop(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined' && isMacPlatform();
}

/** The Tauri commands that read Calendar and Reminders titles, on the macOS app only. */
export function desktopDeviceAccess(): CgDeviceAccess | null {
  if (!isMacDesktop()) return null;
  return {
    status: () => invokeDesktop<CgDeviceStatuses>('common_ground_device_status'),
    request: (source: CgDeviceSource) => invokeDesktop<CgDeviceStatuses>('common_ground_device_request', { source }),
    titles: (source: CgDeviceSource) => invokeDesktop<CgDeviceItem[]>('common_ground_device_titles', { source }),
  };
}

/** The Tauri command that reads agent instruction and memory files, on the macOS app only. */
export function desktopAgentFiles(): (() => Promise<CgAgentFile[]>) | null {
  if (!isMacDesktop()) return null;
  return () => invokeDesktop<CgAgentFile[]>('common_ground_agent_files');
}

export function privacySettingsUrl(source: CgDeviceSource): string {
  const pane = source === 'calendar' ? 'Privacy_Calendars' : 'Privacy_Reminders';
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}
