import type { ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';

export const KORDI_THEME_MODE_STORAGE_KEY = 'kordi.themeMode.v1';
export const KORDI_CHAT_THEME_STORAGE_KEY = 'kordi.chatTheme.v1';
export const KORDI_CHAT_THEMES = ['quiet', 'midnight', 'sand', 'ocean'] as const;
export type ChatTheme = (typeof KORDI_CHAT_THEMES)[number];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'auto';
}

export function isChatTheme(value: unknown): value is ChatTheme {
  return value === 'quiet' || value === 'midnight' || value === 'sand' || value === 'ocean';
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

export function readStoredChatTheme(
  storage: Pick<Storage, 'getItem'> | undefined = browserStorage(),
): ChatTheme {
  try {
    const value = storage?.getItem(KORDI_CHAT_THEME_STORAGE_KEY);
    return isChatTheme(value) ? value : 'quiet';
  } catch {
    return 'quiet';
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
