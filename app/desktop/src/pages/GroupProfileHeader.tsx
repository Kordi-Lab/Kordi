import type { ReactNode } from 'react';
import {
  Settings2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';

import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { ParticipantSpaceViewModel } from '@/kordi-app/types';
import { formatDesktopDate } from '@/lib/time';

function groupCreatedLabel(space: ParticipantSpaceViewModel) {
  return typeof space.createdAtMs === 'number'
    && Number.isFinite(space.createdAtMs)
    && space.createdAtMs > 0
    ? `Created ${formatDesktopDate(space.createdAtMs)}`
    : 'Created locally';
}

function GroupProfileAvatar({ space }: { space: ParticipantSpaceViewModel }) {
  const avatars = space.avatarStack.length > 0
    ? space.avatarStack.slice(0, 3)
    : [{ kind: 'human' as const, seed: space.id, imageUrl: null }];
  if (avatars.length === 1) {
    const avatar = avatars[0];
    return (
      <IdentityAvatar
        kind={avatar.kind}
        seed={avatar.seed}
        isSelf={avatar.isSelf}
        name={space.title}
        imageUrl={avatar.imageUrl ?? undefined}
        className="h-16 w-16 border border-white/10"
      />
    );
  }
  return (
    <div className="flex h-16 w-[5.5rem] items-center justify-center -space-x-6" aria-hidden="true">
      {avatars.map((avatar, index) => (
        <span
          key={`${avatar.seed}-${index}`}
          className="relative inline-flex rounded-full"
          style={{ zIndex: avatars.length - index }}
        >
          <IdentityAvatar
            kind={avatar.kind}
            seed={avatar.seed}
            isSelf={avatar.isSelf}
            name={space.title}
            imageUrl={avatar.imageUrl ?? undefined}
            className="h-12 w-12 border-2 border-[color:var(--app-transient-surface-fallback)]"
          />
        </span>
      ))}
    </div>
  );
}

function GroupProfileAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="app-transient-flat-action app-group-profile-action flex min-w-0 flex-col items-center gap-1.5 rounded-[12px] px-2 py-2"
      onClick={onClick}
    >
      {icon}
      <span className="truncate text-[10px] font-medium">{label}</span>
    </button>
  );
}

export function GroupProfileHeader({
  space,
  memberCount,
  adminCount,
  canInvitePeople,
  canManageGroup,
  onClose,
  onShowMembers,
  onAddPeople,
  onManage,
}: {
  space: ParticipantSpaceViewModel;
  memberCount: number;
  adminCount: number;
  canInvitePeople: boolean;
  canManageGroup: boolean;
  onClose: () => void;
  onShowMembers: () => void;
  onAddPeople: () => void;
  onManage: () => void;
}) {
  return (
    <header className="app-group-management-header relative shrink-0 px-3 pb-3 pt-4 text-center">
      <h2 className="sr-only">Group management</h2>
      <button
        type="button"
        onClick={onClose}
        className="app-button-quiet app-group-management-close absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-[10px] p-0"
        aria-label="Close group management"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="mx-auto flex h-16 items-center justify-center">
        <GroupProfileAvatar space={space} />
      </div>
      <div className="mx-auto mt-2 min-w-0 max-w-[15rem]">
        <div className="truncate text-[16px] font-semibold leading-5" title={space.title}>
          {space.title}
        </div>
        <p className="mt-1 text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">
          {memberCount} member{memberCount === 1 ? '' : 's'} · {groupCreatedLabel(space)}
          <span className="sr-only">
            {' · '}{memberCount} people · {adminCount} admin{adminCount === 1 ? '' : 's'}
          </span>
        </p>
      </div>
      <div className="app-group-profile-actions mt-3 grid gap-1.5">
        <GroupProfileAction
          icon={<Users className="h-4 w-4" aria-hidden="true" />}
          label="Members"
          onClick={onShowMembers}
        />
        {canInvitePeople ? (
          <GroupProfileAction
            icon={<UserPlus className="h-4 w-4" aria-hidden="true" />}
            label="Add people"
            onClick={onAddPeople}
          />
        ) : null}
        {canManageGroup ? (
          <GroupProfileAction
            icon={<Settings2 className="h-4 w-4" aria-hidden="true" />}
            label="Manage"
            onClick={onManage}
          />
        ) : null}
      </div>
    </header>
  );
}
