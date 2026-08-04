import { CLOUD_HOST_SENTINEL } from './cloudContactMapping';

export type CloudCollaborationTargetRef = {
  hostId?: string | null;
  nodeId?: string | null;
};

export function cleanCloudTransportText(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function isCloudHostId(value: string | null | undefined): boolean {
  return cleanCloudTransportText(value) === CLOUD_HOST_SENTINEL;
}

export function isCloudAccountId(value: string | null | undefined): boolean {
  return cleanCloudTransportText(value).startsWith('acct_');
}

export function cloudAccountIdOrNull(value: string | null | undefined): string | null {
  const trimmed = cleanCloudTransportText(value);
  return isCloudAccountId(trimmed) ? trimmed : null;
}

export function assertCloudAccountId(value: string | null | undefined): string {
  const accountId = cloudAccountIdOrNull(value);
  if (!accountId) throw new Error('invalid_cloud_account_id');
  return accountId;
}

export function rejectNonCloudCollaborationTargets(targets: CloudCollaborationTargetRef[]): string[] {
  const accountIds: string[] = [];
  for (const target of targets) {
    if (!isCloudHostId(target.hostId)) throw new Error('non_cloud_target_in_cloud_edition');
    accountIds.push(assertCloudAccountId(target.nodeId));
  }
  return [...new Set(accountIds)].sort();
}
