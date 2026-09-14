import assert from 'node:assert/strict';
import test from 'node:test';
import { notoEmojiAssetUrl, notoEmojiCatalog } from '../src/features/emoji/notoEmoji';
import {
  clearRemoteAvatarImageCacheForTests,
  getRemoteImageSnapshot,
  loadRemoteImageThroughNativeProxy,
} from '../src/kordi-app/components/remoteAvatarImage';

test('the full Noto thumbnail catalog stays warm independently of avatar and animation churn', async () => {
  clearRemoteAvatarImageCacheForTests();
  let calls = 0;
  const invoke = async <T>() => { calls += 1; return 'data:image/png;base64,dGVzdA==' as T; };
  const urls = notoEmojiCatalog.map(emoji => notoEmojiAssetUrl(emoji, 'png', 128));
  for (const url of urls) await loadRemoteImageThroughNativeProxy(url, {}, invoke);
  for (let i = 0; i < 200; i += 1) {
    await loadRemoteImageThroughNativeProxy(`https://images.example/avatar-${i}.png`, {}, invoke);
    await loadRemoteImageThroughNativeProxy(notoEmojiAssetUrl(notoEmojiCatalog[i], 'webp'), {}, invoke);
  }
  const beforeReopen = calls;
  for (const url of urls) {
    assert.equal(getRemoteImageSnapshot(url).status, 'ready');
    await loadRemoteImageThroughNativeProxy(url, {}, invoke);
  }
  assert.equal(calls, beforeReopen, 'reopening the catalog must issue zero native requests');
  clearRemoteAvatarImageCacheForTests();
});

test('the Noto thumbnail cache remains byte bounded', async () => {
  clearRemoteAvatarImageCacheForTests();
  const invoke = async <T>() => `data:image/png;base64,${'a'.repeat(1_000_000)}` as T;
  const urls = notoEmojiCatalog.slice(0, 20).map(emoji => notoEmojiAssetUrl(emoji, 'png', 128));
  for (const url of urls) await loadRemoteImageThroughNativeProxy(url, {}, invoke);
  assert.equal(getRemoteImageSnapshot(urls[0]).status, 'idle');
  assert.equal(getRemoteImageSnapshot(urls.at(-1)!).status, 'ready');
  clearRemoteAvatarImageCacheForTests();
});
