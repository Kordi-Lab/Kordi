import type { CloudAccount } from './authClient';

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function applyCloudSessionProfileUpdate(
  account: CloudAccount | null,
  payload: unknown,
): CloudAccount | null {
  if (!account) return null;
  const record = objectRecord(payload);
  if (record?.account_id !== account.accountId) return null;
  const displayName = typeof record.display_name === 'string' ? record.display_name : account.displayName;
  const avatarUrl = typeof record.avatar_url === 'string' ? record.avatar_url : account.avatarUrl;
  return { ...account, displayName, avatarUrl };
}

export function cloudAccountsEqual(left: CloudAccount | null, right: CloudAccount | null): boolean {
  return left === right || Boolean(
    left
    && right
    && left.accountId === right.accountId
    && left.displayName === right.displayName
    && left.primaryEmail === right.primaryEmail
    && left.avatarUrl === right.avatarUrl
    && left.nodeId === right.nodeId
    && left.passwordSet === right.passwordSet,
  );
}
