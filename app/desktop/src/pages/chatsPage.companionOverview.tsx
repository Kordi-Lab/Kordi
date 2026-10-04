import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import DigestPage, { type DigestPanelActions } from '@/features/digest/DigestPage';
import { DigestRelatedLinks } from '@/features/digest/DigestRelatedLinks';
import { digestEventLinks, digestSourceLinks } from '@/features/digest/links';
import { calendarProposalAvailable, proposalLabel } from '@/features/digest/calendarProposal';
import type { DigestState } from '@/features/digest/store';
import type { CalendarEvent, DigestItem, DigestSource } from '@/features/digest/types';
import { dateKey, eventOnDay, monthDays } from '@/features/digest/calendar';
import { DigestPeople } from '@/features/digest/DigestPeople';
import { companionAgendaDays } from './chatsPage.companionCalendarModel';
import type { CompanionView } from './chatsPage.companionToolbar';
import { CompanionTitlebar } from './CompanionTitlebar';

type OverviewView = Exclude<CompanionView, 'chat'>;
type Props = { accountId?: string; view: OverviewView; onClose: () => void };

export default function CompanionOverview({ accountId, view, onClose }: Props) {
  return <aside className="app-companion-overview" aria-label={`${view === 'digest' ? 'Digest' : 'Calendar'} panel`}>
    <CompanionTitlebar>
      <header className="app-page-header app-chat-pane-header app-companion-overview-header">
        <div><h2>{view === 'digest' ? 'Digest' : 'Calendar'}</h2><p>{view === 'digest' ? 'Across your chats' : 'Your Kordi calendar'}</p></div>
        <button type="button" aria-label="Hide panel" title="Hide panel" onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
    </CompanionTitlebar>
    {accountId ? <ConnectedOverview key={accountId} accountId={accountId} view={view} />
      : <p className="app-companion-status">Sign in to see your {view === 'digest' ? 'digest' : 'calendar'}.</p>}
  </aside>;
}

function ConnectedOverview({ accountId, view }: { accountId: string; view: OverviewView }) {
  return <DigestPage accountId={accountId} renderContent={({ state, actions }) => <CompanionOverviewContent accountId={accountId} view={view} state={state} actions={actions} onRetry={() => { void state.reload().catch(() => {}); }} />} />;
}

export function CompanionOverviewContent({ accountId, view, state, onRetry, actions }: {
  accountId: string; view: OverviewView; state: DigestState; onRetry: () => void; actions?: DigestPanelActions;
}) {
  if (view === 'digest') return <CompanionDigest accountId={accountId} state={state} onRetry={onRetry} actions={actions} />;
  const sources = state.digest?.sources ?? [];
  const proposals = state.digest?.snapshot?.calendarCandidates.filter(item => calendarProposalAvailable(item, state.events)) ?? [];
  return <CompanionCalendar
    events={state.events} loaded={state.calendarLoaded} error={state.calendarError}
    onRetry={onRetry} onEvent={actions?.onEvent} sources={sources}
    footer={<>
      {proposals.length > 0 ? <section className="app-companion-proposals" aria-label="Calendar proposals">
        <h3>From your chats</h3>
        {proposals.map(item => <article className="app-companion-proposal" key={item.id}>
          <h4>{item.title}</h4>
          <DigestPeople item={item} sources={sources} accountId={accountId} onSource={actions?.onSource} />
          <DigestRelatedLinks links={digestSourceLinks(item.sourceIds, sources)} />
          <button type="button" disabled={!actions || actions.busy} onClick={() => actions?.onCandidate(item)}>{proposalLabel(item, state.events)}</button>
        </article>)}
      </section> : null}
      {actions?.calendarTools}
    </>}
  />;
}

