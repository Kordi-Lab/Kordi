import { useState } from 'react';
import { CircleOff, LogOut } from 'lucide-react';

import { DissolveDialog } from '@/pages/DissolveDialog';

const ROW_CLASS = 'app-transient-flat-action app-transient-flat-action-danger app-group-management-action-row mt-3 flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left text-[11px]';

/** The last row of group Info: Dissolve group for owners and admins, Leave group for everyone else. */
export function GroupInfoFooterActions({ spaceId, title, sessionIds, isAdmin, canLeave, disabled, onDissolveGroup, onLeave }: {
  spaceId: string;
  title: string;
  sessionIds: string[];
  isAdmin: boolean;
  canLeave: boolean;
  disabled: boolean;
  onDissolveGroup?: (groupSpaceId: string, sessionIds: string[]) => Promise<void> | void;
  /** Opens the member's own Leave group confirmation. */
  onLeave: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (isAdmin && onDissolveGroup) {
    const groupSpaceId = spaceId.trim().replace(/^group:/, '');
    return (
      <>
        <button type="button" data-group-dissolve className={ROW_CLASS} disabled={disabled} onClick={() => setConfirming(true)}>
          <CircleOff className="h-3.5 w-3.5" aria-hidden="true" />
          Dissolve group
        </button>
        {confirming ? (
          <DissolveDialog
            scope="group"
            name={title}
            backdropClassName="z-[70]"
            onCancel={() => setConfirming(false)}
            onConfirm={() => onDissolveGroup(groupSpaceId, sessionIds)}
          />
        ) : null}
      </>
    );
  }
  if (!canLeave) return null;
  return (
    <button
      type="button"
      data-group-leave
      className={ROW_CLASS}
      disabled={disabled}
      onClick={(event) => {
        // The panel clears a member selection on clicks outside the member grid.
        event.stopPropagation();
        onLeave();
      }}
    >
      <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
      Leave group
    </button>
  );
}
