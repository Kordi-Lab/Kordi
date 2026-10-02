import { useState } from 'react';
import { Users } from 'lucide-react';
import { canonicalAvatarImageUrl } from '@/features/cloud/canonicalAvatar';
import type { ParticipantSpaceAvatar } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { IdentityAvatar } from './IdentityAvatar';
import { shouldLoadAvatarThroughNativeProxy, useRemoteAvatarImage } from './remoteAvatarImage';

export function GroupAvatar({ avatars, imageUrl, name = 'Group', className }: {
  avatars: readonly ParticipantSpaceAvatar[];
  imageUrl?: string | null;
  name?: string;
  className?: string;
}) {
  const source = canonicalAvatarImageUrl(imageUrl);
  const needsProxy = shouldLoadAvatarThroughNativeProxy(source);
  const remote = useRemoteAvatarImage(source, needsProxy);
  const resolvedSource = needsProxy ? remote.dataUrl : source;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const visible = resolvedSource && failedSource !== resolvedSource ? resolvedSource : null;
  const members = avatars.slice(0, 9);
  const columns = members.length <= 1 ? 1 : members.length <= 4 ? 2 : 3;
  const rows = columns;
  return (
    <span className={cn('app-group-avatar relative inline-flex h-9 w-9 shrink-0 overflow-hidden rounded-[17%] bg-[var(--app-control-bg)]', className)} role="img" aria-label={`${name} avatar`}>
      {members.length ? (
        <span className="grid h-full w-full gap-px p-[2px]" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }} aria-hidden="true">
          {members.map((avatar) => (
            <span key={`${avatar.kind}:${avatar.seed}`} className="min-h-0 min-w-0 overflow-hidden rounded-[1px]">
              <IdentityAvatar cornerRadius="1px" kind={avatar.kind} seed={avatar.seed} isSelf={avatar.isSelf} imageUrl={avatar.imageUrl} className="block h-full w-full rounded-[1px] [&>div]:rounded-[1px]" />
            </span>
          ))}
        </span>
      ) : <Users className="m-auto h-1/2 w-1/2 text-[var(--utility-muted-text)]" aria-hidden="true" />}
      {visible ? <img src={visible} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} onError={() => setFailedSource(visible)} /> : null}
    </span>
  );
}
