import assert from 'node:assert/strict';
import test from 'node:test';

import {
  avatarDataUrlBlob,
  canonicalAvatarImageSource,
  generatedAvatarMarker,
  generatedAvatarPreviewUrl,
  HUMAN_CANONICAL_AVATAR_STYLE,
  normalizeCanonicalAvatarDescriptor,
  parseGeneratedAvatarMarker,
  parseUploadedAvatarMarker,
} from '../src/features/cloud/canonicalAvatar';

test('canonical avatar image sources come only from the descriptor', () => {
  const generated = {
    entityType: 'agent',
    entityId: 'agent_id',
    source: 'generated' as const,
    style: 'thumbs' as const,
    seed: 'canonical_agent_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: null,
    version: 3,
    updatedAt: '2026-08-19T00:00:00Z',
  };
  assert.equal(
    canonicalAvatarImageSource(generated),
    'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/thumbs/canonical_agent_seed?version=3',
  );
  assert.equal(canonicalAvatarImageSource({
    ...generated,
    source: 'uploaded',
    uploadedAsset: 'data:image/png;base64,avatar',
  }), 'data:image/png;base64,avatar');
});

test('valid avatar preview seeds stay identical across clients', () => {
  assert.equal(
    generatedAvatarPreviewUrl(
      'thumbs',
      'cloud-local-agent',
      'http://srv',
    ),
    'http://srv/v1/avatars/preview/thumbs/cloud-local-agent.png',
  );
});

test('canonical avatar markers preserve the pinned renderer, style, seed, and version', () => {
  const marker = generatedAvatarMarker(HUMAN_CANONICAL_AVATAR_STYLE, 'acct_123', 4);

  assert.deepEqual(parseGeneratedAvatarMarker(marker), {
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    style: 'lorelei',
    seed: 'acct_123',
    version: 4,
  });
});

test('uploaded avatar markers remain small environment-independent references', () => {
  const marker = 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef';

  assert.deepEqual(parseUploadedAvatarMarker(marker), {
    assetId: 'ava_0123456789abcdef0123456789abcdef',
  });
  assert.equal(parseUploadedAvatarMarker('data:image/jpeg;base64,avatar'), null);
});

test('avatar data urls become bounded binary upload bodies', () => {
  const blob = avatarDataUrlBlob('data:image/jpeg;base64,/9j/');

  assert.equal(blob.type, 'image/jpeg');
  assert.equal(blob.size, 3);
});

test('canonical avatar descriptors reject unsupported runtime styles', () => {
  assert.equal(normalizeCanonicalAvatarDescriptor({
    entityType: 'human',
    entityId: 'acct_123',
    source: 'generated',
    style: 'bottts',
    seed: 'acct_123',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: null,
    version: 1,
    updatedAt: '2026-08-17T00:00:00Z',
  }), null);
});

test('signup avatar previews use the configured Kordi API origin', () => {
  assert.equal(
    generatedAvatarPreviewUrl(
      HUMAN_CANONICAL_AVATAR_STYLE,
      'signup_seed',
      'http://127.0.0.1:17081',
    ),
    'http://127.0.0.1:17081/v1/avatars/preview/lorelei/signup_seed.png',
  );
});

test('agent avatar previews use the pinned Thumbs style', () => {
  assert.equal(
    generatedAvatarPreviewUrl('thumbs', 'agent_seed', 'http://srv'),
    'http://srv/v1/avatars/preview/thumbs/agent_seed.png',
  );
});
