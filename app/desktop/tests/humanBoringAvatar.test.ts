import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalAvatarImageUrl,
  generatedAvatarMarker,
  generatedAvatarPreviewUrl,
  HUMAN_CANONICAL_AVATAR_STYLE,
} from '../src/features/cloud/canonicalAvatar';

test('human defaults and randomizations use the saved seed in Boring Marble', () => {
  for (const seed of ['acct_123', 'randomized_seed']) {
    const marker = generatedAvatarMarker(HUMAN_CANONICAL_AVATAR_STYLE, seed, 4);
    const url = canonicalAvatarImageUrl(marker);
    assert.ok(url?.endsWith(`/v1/avatars/preview/boring-marble-v1/${seed}.png`));
    assert.equal(url, generatedAvatarPreviewUrl(HUMAN_CANONICAL_AVATAR_STYLE, seed));
    assert.equal(url, canonicalAvatarImageUrl(marker.replace('version=4', 'version=5')));
  }
  assert.notEqual(
    generatedAvatarPreviewUrl(HUMAN_CANONICAL_AVATAR_STYLE, 'acct_123'),
    generatedAvatarPreviewUrl(HUMAN_CANONICAL_AVATAR_STYLE, 'randomized_seed'),
  );
});

test('resolved Lorelei URLs use Marble on the original API origin', () => {
  for (const renderer of ['preview', 'dicebear-rust-10.6.0-styles-10.5.0']) {
    assert.equal(
      canonicalAvatarImageUrl(`https://avatars.example/api/v1/avatars/${renderer}/lorelei/acct_123.png?v=4`),
      'https://avatars.example/api/v1/avatars/preview/boring-marble-v1/acct_123.png',
    );
  }
});

test('photos, new Marble URLs, and invalid legacy seeds are untouched', () => {
  for (const source of [
    'data:image/png;base64,avatar',
    'https://photos.example/profile.png',
    'https://avatars.example/v1/avatars/assets/ava_0123456789abcdef0123456789abcdef/256.jpg',
    'https://avatars.example/v1/avatars/preview/boring-marble-v1/acct_123.png',
    'https://avatars.example/v1/avatars/preview/lorelei/bad%20seed.png',
  ]) assert.equal(canonicalAvatarImageUrl(source), source);
  assert.equal(generatedAvatarPreviewUrl(HUMAN_CANONICAL_AVATAR_STYLE, 'bad seed'), null);
});
