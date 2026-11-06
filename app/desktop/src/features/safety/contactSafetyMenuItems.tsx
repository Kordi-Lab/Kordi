import { Ban, Flag } from 'lucide-react';

import type { TileMenuItem } from '@/kordi-app/contacts/ContactProfileTiles';

import { useSafetyActions } from './safetyActions';
import { isServiceAccountId } from './serviceAccounts';

/**
 * Block and Report for a person's profile menu. They stay disabled until the
 * server supports blocking and the person's account is known.
 */
export function useContactSafetyMenuItems(accountId: string | null | undefined, name: string, onBlocked?: () => void): TileMenuItem[] {
  const safety = useSafetyActions();
  const id = accountId?.trim() || null;
  const target = safety.available && id && !isServiceAccountId(id) ? { accountId: id, name } : null;
  return [
    {
      kind: 'item',
      key: 'block',
      label: 'Block',
      icon: <Ban className="h-4 w-4" aria-hidden="true" />,
      disabled: !target,
      onSelect: target ? () => safety.openBlock(target, onBlocked) : undefined,
    },
    {
      kind: 'item',
      key: 'report',
      label: 'Report',
      icon: <Flag className="h-4 w-4" aria-hidden="true" />,
      disabled: !target,
      onSelect: target ? () => safety.openReport(target) : undefined,
    },
  ];
}
