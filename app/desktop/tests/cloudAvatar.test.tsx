import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_PIXEL_AVATAR_URL_PREFIX,
  cloudAvatarImageUrl,
  cloudAvatarSeedForAccount,
  cloudAvatarSeedFromUrl,
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
