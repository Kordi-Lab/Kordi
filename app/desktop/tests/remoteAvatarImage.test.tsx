import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearRemoteAvatarImageCacheForTests,
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
