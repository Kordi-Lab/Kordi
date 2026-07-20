import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  clearRemoteAvatarImageCacheForTests,
  getRemoteAvatarImageCacheStatsForTests,
  loadAvatarThroughNativeProxy,
  shouldLoadAvatarThroughNativeProxy,
} from '../src/kordi-app/components/remoteAvatarImage';

test('native desktop routes remote HTTPS avatars through its proxy-aware image loader', () => {
  assert.equal(shouldLoadAvatarThroughNativeProxy('https://images.example/avatar.png', true), true);
  assert.equal(shouldLoadAvatarThroughNativeProxy('data:image/png;base64,avatar', true), false);
  assert.equal(shouldLoadAvatarThroughNativeProxy('https://images.example/avatar.png', false), false);
});

test('remote avatar image requests share one native load per URL', async () => {
  clearRemoteAvatarImageCacheForTests();
  const calls: Array<{ command: string; url: unknown }> = [];
  const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, url: args?.url });
    return 'data:image/png;base64,avatar' as T;
  };

  const first = loadAvatarThroughNativeProxy(' https://images.example/avatar.png ', invoke);
  const second = loadAvatarThroughNativeProxy('https://images.example/avatar.png', invoke);

  assert.equal(await first, 'data:image/png;base64,avatar');
  assert.equal(await second, 'data:image/png;base64,avatar');
  assert.deepEqual(calls, [{
    command: 'desktop_fetch_remote_image_data_url',
    url: 'https://images.example/avatar.png',
  }]);
});

test('failed remote avatar image requests can be retried', async () => {
  clearRemoteAvatarImageCacheForTests();
  let attempts = 0;
  const invoke = async <T,>(): Promise<T> => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    return 'data:image/png;base64,recovered' as T;
  };

  await assert.rejects(loadAvatarThroughNativeProxy('https://images.example/retry.png', invoke));
  assert.equal(
    await loadAvatarThroughNativeProxy('https://images.example/retry.png', invoke),
    'data:image/png;base64,recovered',
  );
  assert.equal(attempts, 2);
});

test('native avatar failures do not authorize a renderer-side URL fallback', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/IdentityAvatar.tsx', import.meta.url), 'utf8');

  assert.match(source, /setNativeImage\(\{ source, dataUrl: null \}\)/);
  assert.doesNotMatch(source, /setNativeImage\(\{ source, dataUrl: source \}\)/);
});

test('resolved remote avatars stay within a byte-budgeted LRU cache', async () => {
  clearRemoteAvatarImageCacheForTests();
  const calls = new Map<string, number>();
  const payload = `data:image/png;base64,${'a'.repeat(1_000_000)}`;
  const invoke = async <T,>(_command: string, args?: Record<string, unknown>): Promise<T> => {
    const url = String(args?.url ?? '');
    calls.set(url, (calls.get(url) ?? 0) + 1);
    return payload as T;
  };

  for (let index = 0; index < 32; index += 1) {
    await loadAvatarThroughNativeProxy(`https://images.example/avatar-${index}.png`, invoke);
  }

  const stats = getRemoteAvatarImageCacheStatsForTests();
  assert.ok(stats.totalBytes <= stats.maxBytes);
  assert.ok(stats.entries < 32, 'the byte budget should evict old resolved avatars');

  await loadAvatarThroughNativeProxy('https://images.example/avatar-0.png', invoke);
  assert.equal(calls.get('https://images.example/avatar-0.png'), 2, 'reading an evicted URL should fetch it again');
});

test('a single result larger than the cache budget is returned but not retained', async () => {
  clearRemoteAvatarImageCacheForTests();
  let calls = 0;
  const maxBytes = getRemoteAvatarImageCacheStatsForTests().maxBytes;
  const invoke = async <T,>(): Promise<T> => {
    calls += 1;
    return `data:image/png;base64,${'a'.repeat(Math.floor(maxBytes / 2) + 1)}` as T;
  };

  const url = 'https://images.example/too-large-to-cache.png';
  await loadAvatarThroughNativeProxy(url, invoke);
  await loadAvatarThroughNativeProxy(url, invoke);

  assert.equal(calls, 2);
  assert.equal(getRemoteAvatarImageCacheStatsForTests().entries, 0);
});
