import { useMemo, useState } from 'react';

import { CommonGroundHugIcon } from '@/features/commonGround/CommonGroundHugIcon';
import type { ParticipantSpaceViewModel } from '../types';
import { ContactsListSection } from './ContactsListSection';
import { GroupAvatar } from '../components/GroupAvatar';
import { GROUP_ROWS_PREVIEW, contactsGroupRows, visibleGroupRows } from './contactsGroupRows';
import { isGroundingGroupSpace } from './groundingGroup';

function peopleLabel(space: ParticipantSpaceViewModel) {
  const count = space.participants.filter((participant) => participant.kind === 'human').length;
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

/** The group's own picture, else its human members' avatars (agents left out). */
function GroupTile({ space }: { space: ParticipantSpaceViewModel }) {
  const humans = space.avatarStack.filter((avatar) => avatar.kind === 'human');
  return <GroupAvatar avatars={humans.length ? humans : space.avatarStack} imageUrl={space.groupAvatar?.imageUrl} name={space.title} className="h-[30px] w-[30px] rounded-[8px]" />;
}

function ContactsGroupRow({ space, onOpen }: { space: ParticipantSpaceViewModel; onOpen: () => void }) {
  const meta = [peopleLabel(space), space.updatedAtLabel].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onOpen}
      className="app-contact-row app-group-row flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1 text-left transition-none"
    >
      <GroupTile space={space} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold leading-4">{space.title}</div>
        <div className="app-contact-row-meta mt-0.5 flex min-w-0 items-center gap-1 text-[10.5px] leading-4">
          {isGroundingGroupSpace(space) ? (
            <span className="inline-flex shrink-0" role="img" aria-label="Grounding">
              <CommonGroundHugIcon className="h-[11px] w-[11px]" />
            </span>
          ) : null}
          <span className="min-w-0 truncate">{meta}</span>
        </div>
      </div>
    </button>
  );
}

/** Collapsible Groups block in the Contacts list; hidden when no group matches. */
export function ContactsGroupsSection({
  spaces,
  search,
  onOpenGroup,
}: {
  spaces: readonly ParticipantSpaceViewModel[];
  search: string;
  onOpenGroup: (space: ParticipantSpaceViewModel) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => contactsGroupRows(spaces, search), [spaces, search]);
  if (rows.length === 0) return null;
  const visible = visibleGroupRows(rows, search, showAll);
  const canToggle = !search.trim() && rows.length > GROUP_ROWS_PREVIEW;
  return (
    <ContactsListSection label="Groups" count={rows.length} expanded={expanded} onToggle={() => setExpanded((open) => !open)}>
      {visible.map((space) => (
        <ContactsGroupRow key={space.id} space={space} onOpen={() => onOpenGroup(space)} />
      ))}
      {canToggle ? (
        <button type="button" className="app-group-show-all text-left text-[11px] leading-4" onClick={() => setShowAll((all) => !all)}>
          {showAll ? 'Show less' : `Show all ${rows.length}`}
        </button>
      ) : null}
    </ContactsListSection>
  );
}
