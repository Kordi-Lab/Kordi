import { CommonGroundHugIcon } from './CommonGroundHugIcon';

import { cn } from '@/lib/utils';

export type CommonGroundContactsRowProps = {
  selected: boolean;
  hasInvitation?: boolean;
  onSelect: () => void;
};

/** Pinned row at the top of the Contacts list that opens Common ground in the detail area. */
export function CommonGroundContactsRow({ selected, hasInvitation = false, onSelect }: CommonGroundContactsRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'app-contact-row app-list-item app-common-ground-row flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1 text-left transition-none',
        selected && 'app-contact-row-selected',
      )}
    >
      <span className="app-common-ground-tile relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
        <CommonGroundHugIcon className="h-5 w-5" />
        {hasInvitation ? <span className="app-common-ground-dot absolute" role="status" aria-label="Room invitation waiting" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold leading-4">Common ground</div>
        <div className="app-contact-row-meta mt-0.5 truncate text-[10.5px] leading-4">Meet people at this event</div>
      </div>
    </button>
  );
}
