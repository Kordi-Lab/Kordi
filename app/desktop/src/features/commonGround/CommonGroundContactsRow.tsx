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
        'app-contact-row app-list-item app-common-ground-row flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left transition-none',
        selected && 'app-contact-row-selected',
      )}
    >
      <span className="app-common-ground-tile relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
        <CommonGroundHugIcon className="h-[22px] w-[22px]" />
        {hasInvitation ? <span className="app-common-ground-dot absolute" role="status" aria-label="Room invitation waiting" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold leading-5">Common ground</div>
        <div className="app-contact-row-meta truncate text-[12.5px] leading-[18px]">Meet people at this event</div>
      </div>
    </button>
  );
}
