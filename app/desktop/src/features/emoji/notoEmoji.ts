import catalogPayload from '../../../../../shared/noto-emoji/catalog.json';
import { emojiGraphemeSegments } from './emojiText';

export type NotoEmoji = {
  id: string;
  value: string;
  name: string;
  keywords: string[];
  category: string;
};

export type NotoEmojiFormat = 'png' | 'webp' | 'gif';

export const NOTO_EMOJI_CDN_ORIGIN = 'https://fonts.gstatic.com';
export const notoEmojiCatalog = Object.freeze(
  (catalogPayload.emoji as NotoEmoji[]).map((emoji) => Object.freeze(emoji)),
);
export const notoEmojiById = new Map(notoEmojiCatalog.map((emoji) => [emoji.id, emoji]));
export const notoEmojiByValue = new Map(notoEmojiCatalog.map((emoji) => [emoji.value, emoji]));

export function notoEmojiAssetUrl(emoji: NotoEmoji, format: NotoEmojiFormat) {
  const catalogEmoji = notoEmojiById.get(emoji.id);
  if (!catalogEmoji || catalogEmoji.value !== emoji.value) {
    throw new Error('Noto Emoji asset must come from the bundled catalog.');
  }
  return `${NOTO_EMOJI_CDN_ORIGIN}/s/e/notoemoji/latest/${emoji.id}/512.${format}`;
}

export function notoEmojiRanges(value: string) {
  return emojiGraphemeSegments(value).flatMap(({ index, segment }) => {
    const emoji = notoEmojiByValue.get(segment);
    return emoji ? [{ emoji, start: index, end: index + segment.length }] : [];
  });
}
