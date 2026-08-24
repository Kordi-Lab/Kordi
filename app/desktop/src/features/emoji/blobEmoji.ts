import catalogPayload from '../../../../../shared/blob-emoji/catalog.json';

export type BlobEmoji = {
  id: string;
  file: string;
  animated: boolean;
};

export const blobEmojiCatalog = Object.freeze(
  (catalogPayload.emoji as BlobEmoji[]).map((emoji) => Object.freeze(emoji)),
);
export const blobEmojiById = new Map(blobEmojiCatalog.map((emoji) => [emoji.id, emoji]));
export const BLOB_EMOJI_RECENTS_KEY = 'kordi.blob-emoji.recents';

export function blobEmojiAssetUrl(emoji: BlobEmoji) {
  return `/blob-emoji/assets/${encodeURIComponent(emoji.file)}`;
}

export function blobEmojiReactionValue(emoji: BlobEmoji) {
  return `blob:${emoji.id}`;
}

export function blobEmojiFromReaction(value?: string | null) {
  const id = value?.startsWith('blob:') ? value.slice(5) : '';
  return id ? blobEmojiById.get(id) ?? null : null;
}

export function blobEmojiInlineToken(emoji: BlobEmoji) {
  return `:blob:${emoji.id}:`;
}

export function readRecentBlobEmojiIDs(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
  try {
    const values = JSON.parse(storage?.getItem(BLOB_EMOJI_RECENTS_KEY) ?? '[]') as unknown;
    return Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string' && blobEmojiById.has(value)).slice(0, 24)
      : [];
  } catch {
    return [];
  }
}

export function recordRecentBlobEmoji(
  id: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
) {
  if (!blobEmojiById.has(id)) return readRecentBlobEmojiIDs(storage);
  const values = [id, ...readRecentBlobEmojiIDs(storage).filter((value) => value !== id)].slice(0, 24);
  try {
    storage?.setItem(BLOB_EMOJI_RECENTS_KEY, JSON.stringify(values));
  } catch {
    // The in-memory selection still succeeds when storage is unavailable.
  }
  return values;
}
