import { useId, useState } from 'react';

import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { defaultMeetSlot, MEET_DURATIONS, meetTimes } from './format';
import { MeetDatePicker, MeetTimePicker } from './MeetPickers';
import { CgAvatar, CgButton } from './parts';
import type { CgMeetInput, CgPerson } from './types';

export type EventTimePerson = Pick<CgPerson, 'accountId' | 'name' | 'avatarUrl'> & { isSelf?: boolean };

/** What the editor opens with: local `YYYY-MM-DD` date, `HH:MM` start, minutes and place. */
export type EventTimeDraft = { title: string; date: string; time: string; minutes: number; location: string };

/** The earliest 15-minute start still ahead, as a local date and time. */
function earliest(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15);
  const pad = (value: number) => String(value).padStart(2, '0');
  return { date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`, time: `${pad(next.getHours())}:${pad(next.getMinutes())}` };
}

/** Duration chips, with the opening length added when it is not one of them. */
function durations(minutes: number): Array<[number, string]> {
  if (MEET_DURATIONS.some(([value]) => value === minutes) || minutes <= 0) return MEET_DURATIONS;
  return [...MEET_DURATIONS, [minutes, `${minutes} min`] as [number, string]].sort((left, right) => left[0] - right[0]);
}

/** A calendar-style event editor: title, date, start, duration, location and who is on it. */
export function EventTimeDialog({ heading, submitLabel, initial, fallbackTitle, people, busy, onCancel, onSubmit }: {
  heading: string;
  submitLabel: string;
  initial?: Partial<EventTimeDraft>;
  fallbackTitle: string;
  people: EventTimePerson[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: CgMeetInput) => void;
}) {
  const titleId = useId();
  const [slot] = useState(() => defaultMeetSlot());
  const [today] = useState(() => earliest());
  const [title, setTitle] = useState(initial?.title ?? fallbackTitle);
  const [date, setDate] = useState(initial?.date && initial.date >= today.date ? initial.date : slot.date);
  const [time, setTime] = useState(initial?.date && initial.date >= today.date && initial.time ? initial.time : slot.time);
  const [minutes, setMinutes] = useState(initial?.minutes ?? 30);
  const [chips] = useState(() => durations(initial?.minutes ?? 30));
  const [location, setLocation] = useState(initial?.location ?? '');
  const minTime = date === today.date ? today.time : null;
  const times = meetTimes(date, time, minutes);
  const place = location.trim();
  const request: CgMeetInput | null = times ? { title: title.trim() || fallbackTitle, ...times, ...(place ? { location: place } : {}) } : null;
  const changeDate = (next: string) => {
    setDate(next);
    if (next === today.date && time < today.time) setTime(today.time);
  };
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-meet max-w-[480px] rounded-[12px] p-6">
      <AppDialogTitle id={titleId}>{heading}</AppDialogTitle>
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
            {chips.map(([value, text]) => (
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
            {people.map((person) => (
              <span key={person.accountId} className="cg-meet-person"><CgAvatar person={person} size={22} isSelf={person.isSelf} />{person.isSelf ? 'You' : person.name}</span>
            ))}
          </div>
        </div>
        <AppDialogActions>
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={busy || !request}>{submitLabel}</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
