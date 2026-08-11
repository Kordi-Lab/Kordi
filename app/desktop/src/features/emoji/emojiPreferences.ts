import type { EmojiSkinTone } from './emojiCatalog';

const STORAGE_KEY = 'kordi.emoji.preferences.v1';
const RECENT_LIMIT = 32;

export type EmojiPreferences = {
  version: 1;
  recent: string[];
  skinTone: EmojiSkinTone | null;
};

export const DEFAULT_EMOJI_PREFERENCES: EmojiPreferences = {
  version: 1,
  recent: [],
  skinTone: null,
};

function isSkinTone(value: unknown): value is EmojiSkinTone {
  return value === 'light'
    || value === 'mediumLight'
    || value === 'medium'
    || value === 'mediumDark'
    || value === 'dark';
}

export function loadEmojiPreferences(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage): EmojiPreferences {
  if (!storage) return DEFAULT_EMOJI_PREFERENCES;
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Partial<EmojiPreferences> | null;
    return {
      version: 1,
      recent: Array.isArray(parsed?.recent)
        ? [...new Set(parsed.recent.filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, RECENT_LIMIT)
        : [],
      skinTone: isSkinTone(parsed?.skinTone) ? parsed.skinTone : null,
    };
  } catch {
    return DEFAULT_EMOJI_PREFERENCES;
  }
}

export function saveEmojiPreferences(
  preferences: EmojiPreferences,
  storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences are optional when storage is unavailable or full.
  }
}

export function recordRecentEmoji(preferences: EmojiPreferences, unicode: string): EmojiPreferences {
  return {
    ...preferences,
    recent: [unicode, ...preferences.recent.filter((value) => value !== unicode)].slice(0, RECENT_LIMIT),
  };
}
