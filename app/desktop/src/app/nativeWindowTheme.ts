import { getCurrentWindow } from '@tauri-apps/api/window';

import type { ResolvedThemeMode } from '@/kordi-app/types';

export type NativeWindowThemeTarget = {
  setTheme: (theme: ResolvedThemeMode) => Promise<void>;
};

function currentNativeWindow(): NativeWindowThemeTarget | null {
  if (typeof window === 'undefined') return null;
  const runtimeWindow = window as typeof window & { __TAURI_INTERNALS__?: unknown };
  return runtimeWindow.__TAURI_INTERNALS__ ? getCurrentWindow() : null;
}

export function syncNativeWindowTheme(
  theme: ResolvedThemeMode,
  target: NativeWindowThemeTarget | null = currentNativeWindow(),
): Promise<void> {
  return target?.setTheme(theme) ?? Promise.resolve();
}
