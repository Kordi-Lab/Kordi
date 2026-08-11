export const EMOJI_CATEGORIES = [
  'recent',
  'smileys',
  'people',
  'animals',
  'food',
  'activities',
  'travel',
  'objects',
  'symbols',
  'flags',
] as const;

export type EmojiCategory = (typeof EMOJI_CATEGORIES)[number];
export type EmojiCatalogCategory = Exclude<EmojiCategory, 'recent'>;
export type EmojiSkinTone = 'light' | 'mediumLight' | 'medium' | 'mediumDark' | 'dark';
export type EmojiLocale = 'en' | 'zh-Hans' | 'ar' | 'es' | 'pt';

export type EmojiAnnotation = {
  name: string;
  keywords: string[];
};

export type EmojiCatalogEntry = {
  unicode: string;
  codepoints: string;
  name: string;
  keywords: string[];
  category: EmojiCatalogCategory;
  subcategory: string;
  emojiVersion: string;
  variants?: Array<{ unicode: string; tone: EmojiSkinTone }>;
  localized: Record<EmojiLocale, EmojiAnnotation>;
};

export type EmojiCatalog = {
  schemaVersion: 1;
  unicodeEmojiVersion: string;
  cldrVersion: string;
  locales: EmojiLocale[];
  entries: EmojiCatalogEntry[];
};

const SUPPORTED_LOCALES = new Set<EmojiLocale>(['en', 'zh-Hans', 'ar', 'es', 'pt']);
let catalogPromise: Promise<EmojiCatalog> | null = null;

export function resolveEmojiLocale(locale: string | null | undefined): EmojiLocale {
  const normalized = String(locale ?? '').trim().replace(/_/g, '-');
  if (SUPPORTED_LOCALES.has(normalized as EmojiLocale)) return normalized as EmojiLocale;
  const language = normalized.split('-', 1)[0]?.toLowerCase();
  if (language === 'zh') return 'zh-Hans';
  if (language === 'ar' || language === 'es' || language === 'pt') return language;
  return 'en';
}

export async function loadEmojiCatalog(): Promise<EmojiCatalog> {
  catalogPromise ??= fetch(new URL('./generated/emoji-catalog-v17.json', import.meta.url))
    .then((response) => {
      if (!response.ok) throw new Error(`Emoji catalog failed to load (${response.status}).`);
      return response.json() as Promise<EmojiCatalog>;
    })
    .then((catalog) => {
      if (catalog.schemaVersion !== 1 || catalog.unicodeEmojiVersion !== '17.0') {
        throw new Error('Emoji catalog version is not supported.');
      }
      return catalog;
    });
  return catalogPromise;
}

function normalizeSearchValue(value: string, locale: EmojiLocale): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase(locale)
    .trim();
}

export function searchEmojiCatalog(
  entries: readonly EmojiCatalogEntry[],
  query: string,
  locale: EmojiLocale,
  limit = 180,
): EmojiCatalogEntry[] {
  const normalizedQuery = normalizeSearchValue(query, locale);
  if (!normalizedQuery) return [];

  const ranked: Array<{ entry: EmojiCatalogEntry; rank: number }> = [];
  for (const entry of entries) {
    const local = entry.localized[locale] ?? entry.localized.en;
    const candidates = [local.name, ...local.keywords, entry.name, ...entry.keywords]
      .map((value) => normalizeSearchValue(value, locale));
    let rank = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate === normalizedQuery) rank = Math.min(rank, 0);
      else if (candidate.startsWith(normalizedQuery)) rank = Math.min(rank, 1);
      else if (candidate.includes(normalizedQuery)) rank = Math.min(rank, 2);
    }
    if (Number.isFinite(rank)) ranked.push({ entry, rank });
  }

  ranked.sort((left, right) => left.rank - right.rank || left.entry.name.localeCompare(right.entry.name));
  return ranked.slice(0, limit).map(({ entry }) => entry);
}

export function emojiForSkinTone(entry: EmojiCatalogEntry, tone: EmojiSkinTone | null): string {
  if (!tone) return entry.unicode;
  return entry.variants?.find((variant) => variant.tone === tone)?.unicode ?? entry.unicode;
}
