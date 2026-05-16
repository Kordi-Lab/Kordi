export const CLOUD_PIXEL_AVATAR_URL_PREFIX = 'kordi-pixel-avatar://';

export function cloudAvatarSeedFromUrl(_avatarUrl: string | null | undefined): string | null {
  return null;
}

export function cloudAvatarImageUrl(avatarUrl: string | null | undefined): string | null {
  const trimmed = avatarUrl?.trim();
  if (!trimmed || trimmed.startsWith(CLOUD_PIXEL_AVATAR_URL_PREFIX)) return null;
  return trimmed;
}

export function cloudAvatarSeedForAccount(
  accountId: string | null | undefined,
  _avatarUrl: string | null | undefined,
): string {
  return accountId?.trim() || 'cloud-account';
}

export function resolveCloudLocalProfileAvatar({
  accountId,
  avatarUrl,
  canonicalAvatarSeed,
  canonicalProfileImageUrl,
}: {
  accountId: string | null | undefined;
  avatarUrl: string | null | undefined;
  canonicalAvatarSeed?: string | null;
  canonicalProfileImageUrl?: string | null;
}): { seed: string | null; imageUrl: string | null; shouldPersistSeed: boolean } {
  const imageUrl = cloudAvatarImageUrl(avatarUrl);
  if (imageUrl) {
    return { seed: accountId?.trim() || null, imageUrl, shouldPersistSeed: false };
  }

  return {
    seed: accountId?.trim() || canonicalAvatarSeed?.trim() || null,
    imageUrl: canonicalProfileImageUrl?.trim() || null,
    shouldPersistSeed: false,
  };
}
