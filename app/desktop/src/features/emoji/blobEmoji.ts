import catalogPayload from '../../../../../shared/blob-emoji/catalog.json';
import { cloudApiBaseUrl } from '@/features/cloud/cloudApiEnvironment';

export type BlobEmoji = {
  id: string;
  file: string;
  animated: boolean;
  sizeBytes: number;
  sha256: string;
};

export const blobEmojiCatalog = Object.freeze(
  (catalogPayload.emoji as BlobEmoji[]).map((emoji) => Object.freeze(emoji)),
);
export const blobEmojiById = new Map(blobEmojiCatalog.map((emoji) => [emoji.id, emoji]));
export const BLOB_EMOJI_RECENTS_KEY = 'kordi.blob-emoji.recents';
const blobEmojiInlineTokenPattern = /:blob:([A-Za-z0-9_-]+):/gu;

export type BlobEmojiTextPart =
  | { type: 'text'; value: string }
  | { type: 'emoji'; emoji: BlobEmoji; token: string };

export function blobEmojiAssetUrl(emoji: BlobEmoji, baseUrl = cloudApiBaseUrl()) {
  return new URL(
    `/assets/blob-emoji/${emoji.sha256}/${encodeURIComponent(emoji.file)}`,
    baseUrl,
  ).toString();
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

export function blobEmojiTextParts(value: string): BlobEmojiTextPart[] {
  const parts: BlobEmojiTextPart[] = [];
  let cursor = 0;
  for (const match of value.matchAll(blobEmojiInlineTokenPattern)) {
    const emoji = blobEmojiById.get(match[1]);
    if (!emoji) continue;
    if (match.index > cursor) parts.push({ type: 'text', value: value.slice(cursor, match.index) });
    parts.push({ type: 'emoji', emoji, token: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) });
  return parts.length > 0 ? parts : [{ type: 'text', value }];
}

export function blobEmojiPlainText(value: string) {
  return blobEmojiTextParts(value)
    .map((part) => part.type === 'emoji' ? 'Emoji' : part.value)
    .join('');
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
