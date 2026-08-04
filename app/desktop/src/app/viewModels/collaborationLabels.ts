import {
  CLOUD_PIXEL_AVATAR_URL_PREFIX,
  cloudAvatarImageUrl,
} from '@/features/cloud/avatar';
import { isSelfReferenceName } from '@/lib/identityLabels';

export function sanitizeRemotePeerName(
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && !isSelfReferenceName(trimmed)) return trimmed;
  }
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return 'Kordi user';
}

export function collaborationProfileImageUrl(
  value: string | null | undefined,
): string | null {
  const normalized = cloudAvatarImageUrl(value);
  if (normalized) return normalized;
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith(CLOUD_PIXEL_AVATAR_URL_PREFIX)) return null;
  return trimmed;
}
