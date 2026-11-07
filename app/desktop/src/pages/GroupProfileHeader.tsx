import type { ReactNode } from 'react';
import {
  Settings2,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react';

import { useCloudCallContext } from '@/features/cloud/useCloudCallContext';
import { GroupAvatar } from '@/kordi-app/components/GroupAvatar';
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
  return <GroupAvatar avatars={space.avatarStack} imageUrl={space.groupAvatar?.imageUrl} name={space.title} className="h-16 w-16" />;
}

function GroupProfileAction({
  icon,
  label,
  onClick,
  disabled = false,
  title,
  actionKey,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  actionKey?: string;
}) {
  return (
    <button
      type="button"
      className="app-transient-flat-action app-group-profile-action flex min-w-0 flex-col items-center gap-1.5 rounded-[12px] px-2 py-2"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      data-group-profile-action={actionKey}
    >
      {icon}
      <span className="max-w-full truncate text-[10px] font-medium">{label}</span>
    </button>
  );
}

export function GroupProfileHeader({
  space,
  memberCount,
  adminCount,
  canInvitePeople,
  avatarEditor,
  titleSlot,
  onClose,
  onShowMembers,
  onAddPeople,
  onManage,
}: {
  space: ParticipantSpaceViewModel;
  memberCount: number;
  adminCount: number;
  canInvitePeople: boolean;
  avatarEditor?: ReactNode;
  /** Replaces the plain title, for example with the admin's inline rename. */
  titleSlot?: ReactNode;
  onClose: () => void;
  onShowMembers: () => void;
  onAddPeople: () => void;
  /** Opens the admin-only Manage level; without it the action is hidden. */
  onManage?: () => void;
}) {
  const calls = useCloudCallContext();
  const callConversation = space.sessions.find((session) => (
    Boolean(calls?.callForConversation(session.conversation))
  ))?.conversation ?? space.sessions[0]?.conversation ?? null;
  const callTarget = callConversation
    ? calls?.targetForConversation(callConversation) ?? null
    : null;
  const activeCall = callConversation
    ? calls?.callForConversation(callConversation) ?? null
    : null;
  const callIsCurrent = Boolean(activeCall && calls?.currentCall?.call.id === activeCall.id);
  const callBusyElsewhere = Boolean(calls?.currentCall && !callIsCurrent);
  const openVideoChat = () => {
    if (!calls || !callConversation || callTarget?.kind !== 'group' || callBusyElsewhere) return;
    onClose();
    if (!activeCall) {
      void calls.start(callConversation, 'video');
      return;
    }
    if (callIsCurrent) calls.show();
    else void calls.join(activeCall, callTarget.sessionId);
  };

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
      <div className="mx-auto flex items-center justify-center">
        {avatarEditor ?? <GroupProfileAvatar space={space} />}
      </div>
      <div className="mx-auto mt-2 min-w-0 max-w-[15rem]">
        {titleSlot ?? (
          <div className="truncate text-[16px] font-semibold leading-5" title={space.title}>
            {space.title}
          </div>
        )}
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
        {calls && callTarget?.kind === 'group' ? (
          <GroupProfileAction
            icon={<Video className="h-4 w-4" aria-hidden="true" />}
            label={activeCall ? callIsCurrent ? 'Return' : 'Join' : 'Video chat'}
            onClick={openVideoChat}
            disabled={callBusyElsewhere}
            title={callBusyElsewhere ? 'Finish your current call first' : undefined}
          />
        ) : null}
        {onManage ? (
          <GroupProfileAction
            icon={<Settings2 className="h-4 w-4" aria-hidden="true" />}
            label="Manage"
            onClick={onManage}
            actionKey="manage"
          />
        ) : null}
      </div>
    </header>
  );
}
