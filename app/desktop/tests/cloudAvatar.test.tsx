import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_PIXEL_AVATAR_URL_PREFIX,
  cloudAvatarImageUrl,
  cloudAvatarSeedForAccount,
  cloudAvatarSeedFromUrl,
} from '../src/features/cloud/avatar';
import {
  generatedAvatarMarker,
  HUMAN_CANONICAL_AVATAR_STYLE,
} from '../src/features/cloud/canonicalAvatar';

test('cloud pixel avatar urls are treated as legacy non-image values', () => {
  const url = `${CLOUD_PIXEL_AVATAR_URL_PREFIX}cloud-signup:avatar-1`;

  assert.equal(cloudAvatarSeedFromUrl(url), null);
  assert.equal(cloudAvatarSeedForAccount('acct_peer', url), 'acct_peer');
  assert.equal(cloudAvatarImageUrl(url), null);
});

test('cloud uploaded avatar urls remain image urls and fall back to account seed', () => {
  const url = 'data:image/jpeg;base64,abc123';

  assert.equal(cloudAvatarSeedFromUrl(url), null);
  assert.equal(cloudAvatarSeedForAccount('acct_peer', url), 'acct_peer');
  assert.equal(cloudAvatarImageUrl(url), url);
});

test('regenerating a canonical avatar uses the new canonical seed', () => {
  const url = generatedAvatarMarker(HUMAN_CANONICAL_AVATAR_STYLE, 'randomized_seed', 2);
  assert.equal(cloudAvatarSeedFromUrl(url), 'randomized_seed');
  assert.equal(cloudAvatarSeedForAccount('acct_peer', url), 'randomized_seed');
});
