import { KORDI_PIP_ACCOUNT_ID, KORDI_PIP_AVATAR_URL } from '@/features/pip/pipIdentity';
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
  // PiP's account carries a generated human marker on the server; show its
  // own mark instead of a generated face.
  if (cloudAvatarSeedFromUrl(trimmed) === KORDI_PIP_ACCOUNT_ID) return KORDI_PIP_AVATAR_URL;
  return canonicalAvatarImageUrl(trimmed);
}

export function cloudAvatarSeedForAccount(
  accountId: string | null | undefined,
  avatarUrl: string | null | undefined,
): string {
  return cloudAvatarSeedFromUrl(avatarUrl) || accountId?.trim() || 'cloud-account';
}
