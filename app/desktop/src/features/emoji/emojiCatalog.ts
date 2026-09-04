import {
  BLOB_EMOJI_RECENTS_KEY,
  blobEmojiById,
  blobEmojiCatalog,
  blobEmojiInlineToken,
  blobEmojiReactionValue,
  blobEmojiTextParts,
  type BlobEmoji,
} from './blobEmoji';
import {
  notoEmojiById,
  notoEmojiByValue,
  notoEmojiCatalog,
  type NotoEmoji,
} from './notoEmoji';

export type EmojiPickerItem =
  | { source: 'noto'; key: string; storageId: string; name: string; searchText: string; emoji: NotoEmoji }
  | { source: 'blob'; key: string; storageId: string; name: string; searchText: string; emoji: BlobEmoji };

export const notoEmojiItems = Object.freeze(notoEmojiCatalog.map((emoji): EmojiPickerItem => ({
  source: 'noto',
  key: `noto:${emoji.id}`,
  storageId: `noto:${emoji.id}`,
  name: emoji.name,
  searchText: `${emoji.name} ${emoji.keywords.join(' ')} ${emoji.category}`.toLocaleLowerCase(),
  emoji,
})));

export const blobEmojiItems = Object.freeze(blobEmojiCatalog.map((emoji): EmojiPickerItem => ({
  source: 'blob',
  key: `blob:${emoji.id}`,
  storageId: emoji.id,
  name: emoji.id.replace(/_/g, ' '),
  searchText: emoji.id.replace(/_/g, ' ').toLocaleLowerCase(),
  emoji,
})));

const itemByStorageId = new Map([
  ...notoEmojiItems.map((item) => [item.storageId, item] as const),
  ...blobEmojiItems.map((item) => [item.storageId, item] as const),
]);

function storedRecentIds(storage: Pick<Storage, 'getItem'> | null) {
  try {
    const values = JSON.parse(storage?.getItem(BLOB_EMOJI_RECENTS_KEY) ?? '[]') as unknown;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function readRecentEmojiItems(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
) {
  return storedRecentIds(storage).flatMap((id) => itemByStorageId.get(id) ?? []).slice(0, 24);
}

export function recordRecentEmojiItem(
  item: EmojiPickerItem,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
) {
  const ids = [
    item.storageId,
    ...storedRecentIds(storage).filter((id) => id !== item.storageId && itemByStorageId.has(id)),
  ].slice(0, 24);
  try {
    storage?.setItem(BLOB_EMOJI_RECENTS_KEY, JSON.stringify(ids));
  } catch {
    // The in-memory selection still succeeds when storage is unavailable.
  }
  return ids.flatMap((id) => itemByStorageId.get(id) ?? []);
}

export function emojiComposerValue(item: EmojiPickerItem) {
  return item.source === 'noto' ? item.emoji.value : blobEmojiInlineToken(item.emoji);
}

export function emojiReactionValue(item: EmojiPickerItem) {
  return item.source === 'noto' ? item.emoji.value : blobEmojiReactionValue(item.emoji);
}

export function emojiItemFromComposerValue(value: string) {
  const trimmed = value.trim();
  const noto = notoEmojiByValue.get(trimmed);
  if (noto) return itemByStorageId.get(`noto:${noto.id}`) ?? null;
  const parts = blobEmojiTextParts(trimmed);
  return parts.length === 1 && parts[0].type === 'emoji'
    ? itemByStorageId.get(parts[0].emoji.id) ?? null
    : null;
}

export function emojiItemFromReaction(value: string) {
  if (value.startsWith('blob:')) {
    return blobEmojiById.get(value.slice(5))
      ? itemByStorageId.get(value.slice(5)) ?? null
      : null;
  }
  const emoji = notoEmojiByValue.get(value);
  return emoji ? itemByStorageId.get(`noto:${emoji.id}`) ?? null : null;
}

const defaultQuickItems = [
  ...notoEmojiCatalog.slice(0, 3).flatMap((emoji) => itemByStorageId.get(`noto:${emoji.id}`) ?? []),
  ...blobEmojiCatalog.filter((emoji) => !emoji.animated).slice(0, 3).flatMap((emoji) => itemByStorageId.get(emoji.id) ?? []),
];

export function quickReactionEmojiItems(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
) {
  const recent = readRecentEmojiItems(storage);
  const recentKeys = new Set(recent.map((item) => item.key));
  return [...recent, ...defaultQuickItems.filter((item) => !recentKeys.has(item.key))].slice(0, 6);
}

export const representativeNotoEmoji = notoEmojiById.get('1f600') ?? notoEmojiCatalog[0];
export const representativeBlobEmoji = blobEmojiById.get('blobsmile') ?? blobEmojiCatalog[0];
