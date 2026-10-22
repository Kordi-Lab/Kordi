import { useMemo, useState } from 'react';

import { GroupAvatar } from '../components/GroupAvatar';
import type { ParticipantSpaceViewModel } from '../types';
import { ContactsListSection } from './ContactsListSection';
import { contactsGroupRows } from './contactsGroupRows';

function peopleLabel(space: ParticipantSpaceViewModel) {
  const count = space.participants.filter((participant) => participant.kind === 'human').length;
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

function ContactsGroupRow({ space, onOpen }: { space: ParticipantSpaceViewModel; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="app-contact-row app-list-item flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1 text-left transition-none"
    >
      <GroupAvatar avatars={space.avatarStack} imageUrl={space.groupAvatar?.imageUrl} name={space.title} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold leading-4" title={space.title}>{space.title}</div>
        <div className="app-contact-row-meta mt-0.5 truncate text-[10.5px] leading-4">{peopleLabel(space)}</div>
      </div>
      {space.updatedAtLabel ? (
        <span className="app-contact-row-meta shrink-0 text-[10.5px] leading-4">{space.updatedAtLabel}</span>
      ) : null}
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
  const rows = useMemo(() => contactsGroupRows(spaces, search), [spaces, search]);
  if (rows.length === 0) return null;
  return (
    <ContactsListSection label="Groups" count={rows.length} expanded={expanded} onToggle={() => setExpanded((open) => !open)}>
      {rows.map((space) => (
        <ContactsGroupRow key={space.id} space={space} onOpen={() => onOpenGroup(space)} />
      ))}
    </ContactsListSection>
  );
}
