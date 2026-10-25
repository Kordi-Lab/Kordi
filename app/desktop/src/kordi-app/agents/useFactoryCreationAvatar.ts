import { useState } from 'react';
import {
  BIRD_CANONICAL_AVATAR_STYLE,
  generatedAvatarPreviewUrl,
  parseGeneratedAvatarMarker,
  type CanonicalAvatarMutation,
} from '@/features/cloud/canonicalAvatar';
import { randomBirdAvatarSeed, structuredBirdAvatarSeed } from '@/features/cloud/birdAvatars';

type FactoryCreationAvatar = {
  imageUrl: string;
  mutation?: CanonicalAvatarMutation;
};

/** A bird avatar for a new or edited agent; any seed becomes the structured seed of the bird it renders as. */
export function randomFactoryCreationAvatar(seed = randomBirdAvatarSeed()): FactoryCreationAvatar | null {
  const birdSeed = structuredBirdAvatarSeed(seed);
  const imageUrl = generatedAvatarPreviewUrl(BIRD_CANONICAL_AVATAR_STYLE, birdSeed);
  return imageUrl ? { imageUrl, mutation: { action: 'regenerate', seed: birdSeed } } : null;
}

export function useFactoryCreationAvatar(draftId: string | null, existingImageUrl?: string | null) {
  const [avatars, setAvatars] = useState<Record<string, FactoryCreationAvatar>>({});
  const setAvatar = (avatar: FactoryCreationAvatar) => {
    if (draftId) setAvatars((current) => ({ ...current, [draftId]: avatar }));
  };
  const upload = (uploadedAsset: string) => setAvatar({
    imageUrl: uploadedAsset,
    mutation: { action: 'upload', uploadedAsset },
  });
  /** Picks the given bird seed, or a random bird without one. */
  const randomize = (seed?: string) => {
    const avatar = randomFactoryCreationAvatar(seed);
    if (avatar) setAvatar(avatar);
  };
  const clearAvatar = () => {
    if (!draftId) return;
    setAvatars((current) => {
      const next = { ...current };
      delete next[draftId];
      return next;
    });
  };
  const avatar = draftId
    ? avatars[draftId] ?? (existingImageUrl === undefined
      ? randomFactoryCreationAvatar(draftId)
      : { imageUrl: existingImageUrl ?? '' })
    : null;
  return { imageUrl: avatar?.imageUrl ?? null, mutation: avatar?.mutation, upload, randomize, clearAvatar };
}

/** The generated seed behind a Factory avatar URL (marker, preview or render URL), else the fallback. */
export function factoryAvatarSeed(imageUrl: string | null | undefined, fallbackSeed?: string | null) {
  const value = imageUrl?.trim() ?? '';
  const markerSeed = parseGeneratedAvatarMarker(value)?.seed;
  if (markerSeed) return markerSeed;
  const urlSeed = /\/v1\/avatars\/(?:[^/]+\/)?(?:kordi-birds|thumbs)\/([A-Za-z0-9_%-]+)\.png/u.exec(value)?.[1];
  try {
    return (urlSeed ? decodeURIComponent(urlSeed) : null) || fallbackSeed?.trim() || null;
  } catch {
    return fallbackSeed?.trim() || null;
  }
}