function CompanionDigest({ accountId, state, onRetry, actions }: { accountId: string; state: DigestState; onRetry: () => void; actions?: DigestPanelActions }) {
  const { digest, digestError } = state;
  const snapshot = digest?.snapshot;
  const dismissed = new Set(digest?.feedback.filter(item => item.status === 'dismissed').map(item => item.id));
  const sections: [string, DigestItem[]][] = [
    ['Brief', snapshot?.claims ?? []],
    ['Commitments', snapshot?.commitments ?? []],
    ['Next steps', snapshot?.suggestions ?? []],
  ];
  const unavailable = digest?.errorCode === 'missing_provider_auth' ? 'Connect a model provider in Settings to prepare your digest.'
    : digest?.errorCode === 'provider_auth_rejected' ? 'Your model provider sign-in needs attention in Settings.'
    : digest?.status === 'error' ? 'Your digest is unavailable right now.'
    : digest?.status === 'loading' || digest?.status === 'updating' ? 'Preparing your digest…'
    : !digest ? 'Loading digest…' : 'No conversations to summarize yet.';
  return <div className="app-companion-overview-scroll" tabIndex={0} aria-label="Digest content">
    {actions ? <button type="button" className="app-companion-refresh" disabled={actions.busy || digest?.status === 'updating'} onClick={actions.onRefresh}>Refresh digest</button> : null}
    {digestError ? <ReadError label="Digest" onRetry={onRetry} /> : null}
    {!snapshot ? <p className="app-companion-status" role="status">{digestError ? 'The digest could not be loaded.' : unavailable}</p>
      : <>
        <p className="app-companion-freshness" role="status">{digest?.status === 'updating' ? 'Updating…' : digest?.updatedAt ? `Updated ${new Date(digest.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Latest digest'}</p>
        {digest?.status === 'error' ? <p className="app-companion-status">The latest update failed. Showing the last available digest.</p> : null}
        {sections.map(([label, items]) => <section className="app-companion-digest-section" key={label}>
          <h3>{label}</h3>
          {items.filter(item => !dismissed.has(item.id)).map(item => <article key={item.id}>
            <h4>{item.title}</h4><p>{item.text}</p>
            <DigestPeople item={item} sources={digest?.sources ?? []} accountId={accountId} onSource={actions?.onSource} />
            {actions && item.sourceIds.length ? <button type="button" className="app-companion-source" onClick={() => actions.onSource(item.sourceIds)}>View source messages</button> : null}
            <DigestRelatedLinks links={digestSourceLinks(item.sourceIds, digest?.sources ?? [])} />
            {actions ? <button type="button" aria-label={`Dismiss ${item.title}`} disabled={actions.busy || actions.feedbackPending(item.id)} onClick={() => actions.onFeedback(item.id, true)}>Dismiss</button> : null}
          </article>)}
          {actions && items.some(item => dismissed.has(item.id)) ? <button type="button" disabled={actions.busy || items.some(item => actions.feedbackPending(item.id))} onClick={() => items.filter(item => dismissed.has(item.id)).forEach(item => actions.onFeedback(item.id, false))}>Restore dismissed entries</button> : null}
          {!items.some(item => !dismissed.has(item.id)) ? <p className="app-companion-status">Nothing to show yet.</p> : null}
        </section>)}
      </>}
  </div>;
}

function ReadError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return <p className="app-companion-status" role="alert">{label} could not refresh. <button type="button" onClick={onRetry}>Try again</button></p>;
}


function eventDuration(event: CalendarEvent) {
  if (event.allDay || !event.endAt) return '';
  const minutes = Math.round((Date.parse(event.endAt) - Date.parse(event.startAt)) / 60_000);
  if (minutes <= 0 || !Number.isFinite(minutes)) return '';
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
}

export function CompanionCalendar({ events, loaded, error, onRetry, onEvent, sources = [], footer }: {
  events: CalendarEvent[]; loaded: boolean; error: string | null; onRetry: () => void;
  onEvent?: (event: CalendarEvent) => void; sources?: DigestSource[]; footer?: ReactNode;
}) {
  const today = dateKey(new Date());
  const [selectedDay, setSelectedDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const grid = useRef<HTMLDivElement>(null);
  const agenda = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (agenda.current) agenda.current.scrollTop = 0; }, [selectedDay]);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    grid.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    restoreFocus.current = false;
  }, [selectedDay]);
  const selectDay = (day: string) => { setSelectedDay(day); setMonth(day.slice(0, 7)); };
  const stepMonth = (delta: number) => {
    const date = new Date(`${month}-01T12:00:00`);
    date.setMonth(date.getMonth() + delta);
    selectDay(dateKey(date));
  };
  const tomorrowDate = new Date(`${today}T12:00:00`);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = dateKey(tomorrowDate);
  const days = companionAgendaDays(selectedDay, events);
  return <div className="app-companion-calendar">
    <section className="app-companion-month" aria-label="Calendar dates">
      <div className="app-companion-month-heading">
        <h3>{new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
        <button type="button" aria-label="Previous month" title="Previous month" onClick={() => stepMonth(-1)}><ChevronLeft size={16} aria-hidden="true" /></button>
        <button type="button" onClick={() => selectDay(today)}>Today</button>
        <button type="button" aria-label="Next month" title="Next month" onClick={() => stepMonth(1)}><ChevronRight size={16} aria-hidden="true" /></button>
      </div>
      <div className="app-companion-date-grid" aria-hidden="true">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, i) => <span key={i}>{day}</span>)}</div>
      <div className="app-companion-date-grid" ref={grid}>
        {monthDays(month).map(day => <button key={day} type="button"
          aria-label={new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'full' })}
          aria-pressed={selectedDay === day} aria-current={day === today ? 'date' : undefined}
          tabIndex={selectedDay === day ? 0 : -1} data-outside={!day.startsWith(month)}
          onClick={() => selectDay(day)} onKeyDown={event => {
            const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
            if (offset === undefined) return;
            event.preventDefault();
            const date = new Date(`${day}T12:00:00`);
            date.setDate(date.getDate() + offset);
            restoreFocus.current = true;
            selectDay(dateKey(date));
          }}>
          {Number(day.slice(-2))}<span className="app-companion-event-dot" data-has-events={events.some(event => eventOnDay(event, day))} aria-hidden="true" />
        </button>)}
      </div>
    </section>
    <div ref={agenda} className="app-companion-overview-scroll app-companion-agenda" tabIndex={0} aria-label="Seven-day agenda">
      <p className="app-companion-freshness">{Intl.DateTimeFormat().resolvedOptions().timeZone} · 7 days from selected date</p>
      {error ? <ReadError label="Calendar" onRetry={onRetry} /> : null}
      {!loaded ? <p className="app-companion-status" role="status">{error ? 'Calendar is unavailable.' : 'Loading calendar…'}</p>
        : days.map(({ day, events: scheduled }) => <section key={day}>
          <h3>{day === today ? 'Today' : day === tomorrow ? 'Tomorrow' : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</h3>
          {scheduled.length ? scheduled.map(event => <article className="app-companion-agenda-entry" key={event.id}>
            <button type="button" className="app-companion-agenda-event" aria-label={`Open event ${event.title}`} disabled={!onEvent} onClick={() => onEvent?.(event)}>
              <span className="app-companion-event-time">{event.allDay ? 'All day' : new Date(event.startAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
              <span className="app-companion-event-summary"><strong>{event.title}</strong>{eventDuration(event) ? <small>{eventDuration(event)}</small> : null}</span>
            </button>
            <DigestRelatedLinks links={digestEventLinks(event, sources)} />
          </article>) : <p className="app-companion-status">No events scheduled.</p>}
        </section>)}
      {footer}
    </div>
  </div>;
}
