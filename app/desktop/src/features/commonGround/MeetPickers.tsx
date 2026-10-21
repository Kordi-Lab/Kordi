import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { meetTimeSlots, shiftMeetDate } from './format';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function localDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function meetDateLabel(date: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(localDate(date));
}

function meetTimeLabel(date: string, time: string) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(`${date}T${time}`));
}

/** Closes an open popover on an outside click or Escape, without letting Escape reach the dialog. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open, close]);
  return ref;
}

function Stepper({ label, value, onPrev, onNext, prevDisabled, onOpen, open, children }: {
  label: string;
  value: string;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  onOpen: () => void;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <div className="cg-meet-stepper">
      <button type="button" className="cg-meet-step" aria-label={`Previous ${label}`} disabled={prevDisabled} onClick={onPrev}>
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" className="cg-meet-value" aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>{value}</button>
      <button type="button" className="cg-meet-step" aria-label={`Next ${label}`} onClick={onNext}>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
      {children}
    </div>
  );
}

/** A date with previous and next day, and a month grid on click. Days before `min` are off. */
export function MeetDatePicker({ value, min, onChange }: { value: string; min: string; onChange: (date: string) => void }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => value.slice(0, 7));
  const ref = useDismiss(open, () => setOpen(false));
  const first = localDate(`${month}-01`);
  const lead = (first.getDay() + 6) % 7;
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
  const shiftMonth = (by: number) => {
    const next = new Date(first.getFullYear(), first.getMonth() + by, 1);
    setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  };
  return (
    <div ref={ref} className="cg-meet-anchor">
      <Stepper
        label="day"
        value={meetDateLabel(value)}
        prevDisabled={value <= min}
        onPrev={() => onChange(shiftMeetDate(value, -1))}
        onNext={() => onChange(shiftMeetDate(value, 1))}
        open={open}
        onOpen={() => { setMonth(value.slice(0, 7)); setOpen(!open); }}
      >
        {open ? (
          <div className="cg-meet-pop cg-meet-month" role="dialog" aria-label="Choose date">
            <div className="cg-meet-month-head">
              <button type="button" className="cg-meet-step" aria-label="Previous month" disabled={month <= min.slice(0, 7)} onClick={() => shiftMonth(-1)}>
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <span>{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(first)}</span>
              <button type="button" className="cg-meet-step" aria-label="Next month" onClick={() => shiftMonth(1)}>
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="cg-meet-grid">
              {WEEKDAYS.map((day, index) => <span key={index} className="cg-meet-weekday" aria-hidden="true">{day}</span>)}
              {Array.from({ length: lead }, (_, index) => <span key={`lead-${index}`} />)}
              {days.map((day) => (
                <button
                  key={day}
                  type="button"
                  className={cn('cg-meet-day', day === value && 'is-on', day === min && 'is-today')}
                  disabled={day < min}
                  aria-label={meetDateLabel(day)}
                  aria-pressed={day === value}
                  onClick={() => { onChange(day); setOpen(false); }}
                >
                  {Number(day.slice(8))}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Stepper>
    </div>
  );
}

/** A start time in 15-minute steps, with a scrolling list on click. Times before `min` (`HH:MM`) are off. */
export function MeetTimePicker({ date, value, min, onChange }: { date: string; value: string; min: string | null; onChange: (time: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const listRef = useRef<HTMLDivElement>(null);
  const slots = meetTimeSlots();
  const index = Math.max(0, slots.indexOf(value));
  const allowed = (slot: string) => !min || slot >= min;
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('.is-on');
    if (list && current) list.scrollTop = current.offsetTop - list.clientHeight / 2 + current.offsetHeight / 2;
  }, [open]);
  return (
    <div ref={ref} className="cg-meet-anchor">
      <Stepper
        label="time"
        value={meetTimeLabel(date, value)}
        prevDisabled={index === 0 || !allowed(slots[index - 1])}
        onPrev={() => onChange(slots[index - 1])}
        onNext={() => onChange(slots[Math.min(slots.length - 1, index + 1)])}
        open={open}
        onOpen={() => setOpen(!open)}
      >
        {open ? (
          <div ref={listRef} className="cg-meet-pop cg-meet-times" role="listbox" aria-label="Start time">
            {slots.map((slot) => (
              <button
                key={slot}
                type="button"
                role="option"
                aria-selected={slot === value}
                className={cn('cg-meet-time', slot === value && 'is-on')}
                disabled={!allowed(slot)}
                onClick={() => { onChange(slot); setOpen(false); }}
              >
                {meetTimeLabel(date, slot)}
              </button>
            ))}
          </div>
        ) : null}
      </Stepper>
    </div>
  );
}
