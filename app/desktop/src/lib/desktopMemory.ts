import { invokeDesktop } from './desktop';

export type DesktopMemorySettings = { memoryEnabled: boolean; excludeSensitive: boolean };

export type DesktopMemorySyncResult = {
  uploaded: number;
  downloaded: number;
  rejected: number;
  settings: DesktopMemorySettings | null;
};

export type DesktopLocalMemory = {
  lessonId: string;
  scope: 'global' | 'conversation' | 'group' | 'project';
  scopeId: string;
  scopeLabel: string | null;
  source: 'user_correction' | 'repeated_failure' | 'outcome' | 'manual';
  text: string;
  createdAt: string;
  updatedAt: string;
  pendingUpload: boolean;
};

/** Memory settings stored on this Mac. */
export function desktopMemorySettings(): Promise<DesktopMemorySettings> {
  return invokeDesktop<DesktopMemorySettings>('desktop_memory_settings');
}

export function desktopMemoryUpdateSettings(patch: Partial<DesktopMemorySettings>): Promise<DesktopMemorySettings> {
  return invokeDesktop<DesktopMemorySettings>('desktop_memory_update_settings', { patch });
}

/** Pulls account memories into the cache on this Mac and uploads pending ones. */
export function desktopMemorySync(): Promise<DesktopMemorySyncResult> {
  return invokeDesktop<DesktopMemorySyncResult>('desktop_memory_sync');
}

export function desktopMemoryListLocal(): Promise<DesktopLocalMemory[]> {
  return invokeDesktop<DesktopLocalMemory[]>('desktop_memory_list_local');
}
