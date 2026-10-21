import type { ReactNode } from 'react';
import { ChevronRight, FileText, Image as ImageIcon, Link, LoaderCircle, Trash2, Users } from 'lucide-react';

import type { CloudContactProfile, CloudContactProfileGroup } from '@/features/cloud/contactProfileClient';
import { cn } from '@/lib/utils';
import type { ContactProfileSharedPage } from '@/pages/contactProfileSharedItems';
import { GroupAvatar } from '../components/GroupAvatar';
import { usePopover } from './contactProfileHooks';
import type { ContactSharedCounts } from './useContactSharedPages';

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="app-contacts-muted app-contacts-section-label mx-1 mb-1.5 mt-5 text-[12px] leading-4">{children}</div>;
}

function SharedRow({
  icon,
  label,
  count,
  extra,
  onClick,
  ariaHasPopup,
  ariaExpanded,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  extra?: ReactNode;
  onClick?: () => void;
  ariaHasPopup?: 'menu';
  ariaExpanded?: boolean;
}) {
  const zero = count === 0;
  return (
    <button
      type="button"
      className={cn('app-contacts-card-row app-contacts-card-button app-contacts-shared-row flex min-h-[44px] w-full items-center gap-3 pl-4 pr-3.5 text-left', zero && 'is-zero')}
      onClick={onClick}
      disabled={zero || !onClick}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
    >
      <span className="app-contacts-muted shrink-0">{icon}</span>
      <span className="app-contacts-shared-label min-w-0 flex-1 truncate text-[14px]">{label}</span>
      {extra}
      <span className="app-contacts-shared-count text-[13px] tabular-nums">{count}</span>
      <ChevronRight className="app-contacts-chevron h-[15px] w-[15px] shrink-0" aria-hidden="true" />
    </button>
  );
}

