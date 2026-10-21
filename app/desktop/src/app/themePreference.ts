import type { ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';

export const KORDI_THEME_MODE_STORAGE_KEY = 'kordi.themeMode.v1';
export const KORDI_CHAT_THEME_STORAGE_KEY = 'kordi.chatTheme.v2';
/** Pre-Classic key; 'quiet' there was the old implicit default, so it migrates to 'classic'. */
export const KORDI_CHAT_THEME_LEGACY_STORAGE_KEY = 'kordi.chatTheme.v1';
export const KORDI_CHAT_THEMES = ['classic', 'quiet', 'midnight', 'sand', 'ocean'] as const;
export type ChatTheme = (typeof KORDI_CHAT_THEMES)[number];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'auto';
}

export function isChatTheme(value: unknown): value is ChatTheme {
  return value === 'classic' || value === 'quiet' || value === 'midnight' || value === 'sand' || value === 'ocean';
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

export function migrateLegacyChatTheme(value: string | null | undefined): ChatTheme {
  if (value === 'quiet') return 'classic';
  return isChatTheme(value) ? value : 'classic';
}

export function readStoredChatTheme(
  storage: Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>> | undefined = browserStorage(),
): ChatTheme {
  try {
    const value = storage?.getItem(KORDI_CHAT_THEME_STORAGE_KEY);
    if (value !== null && value !== undefined) return isChatTheme(value) ? value : 'classic';
    const migrated = migrateLegacyChatTheme(storage?.getItem(KORDI_CHAT_THEME_LEGACY_STORAGE_KEY));
    if (typeof storage?.setItem === 'function') {
      try {
        storage.setItem(KORDI_CHAT_THEME_STORAGE_KEY, migrated);
      } catch {
        // Ignore write failures; the migration simply runs again next launch.
      }
    }
    return migrated;
  } catch {
    return 'classic';
  }
}

export function writeStoredChatTheme(
  theme: ChatTheme,
  storage: Pick<Storage, 'setItem'> | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(KORDI_CHAT_THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore unavailable localStorage; the applied theme remains correct for this window.
  }
}

export function applyChatTheme(theme: ChatTheme): void {
  if (typeof document === 'undefined') return;
  document.body.dataset.kordiChatTheme = theme;
}
