import type { ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';

export const KORDI_THEME_MODE_STORAGE_KEY = 'kordi.themeMode.v1';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'auto';
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredThemeMode(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): ThemeMode {
  try {
    const value = storage?.getItem(KORDI_THEME_MODE_STORAGE_KEY);
    return isThemeMode(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeStoredThemeMode(
  mode: ThemeMode,
  storage: Pick<Storage, 'setItem'> | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(KORDI_THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore unavailable localStorage; in-memory React state remains correct.
  }
}

export function resolveThemeMode(themeMode: ThemeMode, systemThemeMode: ResolvedThemeMode): ResolvedThemeMode {
  return themeMode === 'auto' ? systemThemeMode : themeMode;
}
