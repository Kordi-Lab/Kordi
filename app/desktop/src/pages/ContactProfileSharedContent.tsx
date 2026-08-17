import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Film,
  Images,
  Link,
  Users,
} from 'lucide-react';

import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { ParticipantSpaceViewModel } from '@/kordi-app/types';
import type { ContactProfileSharedSummary } from '@/pages/memberContactProfileModel';

type SharedSummaryRow = {
  key: string;
  icon: ReactNode;
  count: number;
  singular: string;
  plural: string;
  expanded?: boolean;
  onClick?: () => void;
};

function SharedProfileRow({
  icon,
  count,
  singular,
  plural,
  expanded,
  onClick,
}: Omit<SharedSummaryRow, 'key'>) {
  const content = (
    <>
      <span className="app-contact-profile-summary-icon grid h-7 w-7 shrink-0 place-items-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-[11.5px] font-medium">
        {count} {count === 1 ? singular : plural}
      </span>
      {onClick ? (
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className="app-contact-profile-summary-row app-contact-profile-summary-trigger flex min-h-10 w-full items-center gap-3 px-2.5 py-2 text-left"
        onClick={onClick}
        aria-expanded={expanded}
      >
        {content}
      </button>
    );
  }
  return (
    <div className="app-contact-profile-summary-row flex min-h-10 items-center gap-3 px-2.5 py-2">
      {content}
    </div>
  );
}

function CommonGroupAvatar({ space }: { space: ParticipantSpaceViewModel }) {
  const avatars = space.avatarStack.slice(0, 2);
  if (avatars.length === 0) {
    return (
      <IdentityAvatar kind="human" seed={space.id} name={space.title} className="h-7 w-7" />
    );
  }
  return (
    <span className="flex h-7 w-9 shrink-0 items-center -space-x-2" aria-hidden="true">
      {avatars.map((avatar, index) => (
        <IdentityAvatar
          key={`${avatar.seed}-${index}`}
          kind={avatar.kind}
          seed={avatar.seed}
          isSelf={avatar.isSelf}
          name={space.participants.find((participant) => (
            participant.avatarKey === avatar.seed
            || participant.agentId === avatar.seed
            || participant.humanId === avatar.seed
            || participant.id === avatar.seed
            || participant.name === avatar.seed
          ))?.name ?? space.title}
          imageUrl={avatar.imageUrl ?? undefined}
          className="h-7 w-7 border border-[color:var(--app-transient-surface-fallback)]"
        />
      ))}
    </span>
  );
}

export function ContactProfileSharedContent({
  commonGroups,
  onOpenCommonGroup,
  summary,
}: {
  commonGroups: ParticipantSpaceViewModel[];
  onOpenCommonGroup?: (space: ParticipantSpaceViewModel) => void;
  summary: ContactProfileSharedSummary;
}) {
  const [commonGroupsOpen, setCommonGroupsOpen] = useState(false);
  const rows: SharedSummaryRow[] = [
    { key: 'photos', icon: <Images className="h-3.5 w-3.5" />, count: summary.photos, singular: 'photo', plural: 'photos' },
    { key: 'videos', icon: <Film className="h-3.5 w-3.5" />, count: summary.videos, singular: 'video', plural: 'videos' },
    { key: 'files', icon: <FileText className="h-3.5 w-3.5" />, count: summary.files, singular: 'file', plural: 'files' },
    { key: 'links', icon: <Link className="h-3.5 w-3.5" />, count: summary.links, singular: 'shared link', plural: 'shared links' },
    {
      key: 'groups',
      icon: <Users className="h-3.5 w-3.5" />,
      count: summary.commonGroups,
      singular: 'group in common',
      plural: 'groups in common',
      expanded: commonGroupsOpen,
      onClick: () => setCommonGroupsOpen((open) => !open),
    },
  ].filter((row) => row.count > 0);

  if (rows.length === 0) {
    return (
      <div className="app-contact-profile-empty rounded-[14px] px-4 py-4 text-center text-[11px] leading-4">
        Shared photos, videos, files, and links will appear here.
      </div>
    );
  }

  return (
    <section className="app-contact-profile-summary rounded-[14px] p-1" aria-label="Shared content">
      {rows.map((row) => (
        <SharedProfileRow
          key={row.key}
          icon={row.icon}
          count={row.count}
          singular={row.singular}
          plural={row.plural}
          expanded={row.expanded}
          onClick={row.onClick}
        />
      ))}
      {commonGroupsOpen && commonGroups.length > 0 ? (
        <div className="app-contact-profile-group-list px-1 pb-1 pt-1" role="list" aria-label="Groups in common">
          {commonGroups.map((space) => {
            const content = (
              <>
                <CommonGroupAvatar space={space} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px] font-medium" title={space.title}>
                    {space.title}
                  </span>
                  <span className="mt-0.5 block text-[9.5px] text-[color:var(--app-transient-muted-text)]">
                    {space.participantCount} member{space.participantCount === 1 ? '' : 's'}
                  </span>
                </span>
                {onOpenCommonGroup ? <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
              </>
            );
            return onOpenCommonGroup ? (
              <div key={space.id} role="listitem">
                <button
                  type="button"
                  className="app-contact-profile-group-row flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left"
                  onClick={() => onOpenCommonGroup(space)}
                >
                  {content}
                </button>
              </div>
            ) : (
              <div
                key={space.id}
                className="app-contact-profile-group-row flex min-h-11 items-center gap-2.5 rounded-[10px] px-2 py-1.5"
                role="listitem"
              >
                {content}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
