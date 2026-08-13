import { Bookmark } from 'lucide-react';

import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { WorkspaceSidebarParticipantSpace as ParticipantSpaceItem } from '@/pages/workspaceSidebar.types';

export function ParticipantSpaceAvatarStack({
  space,
}: {
  space: ParticipantSpaceItem;
}) {
  if (space.kind === 'self') {
    return (
      <span
        className="app-saved-messages-avatar grid h-9 w-9 shrink-0 place-items-center rounded-full"
        aria-hidden="true"
      >
        <Bookmark className="h-[1.15rem] w-[1.15rem]" strokeWidth={2} />
      </span>
    );
  }

  const avatars =
    space.avatarStack.length > 0
      ? space.avatarStack
      : [
        {
          kind: space.kind === 'direct-agent' ? ('agent' as const) : ('human' as const),
          seed: space.id,
          isSelf: false,
          imageUrl: null,
        },
      ];
  const showPresenceLight = space.kind !== 'group';

  if (avatars.length === 1) {
    const avatar = avatars[0];
    return (
      <div className="relative h-9 w-9 shrink-0">
        <IdentityAvatar
          kind={avatar.kind}
          seed={avatar.seed}
          isSelf={avatar.isSelf}
          name={space.title}
          imageUrl={avatar.imageUrl ?? undefined}
          className="h-9 w-9"
          presenceStatus={showPresenceLight ? avatar.presenceStatus : null}
          presenceLabel={
            showPresenceLight && avatar.presenceStatus
              ? `${space.title} is ${avatar.presenceStatus === 'online' ? 'online' : 'offline'}`
              : null
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-9 w-10 shrink-0 items-center -space-x-5" aria-hidden="true">
      {avatars.slice(0, 3).map((avatar, index) => (
        <span
          key={`${avatar.seed}-${index}`}
          className="relative inline-flex"
          style={{ zIndex: avatars.length - index }}
        >
          <IdentityAvatar
            kind={avatar.kind}
            seed={avatar.seed}
            isSelf={avatar.isSelf}
            name={space.title}
            imageUrl={avatar.imageUrl ?? undefined}
            className="h-7 w-7"
            presenceStatus={showPresenceLight ? avatar.presenceStatus : null}
            presenceLabel={
              showPresenceLight && avatar.presenceStatus
                ? `${space.title} member is ${avatar.presenceStatus === 'online' ? 'online' : 'offline'}`
                : null
            }
          />
        </span>
      ))}
    </div>
  );
}
