import { useId, useState } from 'react';

import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';
import { defaultMeetSlot, meetTimes } from './format';
import { CgButton } from './parts';

const DURATIONS = [30, 60, 90];

export function MeetDialog({ name, busy, onCancel, onSubmit }: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { title: string; startAt: string; endAt: string }) => void;
}) {
  const titleId = useId();
  const slot = defaultMeetSlot();
  const [title, setTitle] = useState(`Meet ${name}`);
  const [date, setDate] = useState(slot.date);
  const [time, setTime] = useState(slot.time);
  const [minutes, setMinutes] = useState(30);
  const times = meetTimes(date, time, minutes);
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy}>
      <AppDialogTitle id={titleId}>Meet</AppDialogTitle>
      <form
        className="cg-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (times) onSubmit({ title: title.trim() || `Meet ${name}`, ...times });
        }}
      >
        <input className="cg-input" value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" maxLength={120} />
        <div className="cg-form-row">
          <input className="cg-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Date" />
          <input className="cg-input" type="time" value={time} onChange={(event) => setTime(event.target.value)} aria-label="Start time" />
          <select className="cg-input" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} aria-label="Duration">
            {DURATIONS.map((value) => <option key={value} value={value}>{value} min</option>)}
          </select>
        </div>
        <AppDialogActions>
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={busy || !times}>Send</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
