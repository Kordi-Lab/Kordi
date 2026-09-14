import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import manifest from '../src/assets/noto-thumbnails/manifest.json';
import { notoEmojiCatalog } from '../src/features/emoji/notoEmoji';
import { notoThumbnailSheets, notoThumbnailStyle, preloadNotoEmojiThumbnails } from '../src/features/emoji/notoEmojiThumbnails';

test('bundled thumbnails cover the entire catalog with valid sheet coordinates', () => {
  assert.deepEqual(manifest.ids, notoEmojiCatalog.map(emoji => emoji.id));
  assert.equal(manifest.catalogSha256, createHash('sha256').update(readFileSync(new URL('../../../shared/noto-emoji/catalog.json', import.meta.url))).digest('hex'));
  assert.equal(notoThumbnailSheets.length, manifest.sheets.length);
  let totalBytes = 0;
  for (const sheet of notoThumbnailSheets) {
    assert.match(sheet, /atlas-[0-3]\.webp$/);
    totalBytes += statSync(new URL(sheet)).size;
  }
  assert.ok(totalBytes < 2_600_000);
  for (const id of manifest.ids) {
    const style = notoThumbnailStyle(id);
    assert.match(String(style.backgroundImage), /atlas-[0-3]/);
    for (const percent of String(style.backgroundPosition).split(' ')) {
      assert.ok(parseFloat(percent) >= 0 && parseFloat(percent) <= 100);
    }
  }
  assert.throws(() => notoThumbnailStyle('not-an-emoji'), /bundled catalog/);
});

test('startup decodes only the four bundled sheets and reuses the same warmup', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const sources: string[] = [];
  let decodes = 0;
  class ImageStub {
    decoding = '';
    set src(value: string) { sources.push(value); }
    decode() { decodes += 1; return Promise.resolve(); }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: ImageStub });
  try {
    const first = preloadNotoEmojiThumbnails();
    assert.equal(preloadNotoEmojiThumbnails(), first);
    await first;
    assert.deepEqual(sources, notoThumbnailSheets);
    assert.equal(decodes, 4);
    await preloadNotoEmojiThumbnails();
    assert.equal(decodes, 4);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'Image', previous);
    else Reflect.deleteProperty(globalThis, 'Image');
  }
});
