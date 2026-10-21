import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Images,
  Link,
  Users,
} from 'lucide-react';

import { GroupAvatar } from '@/kordi-app/components/GroupAvatar';
import type { ParticipantSpaceViewModel } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import type { ContactProfileSharedPage } from '@/pages/contactProfileSharedItems';
import type { ContactProfileSharedSummary } from '@/pages/memberContactProfileModel';

type SharedSummaryRow = {
  key: string;
  icon: ReactNode;
  label: string;
  count: number;
  expanded?: boolean;
  onClick?: () => void;
};

function SharedProfileRow({
  icon,
  label,
  count,
  expanded,
  onClick,
}: Omit<SharedSummaryRow, 'key'>) {
  const zero = count === 0;
  const Chevron = expanded === undefined ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      className={cn(
        'app-contact-profile-summary-row app-contact-profile-summary-trigger flex min-h-[38px] w-full items-center gap-2.5 px-2.5 text-left',
        zero && 'is-zero',
      )}
      onClick={onClick}
      disabled={zero || !onClick}
      aria-expanded={zero ? undefined : expanded}
    >
      <span className="app-contact-profile-summary-icon grid h-5 w-5 shrink-0 place-items-center">
        {icon}
      </span>
      <span className="app-contact-profile-summary-label min-w-0 flex-1 truncate text-[13px]">{label}</span>
      <span className="app-contact-profile-summary-count text-[12px] tabular-nums">{count}</span>
      <Chevron
        className={cn('app-contact-profile-summary-chevron h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-180')}
        aria-hidden="true"
      />
    </button>
  );
}

export function ContactProfileSharedContent({
  commonGroups,
  onOpenCommonGroup,
  onOpenPage,
  summary,
}: {
  commonGroups: ParticipantSpaceViewModel[];
  onOpenCommonGroup?: (space: ParticipantSpaceViewModel) => void;
  onOpenPage?: (page: ContactProfileSharedPage) => void;
  summary: ContactProfileSharedSummary;
}) {
  const [commonGroupsOpen, setCommonGroupsOpen] = useState(false);
  const pageRow = (key: ContactProfileSharedPage, icon: ReactNode, label: string): SharedSummaryRow => ({
    key,
    icon,
    label,
    count: summary[key],
    onClick: onOpenPage ? () => onOpenPage(key) : undefined,
  });
  const rows: SharedSummaryRow[] = [
    pageRow('photos', <Images className="h-4 w-4" />, 'Photos'),
    pageRow('files', <FileText className="h-4 w-4" />, 'Files'),
    pageRow('links', <Link className="h-4 w-4" />, 'Links'),
    {
      key: 'groups',
      icon: <Users className="h-4 w-4" />,
      label: 'Groups in common',
      count: summary.commonGroups,
      expanded: commonGroupsOpen,
      onClick: () => setCommonGroupsOpen((open) => !open),
    },
  ];

  if (rows.every((row) => row.count === 0)) {
    return (
      <div className="app-contact-profile-empty rounded-[14px] px-3 py-2.5 text-[13px] leading-5">
        Nothing shared yet
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
          label={row.label}
          expanded={row.expanded}
          onClick={row.onClick}
        />
      ))}
      {commonGroupsOpen && commonGroups.length > 0 ? (
        <div className="app-contact-profile-group-list px-1 pb-1 pt-1" role="list" aria-label="Groups in common">
          {commonGroups.map((space) => {
            const content = (
              <>
                <GroupAvatar
                  avatars={space.avatarStack}
                  imageUrl={space.groupAvatar?.imageUrl}
                  name={space.title}
                  className="h-7 w-7"
                />
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
