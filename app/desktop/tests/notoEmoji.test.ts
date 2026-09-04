import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  blobEmojiItems,
  emojiComposerValue,
  emojiReactionValue,
  notoEmojiItems,
  quickReactionEmojiItems,
  readRecentEmojiItems,
  recordRecentEmojiItem,
} from '../src/features/emoji/emojiCatalog';
import { notoEmojiAssetUrl, notoEmojiCatalog } from '../src/features/emoji/notoEmoji';

test('Noto Emoji catalog uses trusted Google Fonts CDN URLs without bundled image assets', () => {
  const catalog = JSON.parse(readFileSync(
    new URL('../../../shared/noto-emoji/catalog.json', import.meta.url),
    'utf8',
  )) as { sourceSha256: string; emoji: Array<{ id: string; value: string }> };

  assert.equal(notoEmojiCatalog.length, 881);
  assert.equal(new Set(notoEmojiCatalog.map((emoji) => emoji.id)).size, 881);
  assert.equal(new Set(notoEmojiCatalog.map((emoji) => emoji.value)).size, 881);
  assert.match(catalog.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(new URL('../../../shared/noto-emoji/assets', import.meta.url)), false);
  assert.equal(
    notoEmojiAssetUrl(notoEmojiCatalog[0], 'webp'),
    `https://fonts.gstatic.com/s/e/notoemoji/latest/${notoEmojiCatalog[0].id}/512.webp`,
  );
  assert.throws(
    () => notoEmojiAssetUrl({ ...notoEmojiCatalog[0], id: '../avatar' }, 'png'),
    /bundled catalog/,
  );
});

test('Recent keeps existing Blob Emoji and records Noto selections in one bounded list', () => {
  const values = new Map<string, string>([['kordi.blob-emoji.recents', '["blobwave"]']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const noto = notoEmojiItems[0];
  const blob = blobEmojiItems.find((item) => item.source === 'blob' && item.emoji.id === 'blobjoy');
  assert.ok(noto);
  assert.ok(blob);

  recordRecentEmojiItem(noto, storage);
  recordRecentEmojiItem(blob, storage);
  const recent = readRecentEmojiItems(storage);

  assert.deepEqual(recent.slice(0, 3).map((item) => item.key), [blob.key, noto.key, 'blob:blobwave']);
  assert.equal(emojiComposerValue(noto), noto.source === 'noto' ? noto.emoji.value : '');
  assert.equal(emojiReactionValue(noto), noto.source === 'noto' ? noto.emoji.value : '');
  assert.equal(quickReactionEmojiItems(storage).length, 6);
});
