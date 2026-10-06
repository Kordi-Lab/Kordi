import type { CloudAccount } from './authClient';

function cloudAvatarsEqual(
  left: CloudAccount['avatar'] | null | undefined,
  right: CloudAccount['avatar'] | null | undefined,
): boolean {
  return left === right || Boolean(
    left
    && right
    && left.entityType === right.entityType
    && left.entityId === right.entityId
    && left.source === right.source
    && left.style === right.style
    && left.seed === right.seed
    && left.rendererVersion === right.rendererVersion
    && left.uploadedAsset === right.uploadedAsset
    && left.version === right.version
    && left.updatedAt === right.updatedAt,
  );
}

/**
 * Keeps the known email verification state when an incoming payload for the
 * same account omits it, as older servers do on PATCH /me responses.
 */
export function carryCloudAccountEmailVerification(
  previous: CloudAccount | null,
  next: CloudAccount,
): CloudAccount {
  if (
    next.primaryEmailVerified !== undefined
    || previous?.primaryEmailVerified === undefined
    || previous.accountId !== next.accountId
    || previous.primaryEmail !== next.primaryEmail
  ) {
    return next;
  }
  return { ...next, primaryEmailVerified: previous.primaryEmailVerified };
}

export function cloudAccountsEqual(left: CloudAccount | null, right: CloudAccount | null): boolean {
  return left === right || Boolean(
    left
    && right
    && left.accountId === right.accountId
    && left.kordiId === right.kordiId
    && left.displayName === right.displayName
    && left.primaryEmail === right.primaryEmail
    && left.primaryEmailVerified === right.primaryEmailVerified
    && left.avatarUrl === right.avatarUrl
    && cloudAvatarsEqual(left.avatar, right.avatar)
    && left.defaultAgent?.agentId === right.defaultAgent?.agentId
    && left.defaultAgent?.displayName === right.defaultAgent?.displayName
    && left.defaultAgent?.avatarUrl === right.defaultAgent?.avatarUrl
    && cloudAvatarsEqual(left.defaultAgent?.avatar, right.defaultAgent?.avatar)
    && left.nodeId === right.nodeId
    && left.passwordSet === right.passwordSet,
  );
}
