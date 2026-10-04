import type { CloudGroupInvitationPreview } from '@/features/cloud/cloudIdentityTypes';

/**
 * The generated-avatar seed for an invitation's inviter. Unauthenticated
 * previews no longer include the inviter's Kordi ID, so the display name
 * stands in; older servers still send the ID and keep their seed.
 */
export function groupInviterAvatarSeed(inviter: CloudGroupInvitationPreview['inviter']): string {
  return `group-inviter:${inviter.kordiId?.trim() || inviter.displayName?.trim() || 'unknown'}`;
}