function GroupsRow({ groups, onOpenGroup }: { groups: CloudContactProfileGroup[]; onOpenGroup?: (group: CloudContactProfileGroup) => void }) {
  const { open, setOpen, slotProps } = usePopover('app-contacts-card-row relative');
  const avatars = groups.length > 0 ? (
    <span className="app-contacts-group-avatars mr-0.5 flex items-center" aria-hidden="true">
      {groups.slice(0, 2).map((group) => (
        <GroupAvatar key={group.groupId} avatars={[]} imageUrl={group.avatarUrl} name={group.title} className="h-5 w-5" />
      ))}
    </span>
  ) : null;
  const multiple = groups.length > 1;
  return (
    <div {...slotProps}>
      <SharedRow
        icon={<Users className="h-[18px] w-[18px]" aria-hidden="true" />}
        label="Groups in common"
        count={groups.length}
        extra={avatars}
        ariaHasPopup={multiple ? 'menu' : undefined}
        ariaExpanded={multiple ? open : undefined}
        onClick={onOpenGroup ? () => {
          if (multiple) setOpen((current) => !current);
          else if (groups[0]) onOpenGroup(groups[0]);
        } : undefined}
      />
      {open && multiple ? (
        <div role="menu" aria-label="Groups in common" className="app-contacts-menu absolute right-2 top-[46px] z-10 max-h-[260px] min-w-[220px] overflow-y-auto rounded-[10px] p-1">
          {groups.map((group) => (
            <button
              key={group.groupId}
              type="button"
              role="menuitem"
              className="app-contacts-menu-item flex h-9 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px]"
              onClick={() => {
                setOpen(false);
                onOpenGroup?.(group);
              }}
            >
              <GroupAvatar avatars={[]} imageUrl={group.avatarUrl} name={group.title} className="h-6 w-6" />
              <span className="min-w-0 flex-1 truncate">{group.title}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Counts of what the two accounts share. With the whole direct chat on hand the rows count its
 * items and open the shared pages; otherwise they show the server counts and open the chat.
 */
export function SharedWithYouCard({
  shared,
  local,
  onOpenPage,
  onOpenChat,
  onOpenGroup,
}: {
  shared: CloudContactProfile['shared'];
  local?: ContactSharedCounts | null;
  onOpenPage?: (page: ContactProfileSharedPage) => void;
  onOpenChat?: () => void;
  onOpenGroup?: (group: CloudContactProfileGroup) => void;
}) {
  const counts = local ?? { photos: shared.mediaCount, files: shared.documentCount, links: shared.linkCount };
  const openFor = (page: ContactProfileSharedPage) => (local && onOpenPage ? () => onOpenPage(page) : onOpenChat);
  const empty = counts.photos + counts.files + counts.links + shared.groups.length === 0;
  return (
    <>
      <SectionLabel>Shared with you</SectionLabel>
      <div className="app-contacts-card rounded-[12px]">
        {empty ? (
          <div className="app-contacts-muted flex min-h-[44px] items-center px-4 text-[14px]">Nothing shared yet</div>
        ) : (
          <>
            <SharedRow icon={<ImageIcon className="h-[18px] w-[18px]" aria-hidden="true" />} label="Photos" count={counts.photos} onClick={openFor('photos')} />
            <SharedRow icon={<FileText className="h-[18px] w-[18px]" aria-hidden="true" />} label="Files" count={counts.files} onClick={openFor('files')} />
            <SharedRow icon={<Link className="h-[18px] w-[18px]" aria-hidden="true" />} label="Links" count={counts.links} onClick={openFor('links')} />
            <GroupsRow groups={shared.groups} onOpenGroup={onOpenGroup} />
          </>
        )}
      </div>
    </>
  );
}

/** Placeholder card while the profile loads, so the cards below the info card do not jump in. */
export function SharedWithYouLoading() {
  return (
    <div className="app-contacts-card mt-5 flex h-11 items-center justify-center rounded-[12px]" aria-busy="true" aria-label="Loading profile">
      <LoaderCircle className="app-contacts-muted h-4 w-4 animate-spin" aria-hidden="true" />
    </div>
  );
}

const COMMON_GROUND_ROWS: { key: keyof NonNullable<CloudContactProfile['commonGround']>; label: string }[] = [
  { key: 'workingOn', label: 'Working on' },
  { key: 'canHelp', label: 'Can help' },
  { key: 'lookingFor', label: 'Looking for' },
];

export function CommonGroundCard({ card }: { card: NonNullable<CloudContactProfile['commonGround']> }) {
  return (
    <>
      <SectionLabel>Common ground</SectionLabel>
      <div className="app-contacts-card flex flex-col gap-2.5 rounded-[12px] px-4 pb-3.5 pt-3">
        {COMMON_GROUND_ROWS.filter((row) => card[row.key].length > 0).map((row) => (
          <div key={row.key} className="flex items-start gap-2.5">
            <span className="app-contacts-muted w-[86px] shrink-0 text-[12px] leading-6">{row.label}</span>
            <span className="flex min-w-0 flex-wrap gap-1.5">
              {card[row.key].map((topic) => (
                <span key={topic} className="app-contacts-chip rounded-full px-2.5 py-1 text-[12px] leading-4">{topic}</span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function DeleteConfirm({
  removeState,
  removeError,
  onCancel,
  onDelete,
}: {
  removeState: 'idle' | 'saving' | 'error';
  removeError: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="app-contacts-confirm mt-2 rounded-[12px] px-3.5 py-3" role="group" aria-label="Delete contact">
      <div
        className={cn('text-[12.5px] leading-[18px]', removeState === 'error' ? 'app-error-text app-contacts-error' : 'app-contacts-muted')}
        aria-live="polite"
      >
        {removeState === 'error'
          ? removeError || 'Unable to delete contact.'
          : 'Deleting removes both contact directions. They will need approval before messages can reach you again.'}
      </div>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button
          type="button"
          className="app-contacts-quiet-action inline-flex h-7 items-center rounded-[7px] px-3 text-[12.5px] font-medium"
          onClick={onCancel}
          disabled={removeState === 'saving'}
        >
          Cancel
        </button>
        <button
          type="button"
          className="app-contacts-danger-fill inline-flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-semibold disabled:pointer-events-none disabled:opacity-50"
          onClick={onDelete}
          disabled={removeState === 'saving'}
        >
          {removeState === 'saving' ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Deleting…</> : 'Delete'}
        </button>
      </div>
    </div>
  );
}

/** Delete contact row and its inline confirm, last in the pane. */
export function DeleteContactCard({
  confirmOpen,
  removeState,
  removeError,
  onOpenConfirm,
  onCancel,
  onDelete,
}: {
  confirmOpen: boolean;
  removeState: 'idle' | 'saving' | 'error';
  removeError: string;
  onOpenConfirm: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const showConfirm = confirmOpen || removeState === 'error';
  return (
    <>
      <div className="app-contacts-card mt-3 rounded-[12px]">
        <button
          type="button"
          className="app-contacts-card-action flex h-11 w-full items-center gap-3 rounded-[12px] px-4 text-left text-[14px]"
          aria-expanded={showConfirm}
          onClick={onOpenConfirm}
        >
          <Trash2 className="h-[18px] w-[18px]" aria-hidden="true" />
          Delete contact
        </button>
      </div>
      {showConfirm ? <DeleteConfirm removeState={removeState} removeError={removeError} onCancel={onCancel} onDelete={onDelete} /> : null}
    </>
  );
}
