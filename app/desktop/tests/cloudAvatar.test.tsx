import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_PIXEL_AVATAR_URL_PREFIX,
  cloudAvatarImageUrl,
  cloudAvatarSeedForAccount,
  cloudAvatarSeedFromUrl,
  resolveCloudLocalProfileAvatar,
} from '../src/features/cloud/avatar';

test('cloud pixel avatar urls become shared generated avatar seeds', () => {
  const url = `${CLOUD_PIXEL_AVATAR_URL_PREFIX}cloud-signup:avatar-1`;

  assert.equal(cloudAvatarSeedFromUrl(url), 'cloud-signup:avatar-1');
  assert.equal(cloudAvatarSeedForAccount('acct_peer', url), 'cloud-signup:avatar-1');
  assert.equal(cloudAvatarImageUrl(url), null);
});

test('cloud uploaded avatar urls remain image urls and fall back to account seed', () => {
  const url = 'data:image/jpeg;base64,abc123';

  assert.equal(cloudAvatarSeedFromUrl(url), null);
  assert.equal(cloudAvatarSeedForAccount('acct_peer', url), 'acct_peer');
  assert.equal(cloudAvatarImageUrl(url), url);
});

test('cloud local profile avatar ignores canonical generated seeds for provider image avatars', () => {
  const url = 'https://lh3.googleusercontent.com/a/provider-avatar';

  const resolved = resolveCloudLocalProfileAvatar({
    accountId: 'acct_provider',
    avatarUrl: url,
    canonicalAvatarSeed: 'random-local-human-profile-seed',
    canonicalProfileImageUrl: null,
  });

  assert.equal(resolved.seed, 'acct_provider');
  assert.equal(resolved.imageUrl, url);
  assert.equal(resolved.shouldPersistSeed, false);
});

test('cloud local profile avatar persists email signup pixel avatar seeds only', () => {
  const resolved = resolveCloudLocalProfileAvatar({
    accountId: 'acct_email',
    avatarUrl: `${CLOUD_PIXEL_AVATAR_URL_PREFIX}cloud-signup:stable-once`,
    canonicalAvatarSeed: 'random-local-human-profile-seed',
    canonicalProfileImageUrl: 'https://example.com/local-stale.png',
  });

  assert.equal(resolved.seed, 'cloud-signup:stable-once');
  assert.equal(resolved.imageUrl, null);
  assert.equal(resolved.shouldPersistSeed, true);
});
