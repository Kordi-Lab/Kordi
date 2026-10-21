import { EventTimeDialog } from './EventTimeDialog';
import type { CgMeetInput, CgPerson } from './types';

type MeetPerson = Pick<CgPerson, 'accountId' | 'name' | 'avatarUrl'>;

/** Meet a contact: a calendar-style event that posts a plan card into your chat. */
export function MeetDialog({ self, person, busy, onCancel, onSubmit }: {
  self: MeetPerson;
  person: MeetPerson;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: CgMeetInput) => void;
}) {
  return (
    <EventTimeDialog
      heading="Meet"
      submitLabel="Send"
      fallbackTitle={`Meet ${person.name}`}
      people={[{ ...self, isSelf: true }, person]}
      busy={busy}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}
