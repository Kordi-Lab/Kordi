import type { CloudAccount } from '@/features/cloud/authClient';

export type CloudProfileRow = {
  label: string;
  value: string;
  copyable?: boolean;
};

export function buildCloudProfileRows(
  account: CloudAccount | null | undefined,
): CloudProfileRow[] {
  if (!account) return [];
  return [
    account.primaryEmail?.trim()
      ? { label: 'Email', value: account.primaryEmail.trim() }
      : null,
    { label: 'Account ID', value: account.accountId, copyable: true },
  ].filter((row): row is CloudProfileRow => Boolean(row));
}
