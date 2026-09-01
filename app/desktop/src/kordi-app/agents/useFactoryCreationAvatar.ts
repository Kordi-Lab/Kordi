import { useState } from 'react';
import {
  AGENT_CANONICAL_AVATAR_STYLE,
  generatedAvatarPreviewUrl,
  newCanonicalAvatarSeed,
  type CanonicalAvatarMutation,
} from '@/features/cloud/canonicalAvatar';

type FactoryCreationAvatar = {
  imageUrl: string;
  mutation?: CanonicalAvatarMutation;
};

export function randomFactoryCreationAvatar(seed = newCanonicalAvatarSeed()): FactoryCreationAvatar | null {
  const imageUrl = generatedAvatarPreviewUrl(AGENT_CANONICAL_AVATAR_STYLE, seed);
  return imageUrl ? { imageUrl, mutation: { action: 'regenerate', seed } } : null;
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
  const randomize = () => {
    const avatar = randomFactoryCreationAvatar();
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
