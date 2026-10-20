import { useId, useState } from 'react';

import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { defaultMeetSlot, MEET_DURATIONS, meetRequest } from './format';
import { MeetDatePicker, MeetTimePicker } from './MeetPickers';
import { CgAvatar, CgButton } from './parts';
import type { CgMeetInput, CgPerson } from './types';

type MeetPerson = Pick<CgPerson, 'accountId' | 'name' | 'avatarUrl'>;

/** The earliest 15-minute start still ahead, as a local date and time. */
function earliest(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15);
  const pad = (value: number) => String(value).padStart(2, '0');
  return { date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`, time: `${pad(next.getHours())}:${pad(next.getMinutes())}` };
}

/** Meet a contact: a calendar-style event that posts a plan card into your chat. */
export function MeetDialog({ self, person, busy, onCancel, onSubmit }: {
  self: MeetPerson;
  person: MeetPerson;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: CgMeetInput) => void;
}) {
  const titleId = useId();
  const [slot] = useState(() => defaultMeetSlot());
  const [today] = useState(() => earliest());
  const [title, setTitle] = useState(`Meet ${person.name}`);
  const [date, setDate] = useState(slot.date);
  const [time, setTime] = useState(slot.time);
  const [minutes, setMinutes] = useState(30);
  const [location, setLocation] = useState('');
  const minTime = date === today.date ? today.time : null;
  const request = meetRequest({ name: person.name, title, date, time, minutes, location });
  const changeDate = (next: string) => {
    setDate(next);
    if (next === today.date && time < today.time) setTime(today.time);
  };
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-meet max-w-[480px] rounded-[12px] p-6">
      <AppDialogTitle id={titleId}>Meet</AppDialogTitle>
      <form
        className="cg-meet-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (request) onSubmit(request);
        }}
      >
        <label className="cg-meet-field">
          <span>Title</span>
          <input className="cg-meet-input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
        </label>
        <div className="cg-meet-pair">
          <div className="cg-meet-field" role="group" aria-label="Date">
            <span>Date</span>
            <MeetDatePicker value={date} min={today.date} onChange={changeDate} />
          </div>
          <div className="cg-meet-field" role="group" aria-label="Start">
            <span>Start</span>
            <MeetTimePicker date={date} value={time} min={minTime} onChange={setTime} />
          </div>
        </div>
        <div className="cg-meet-field" role="group" aria-label="Duration">
          <span>Duration</span>
          <div className="cg-meet-chips">
            {MEET_DURATIONS.map(([value, text]) => (
              <button key={value} type="button" className={cn('cg-meet-chip', minutes === value && 'is-on')} aria-pressed={minutes === value} onClick={() => setMinutes(value)}>
                {text}
              </button>
            ))}
          </div>
        </div>
        <label className="cg-meet-field">
          <span>Location</span>
          <input className="cg-meet-input" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Optional" maxLength={200} />
        </label>
        <div className="cg-meet-field" role="group" aria-label="People">
          <span>People</span>
          <div className="cg-meet-people">
            <span className="cg-meet-person"><CgAvatar person={self} size={22} isSelf />You</span>
            <span className="cg-meet-person"><CgAvatar person={person} size={22} />{person.name}</span>
          </div>
        </div>
        <AppDialogActions>
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={busy || !request}>Send</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
