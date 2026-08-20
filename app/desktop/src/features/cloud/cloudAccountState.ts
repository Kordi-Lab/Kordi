import type { CloudAccount } from './authClient';

export function cloudAccountsEqual(left: CloudAccount | null, right: CloudAccount | null): boolean {
  return left === right || Boolean(
    left
    && right
    && left.accountId === right.accountId
    && left.displayName === right.displayName
    && left.primaryEmail === right.primaryEmail
    && left.avatarUrl === right.avatarUrl
    && left.avatar.entityType === right.avatar.entityType
    && left.avatar.entityId === right.avatar.entityId
    && left.avatar.source === right.avatar.source
    && left.avatar.style === right.avatar.style
    && left.avatar.seed === right.avatar.seed
    && left.avatar.rendererVersion === right.avatar.rendererVersion
    && left.avatar.uploadedAsset === right.avatar.uploadedAsset
    && left.avatar.version === right.avatar.version
    && left.avatar.updatedAt === right.avatar.updatedAt
    && left.nodeId === right.nodeId
    && left.passwordSet === right.passwordSet,
  );
}
