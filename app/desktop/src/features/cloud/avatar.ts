import { isBuiltInAccountId, KORDI_SYSTEM_AVATAR_URL } from '@/features/pip/pipIdentity';
import {
  canonicalAvatarImageUrl,
  parseGeneratedAvatarMarker,
} from './canonicalAvatar';

export const CLOUD_PIXEL_AVATAR_URL_PREFIX = 'kordi-pixel-avatar://';

export function cloudAvatarSeedFromUrl(avatarUrl: string | null | undefined): string | null {
  return parseGeneratedAvatarMarker(avatarUrl)?.seed ?? null;
}

export function cloudAvatarImageUrl(avatarUrl: string | null | undefined): string | null {
  const trimmed = avatarUrl?.trim();
  if (!trimmed || trimmed.startsWith(CLOUD_PIXEL_AVATAR_URL_PREFIX)) return null;
  // PiP and the system account carry generated human markers on the server;
  // both show as System's gray bird instead of a generated face.
  if (isBuiltInAccountId(cloudAvatarSeedFromUrl(trimmed))) return KORDI_SYSTEM_AVATAR_URL;
  return canonicalAvatarImageUrl(trimmed);
}

export function cloudAvatarSeedForAccount(
  accountId: string | null | undefined,
  avatarUrl: string | null | undefined,
): string {
  return cloudAvatarSeedFromUrl(avatarUrl) || accountId?.trim() || 'cloud-account';
}
