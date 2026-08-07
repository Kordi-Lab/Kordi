import type { CloudAccount } from '@/features/cloud/authClient';
import { formatKordiHandle } from '@/features/cloud/kordiId';

export type CloudProfileRow = {
  label: string;
  value: string;
  copyable?: boolean;
};

export function buildCloudProfileRows(
  account: CloudAccount | null | undefined,
): CloudProfileRow[] {
  if (!account) return [];
  const handle = formatKordiHandle(account.kordiId);
  return handle ? [{ label: 'Kordi ID', value: handle, copyable: true }] : [];
}
