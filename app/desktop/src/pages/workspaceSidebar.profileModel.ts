import type { CloudAccount } from '@/features/cloud/authClient';
import { formatKordiHandle } from '@/features/cloud/kordiId';

const ACCOUNT_POPOVER_WIDTH_REM = 17.75;
const ACCOUNT_POPOVER_SAFE_INSET_PX = 8;

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

export function accountPopoverLeft({
  triggerRight,
  viewportWidth,
  rootFontSize,
}: {
  triggerRight: number;
  viewportWidth: number;
  rootFontSize: number;
}) {
  const availableWidth = Math.max(0, viewportWidth - ACCOUNT_POPOVER_SAFE_INSET_PX * 2);
  const popoverWidth = Math.min(ACCOUNT_POPOVER_WIDTH_REM * rootFontSize, availableWidth);
  const preferredLeft = triggerRight + ACCOUNT_POPOVER_SAFE_INSET_PX;
  const maximumLeft = viewportWidth - popoverWidth - ACCOUNT_POPOVER_SAFE_INSET_PX;
  return Math.max(
    ACCOUNT_POPOVER_SAFE_INSET_PX,
    Math.min(preferredLeft, maximumLeft),
  );
}
