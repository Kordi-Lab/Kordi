import type { CloudContactProfileGroup } from '@/features/cloud/contactProfileClient';
import type { ParticipantSpaceAvatar, ParticipantSpaceViewModel } from '../types';

/** How many group avatars the Groups in common row stacks before its count. */
export const COMMON_GROUP_STACK_LIMIT = 3;

/** What a group avatar needs: the group's picture, else its members' mosaic, as the sidebar draws it. */
export type CommonGroupAvatar = {
  key: string;
  name: string;
  imageUrl: string | null;
  avatars: ParticipantSpaceAvatar[];
};

function bareGroupId(value: string | null | undefined) {
  return (value ?? '').trim().replace(/^(group:)+/, '');
}

/**
 * The loaded group space a profile group stands for. The server names a group by its space id
 * (or, for an older group without one, its channel's session id), while the sidebar keys the
 * space as `group:<space id>`, so both sides are compared without the prefix.
 */
export function commonGroupSpace(
  group: CloudContactProfileGroup,
  spaces: readonly ParticipantSpaceViewModel[] | undefined,
): ParticipantSpaceViewModel | null {
  const id = bareGroupId(group.groupId);
  if (!id || !spaces?.length) return null;
  const groups = spaces.filter((space) => space.kind === 'group');
  return groups.find((space) => bareGroupId(space.id) === id)
    ?? groups.find((space) => [
      ...(space.membershipSessionIds ?? []),
      ...space.sessions.flatMap((session) => [session.id, session.canonicalSessionId]),
    ].some((sessionId) => bareGroupId(sessionId) === id))
    ?? null;
}

/** The avatar for one common group: the sidebar's picture and member mosaic when the group is loaded. */
export function commonGroupAvatar(
  group: CloudContactProfileGroup,
  spaces: readonly ParticipantSpaceViewModel[] | undefined,
): CommonGroupAvatar {
  const space = commonGroupSpace(group, spaces);
  return {
    key: group.groupId,
    name: group.title,
    imageUrl: space?.groupAvatar?.imageUrl ?? group.avatarUrl ?? null,
    avatars: space?.avatarStack ?? [],
  };
}

/** Avatars for the first common groups, in the server's order, for the row's overlapping stack. */
export function commonGroupAvatarStack(
  groups: readonly CloudContactProfileGroup[],
  spaces: readonly ParticipantSpaceViewModel[] | undefined,
  limit = COMMON_GROUP_STACK_LIMIT,
): CommonGroupAvatar[] {
  return groups.slice(0, Math.max(0, limit)).map((group) => commonGroupAvatar(group, spaces));
}
