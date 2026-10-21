import { cloudGroupTargetAccountIds } from '@/features/cloud/cloudGroupMessages';

const CLOUD_GROUP_SESSION_PREFIX = 'session:group:';

/**
 * Decides whether a group send goes through the Cloud group path.
 *
 * A Cloud group whose only human member is the owner (a Common ground group
 * before any invitee joins) has no other recipient. It still has a server
 * conversation the owner can post into, where the Kordi agent answers and
 * invitees read the history once they join, so it stays sendable. The sender
 * then addresses the owner's own account, as group avatar updates do.
 */
export function cloudGroupSendPlan(
  targets: Array<{ hostId?: string | null; nodeId?: string | null }>,
  canonicalSessionId: string | null | undefined,
) {
  const cloudGroupTargetIds = cloudGroupTargetAccountIds(targets);
  const ownerOnlyCloudGroup = targets.length === 0
    && (canonicalSessionId ?? '').trim().startsWith(CLOUD_GROUP_SESSION_PREFIX);
  return {
    cloudGroupTargetIds,
    cloudGroupSendable: cloudGroupTargetIds.length > 0 || ownerOnlyCloudGroup,
  };
}
