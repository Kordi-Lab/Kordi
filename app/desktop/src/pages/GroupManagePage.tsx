import { useState } from 'react';
import { ChevronLeft, CircleOff } from 'lucide-react';

import { DissolveDialog } from '@/pages/DissolveDialog';

/**
 * Group Info's second level for admins, built like the account menu's
 * organization list: a back button, a title, a divider, then the rows.
 */
export function GroupManagePage({
  spaceId,
  title,
  sessionIds,
  disabled,
  onBack,
  onDissolveGroup,
}: {
  spaceId: string;
  title: string;
  sessionIds: string[];
  disabled: boolean;
  onBack: () => void;
  onDissolveGroup: (groupSpaceId: string, sessionIds: string[]) => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState(false);
  const groupSpaceId = spaceId.trim().replace(/^group:/, '');
  return (
    <div className="app-group-manage-page" data-group-manage-page>
      <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2 px-2 pb-1">
        <button
          type="button"
          data-group-manage-back
          className="app-button-quiet app-transient-flat-action -ml-0.5 grid h-6 w-6 place-items-center rounded-[6px]"
          aria-label="Back"
          onClick={onBack}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <span className="app-group-manage-title truncate">Manage</span>
      </div>
      <div className="app-transient-divider grid gap-px border-t pt-1" role="group" aria-label="Manage">
        <button
          type="button"
          data-group-dissolve
          className="app-transient-flat-action app-transient-flat-action-danger app-group-manage-row grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2 rounded-[8px] px-2 text-left"
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          <span className="grid h-5 w-5 place-items-center" aria-hidden="true">
            <CircleOff className="h-[13px] w-[13px]" />
          </span>
          <span className="truncate">Dissolve group</span>
        </button>
      </div>
      {confirming ? (
        <DissolveDialog
          scope="group"
          name={title}
          backdropClassName="z-[70]"
          onCancel={() => setConfirming(false)}
          onConfirm={() => onDissolveGroup(groupSpaceId, sessionIds)}
        />
      ) : null}
    </div>
  );
}
