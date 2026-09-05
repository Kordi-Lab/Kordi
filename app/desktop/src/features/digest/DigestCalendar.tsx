import type { ReactNode } from 'react';
import { CalendarPlus, ChevronLeft, ChevronRight, FileUp } from 'lucide-react';
import { dateKey, eventOnDay, monthDays } from './calendar';
import type { CalendarEvent, DigestItem } from './types';

export function DigestCalendar({ month, selectedDay, events, candidates, onMonth, onDay, onEvent, onCandidate }: {
  month: string; selectedDay: string; events: CalendarEvent[]; candidates: DigestItem[];
  onMonth: (month: string) => void; onDay: (day: string) => void;
  onEvent: (event: CalendarEvent) => void; onCandidate: (item: DigestItem) => void;
}) {
  const monthDate = new Date(`${month}-01T12:00:00`);
  function step(delta: number) { const next = new Date(monthDate); next.setMonth(next.getMonth() + delta); onMonth(dateKey(next).slice(0, 7)); }
  const pending = candidates.filter(item => !events.some(event => event.id === `digest-${item.id}`));
  return <section className="digest-calendar-view" aria-label="Month calendar">
    <div className="digest-month-header">
      <h2>{monthDate.toLocaleDateString(undefined, { month: 'long' })} <span>{monthDate.getFullYear()}</span></h2>
      <div className="digest-month-controls">
        <button aria-label="Previous month" onClick={() => step(-1)}><ChevronLeft size={16}/></button>
        <button onClick={() => { const today = dateKey(new Date()); onMonth(today.slice(0, 7)); onDay(today); }}>Today</button>
        <button aria-label="Next month" onClick={() => step(1)}><ChevronRight size={16}/></button>
      </div>
    </div>
    <div className="digest-calendar-legend"><span><i className="scheduled"/> Scheduled</span><span><i className="proposed"/> To review</span></div>
    <div className="digest-month" role="group" aria-label="Calendar dates">
      <div className="digest-weekdays" aria-hidden="true">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="digest-month-days">
        {monthDays(month).map(day => {
          const scheduled = events.filter(event => eventOnDay(event, day));
          const suggested = pending.filter(item => item.startAt && dateKey(new Date(item.startAt)) === day);
          const total = scheduled.length + suggested.length;
          return <div key={day} className={`${day.startsWith(month) ? '' : 'outside'} ${day === selectedDay ? 'selected' : ''}`}>
            <button className={`digest-day-number ${day === dateKey(new Date()) ? 'today' : ''}`} aria-label={new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'full' })} aria-pressed={day === selectedDay} onClick={() => onDay(day)}>{Number(day.slice(-2))}</button>
            <div className="digest-day-events">
              {scheduled.slice(0, 2).map(event => <button className={`digest-calendar-event ${event.allDay ? 'all-day' : ''}`} key={event.id} title={event.title} onClick={() => onEvent(event)}><span>{event.allDay ? 'All day' : new Date(event.startAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span><strong>{event.title}</strong></button>)}
              {suggested.slice(0, Math.max(0, 2 - scheduled.length)).map(item => <button className="digest-calendar-event proposed" key={item.id} title={`To review: ${item.title}`} onClick={() => onCandidate(item)}><span>{new Date(item.startAt!).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span><strong>{item.title}</strong></button>)}
              {total > 2 && <button className="digest-more" onClick={() => onDay(day)}>+{total - 2} more</button>}
            </div>
          </div>;
        })}
      </div>
    </div>
  </section>;
}

export function DigestAgenda({ day, events, candidates, people, evidence, onEvent, onCandidate, onConnect, onImport }: {
  day: string; events: CalendarEvent[]; candidates: DigestItem[];
  people: (item: DigestItem) => ReactNode; evidence: (item: DigestItem) => ReactNode;
  onEvent: (event: CalendarEvent) => void; onCandidate: (item: DigestItem) => void;
  onConnect: () => void; onImport: () => void;
}) {
  const scheduled = events.filter(event => eventOnDay(event, day));
  return <aside className="digest-agenda" aria-label="Schedule and calendar suggestions">
    <section>
      <h2>{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</h2>
      {scheduled.length ? scheduled.map(event => <button className="digest-agenda-event" key={event.id} onClick={() => onEvent(event)}><span>{event.allDay ? 'All day' : new Date(event.startAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span><strong>{event.title}</strong></button>) : <p className="digest-muted">No events scheduled for this day.</p>}
    </section>
    <section className="digest-proposals">
      <h2>From your chats</h2>
      <p className="digest-muted">Review an arrangement before adding it.</p>
      {candidates.map(item => <article className="digest-proposal" key={item.id}>
        <div className="digest-proposal-label">{events.some(event => event.id === `digest-${item.id}`) ? 'Scheduled' : 'To review'}</div>
        <h3>{item.title}</h3>
        <p className="digest-proposal-time">{item.startAt ? new Date(item.startAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Date or time not agreed'}</p>
        {people(item)}{evidence(item)}
        <button className="digest-primary-action" onClick={() => onCandidate(item)}>{events.some(event => event.id === `digest-${item.id}`) ? 'View event' : 'Review & add'}</button>
      </article>)}
      {!candidates.length && <p className="digest-muted">New arrangements will appear here.</p>}
    </section>
    <section className="digest-calendar-connections">
      <h2>Your calendars</h2>
      <button onClick={onConnect}><CalendarPlus size={16} strokeWidth={1.6} aria-hidden="true"/> Connect calendars</button>
      <button onClick={onImport}><FileUp size={16} strokeWidth={1.6} aria-hidden="true"/> Import ICS</button>
    </section>
  </aside>;
}
