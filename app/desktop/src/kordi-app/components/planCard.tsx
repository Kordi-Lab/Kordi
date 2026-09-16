import { CalendarCheck, CalendarClock, Check, ChevronRight, MapPin, Vote, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { defaultCloudAuthClient, type PlanCardActionRequest } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import type { MessagePlanCard, MessagePlanCardOption } from '@/kordi-app/types/message';
import { planCardView } from '@/features/cloud/planCardSnapshot';

const STATE_LABEL: Record<MessagePlanCard['state'], string> = {
  polling: 'Planning',
  awaiting_confirmation: 'Leaning yes',
  confirmed: 'Confirmed',
  canceled: 'Canceled',
};

function formatWhen(startAt?: string | null, endAt?: string | null): string | null {
  if (!startAt) return null;
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return null;
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(start);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(start);
  const end = endAt ? new Date(endAt) : null;
  const endLabel = end && !Number.isNaN(end.getTime())
    ? ` – ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(end)}`
    : '';
  return `${date} · ${time}${endLabel}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

function leadingOption(options: MessagePlanCardOption[]): MessagePlanCardOption | null {
  let best: MessagePlanCardOption | null = null;
  for (const option of options) {
    if (option.votes.length === 0) continue;
    if (!best || option.votes.length > best.votes.length) best = option;
  }
  return best;
}

/**
 * The shared plan card Pip manages for a chat. The snapshot comes from Pip's
 * message; buttons act for the signed-in member, and the card refreshes for
 * everyone through the same message. Pip decides in chat what happens next.
 */
export function PlanCardContent({
  card,
  ownAccountId,
}: {
  card: MessagePlanCard;
  ownAccountId?: string | null;
}) {
  const [sessionAccountId, setSessionAccountId] = useState<string | null>(ownAccountId ?? null);
  useEffect(() => {
    if (ownAccountId) return;
    let cancelled = false;
    void loadSession().then((session) => {
      if (!cancelled) setSessionAccountId(session?.accountId ?? null);
    });
    return () => { cancelled = true; };
  }, [ownAccountId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localState, setLocalState] = useState<MessagePlanCard | null>(null);
  // Which people list is open: `attendees`, or `voters:<optionId>`.
  const [panel, setPanel] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!panel) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !cardRef.current?.contains(event.target as Node)) setPanel(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [panel]);
  // A click updates the card at once; a newer snapshot from the transcript
  // then takes over, so the card never sticks on an old local result.
  const view = localState && localState.revision > card.revision ? { ...localState, view: card.view } : card;
  const isVote = planCardView(card) === 'vote';
  const accountId = ownAccountId ?? sessionAccountId;
  const self = accountId ? view.participants.find((participant) => participant.participantId === accountId) : undefined;
  const options = view.options ?? [];
  const polling = isVote && view.state === 'polling' && options.length > 0;
  const isOpen = view.state !== 'canceled';
  const canRespond = !isVote && Boolean(self) && isOpen;
  const leading = isVote ? leadingOption(options) : null;
  const canConfirm = Boolean(self?.organizer) && (isVote ? polling && leading !== null : view.state === 'awaiting_confirmation');
  const onCalendar = !isVote && view.state === 'confirmed' && self?.rsvp === 'yes' && Boolean(view.startAt);
  const voterCount = new Set(options.flatMap((option) => option.votes)).size;
  const when = formatWhen(view.startAt, view.endAt);
  const going = view.participants.filter((participant) => participant.rsvp === 'yes').length;
  const nameOf = (participantId: string) => view.participants.find((participant) => participant.participantId === participantId)?.displayName ?? 'Member';
  const totalVotes = options.reduce((sum, option) => sum + option.votes.length, 0);
  const percentOf = (option: MessagePlanCardOption) => (totalVotes === 0 ? 0 : Math.round((option.votes.length / totalVotes) * 100));

  const act = async (label: string, request: PlanCardActionRequest) => {
    if (busy) return;
    setBusy(label);
    setNotice(null);
    try {
      const session = await loadSession();
      if (!session?.token) {
        setNotice('Sign in to respond.');
        return;
      }
      const updated = await defaultCloudAuthClient().planCardAction(session.token, request);
      setLocalState(updated);
    } catch (error) {
      setLocalState(null);
      setNotice(error instanceof Error ? error.message : 'Could not update the plan.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section ref={cardRef} className={cn('app-plan-card', isVote ? 'app-plan-card-vote' : 'app-plan-card-event')} data-kordi-copy-surface="message" data-plan-card-state={view.state} data-plan-card-view={isVote ? 'vote' : 'event'} aria-label={`${isVote ? 'Vote' : 'Plan'}: ${view.title}`}>
      <div className="app-plan-card-head">
        {isVote
          ? <Vote size={14} aria-hidden className="app-plan-card-icon" />
          : view.state === 'confirmed'
            ? <CalendarCheck size={14} aria-hidden className="app-plan-card-icon" />
            : <CalendarClock size={14} aria-hidden className="app-plan-card-icon" />}
        <div className="app-plan-card-heading">
          <div className={cn('app-plan-card-title', view.state === 'canceled' && 'line-through opacity-60')}>{view.title}</div>
          <div className="app-plan-card-meta">
            {isVote ? (
              <span>{voterCount === 0 ? 'No votes yet' : `${voterCount} of ${view.participants.length} voted`}</span>
            ) : (
              <>
                {when ? <span>{when}</span> : null}
                {view.location ? <span><MapPin size={11} aria-hidden /> {view.location}</span> : null}
                {view.unresolvedFields.length > 0 ? <span className="app-plan-card-unresolved">still open: {view.unresolvedFields.join(', ')}</span> : null}
              </>
            )}
          </div>
        </div>
        <span className={cn('app-plan-card-state', `app-plan-card-state-${isVote && view.state === 'confirmed' ? 'decided' : view.state}`)}>
          {isVote
            ? polling ? 'Vote' : view.state === 'canceled' ? 'Canceled' : 'Decided'
            : view.state === 'confirmed' && view.participants.length > 0 ? `${going} going` : STATE_LABEL[view.state]}
        </span>
      </div>

      {isVote ? (
        <div className="app-plan-card-options" role="group" aria-label="Options">
          {options.map((option) => {
            const mine = accountId ? option.votes.includes(accountId) : false;
            const percent = percentOf(option);
            const winner = !polling && view.state === 'confirmed' && leading?.id === option.id;
            return (
              <div key={option.id} className={cn('app-plan-card-option', mine && 'app-plan-card-option-mine', winner && 'app-plan-card-option-winner')}>
                <button
                  type="button"
                  className="app-plan-card-option-vote"
                  disabled={Boolean(busy) || !self || !polling}
                  aria-pressed={mine}
                  title="Right-click to see who voted"
                  onClick={() => { void act(`vote:${option.id}`, { action: 'vote', eventId: view.eventId, participantId: accountId ?? '', optionId: option.id }); }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setPanel((current) => (current === `voters:${option.id}` ? null : `voters:${option.id}`));
                  }}
                >
                  <span className="app-plan-card-option-fill" style={{ width: `${percent}%` }} aria-hidden />
                  <span className="app-plan-card-option-mark" aria-hidden>{mine ? <Check size={11} /> : null}</span>
                  <span className="app-plan-card-option-label">{option.label}</span>
                  <span className="app-plan-card-option-percent">{percent}%</span>
                </button>
                {panel === `voters:${option.id}` ? (
                  <PlanCardPeopleList
                    label={`Votes for ${option.label}`}
                    ownAccountId={accountId}
                    sections={[{ title: 'Voted', people: option.votes.map((voter) => ({ id: voter, name: nameOf(voter), organizer: false })) }]}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <PlanCardAttendees
          participants={view.participants}
          ownAccountId={accountId}
          open={panel === 'attendees'}
          onToggle={() => setPanel((current) => (current === 'attendees' ? null : 'attendees'))}
        />
      )}

      {canRespond || canConfirm ? (
        <div className="app-plan-card-actions">
          {canRespond ? (
            <>
              <button
                type="button"
                className={cn('app-plan-card-button', self?.rsvp === 'no' && 'app-plan-card-button-active')}
                disabled={Boolean(busy)}
                onClick={() => { void act('no', { action: 'rsvp', eventId: view.eventId, participantId: accountId ?? '', rsvp: 'no' }); }}
              >
                <X size={12} aria-hidden /> Can't make it
              </button>
              <button
                type="button"
                className={cn('app-plan-card-button', self?.rsvp === 'yes' ? 'app-plan-card-button-active' : 'app-plan-card-button-primary')}
                disabled={Boolean(busy)}
                onClick={() => { void act('yes', { action: 'rsvp', eventId: view.eventId, participantId: accountId ?? '', rsvp: 'yes' }); }}
              >
                <Check size={12} aria-hidden /> I'm in
              </button>
            </>
          ) : null}
          {canConfirm ? (
            <button
              type="button"
              className="app-plan-card-button app-plan-card-button-primary"
              disabled={Boolean(busy)}
              title={leading ? `Confirm ${leading.label} for everyone` : 'Confirm for everyone'}
              onClick={() => { void act('confirm', { action: 'confirm', eventId: view.eventId, revision: view.revision, confirmedBy: accountId ?? '', ...(leading ? { optionId: leading.id } : {}) }); }}
            >
              Confirm
            </button>
          ) : null}
        </div>
      ) : null}
      {onCalendar ? <div className="app-plan-card-calendar-note"><CalendarCheck size={11} aria-hidden /> On your calendar</div> : null}
      {notice ? <div className="app-plan-card-notice" role="status">{notice}</div> : null}
    </section>
  );
}

function compactCount(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

type PeopleSection = { title: string; people: { id: string; name: string; organizer: boolean }[] };

const PEOPLE_RENDER_LIMIT = 200;

/**
 * Everyone on a plan, or everyone who chose an option. Stays small for any
 * group size: a scrolling list with search, rendering at most a few hundred
 * matches at a time.
 */
function PlanCardPeopleList({ label, sections, ownAccountId }: { label: string; sections: PeopleSection[]; ownAccountId?: string | null }) {
  const [query, setQuery] = useState('');
  const total = sections.reduce((sum, section) => sum + section.people.length, 0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matched = sections.map((section) => ({
      ...section,
      count: section.people.length,
      all: needle ? section.people.filter((person) => person.name.toLocaleLowerCase().includes(needle)) : section.people,
    }));
    // Render at most PEOPLE_RENDER_LIMIT rows across all sections, in order.
    const offsets = matched.map((_, index) => matched.slice(0, index).reduce((sum, section) => sum + section.all.length, 0));
    return matched.map((section, index) => ({
      ...section,
      matches: section.all.length,
      shown: section.all.slice(0, Math.max(0, PEOPLE_RENDER_LIMIT - offsets[index])),
    }));
  }, [query, sections]);
  const hiddenMatches = filtered.reduce((sum, section) => sum + section.matches - section.shown.length, 0);
  return (
    <div className="app-plan-card-people-list" role="dialog" aria-label={label}>
      {total > 8 ? (
        <input
          className="app-plan-card-people-search"
          type="search"
          placeholder={`Search ${compactCount(total)} people`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search people"
        />
      ) : null}
      <div className="app-plan-card-people-scroll">
        {total === 0 ? <div className="app-plan-card-people-empty">No one yet</div> : null}
        {filtered.map((section) => (section.shown.length === 0 ? null : (
          <div key={section.title} className="app-plan-card-people-section">
            <div className="app-plan-card-people-heading">{section.title} · {compactCount(section.count)}</div>
            {section.shown.map((person) => (
              <div key={person.id} className="app-plan-card-people-row">
                <span className="app-plan-card-avatar">{initials(person.name)}</span>
                <span className="app-plan-card-people-name">{person.name}{person.id === ownAccountId ? ' (you)' : ''}</span>
                {person.organizer ? <span className="app-plan-card-people-role">Organizer</span> : null}
              </div>
            ))}
          </div>
        )))}
        {hiddenMatches > 0 ? <div className="app-plan-card-people-empty">{compactCount(hiddenMatches)} more; search to narrow down</div> : null}
      </div>
    </div>
  );
}

/** A few avatars and short counts on the card; the full list opens on click. */
function PlanCardAttendees({ participants, ownAccountId, open, onToggle }: {
  participants: MessagePlanCard['participants'];
  ownAccountId?: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const going = participants.filter((participant) => participant.rsvp === 'yes');
  const declined = participants.filter((participant) => participant.rsvp === 'no');
  const waiting = participants.filter((participant) => participant.rsvp === 'pending');
  const shown = [...going, ...waiting, ...declined].slice(0, 4);
  const hidden = participants.length - shown.length;
  const counts = [`${compactCount(going.length)} going`, ...(declined.length ? [`${compactCount(declined.length)} can't`] : []), ...(waiting.length ? [`${compactCount(waiting.length)} no reply`] : [])].join(' · ');
  const toPeople = (list: typeof participants) => list.map((participant) => ({ id: participant.participantId, name: participant.displayName, organizer: participant.organizer }));
  return (
    <div className="app-plan-card-attendees-wrap">
      <button type="button" className="app-plan-card-attendees" onClick={onToggle} aria-expanded={open}>
        <span className="app-plan-card-avatar-stack" aria-hidden>
          {shown.map((participant) => (
            <span key={participant.participantId} className={cn('app-plan-card-avatar', `app-plan-card-avatar-${participant.rsvp}`)}>{initials(participant.displayName)}</span>
          ))}
          {hidden > 0 ? <span className="app-plan-card-avatar app-plan-card-avatar-more">+{compactCount(hidden)}</span> : null}
        </span>
        <span className="app-plan-card-attendees-counts">{counts}</span>
        <ChevronRight size={12} aria-hidden className={cn('app-plan-card-attendees-chevron', open && 'rotate-90')} />
      </button>
      {open ? (
        <PlanCardPeopleList
          label="People on this plan"
          ownAccountId={ownAccountId}
          sections={[
            { title: 'Going', people: toPeople(going) },
            { title: "Can't make it", people: toPeople(declined) },
            { title: 'No reply', people: toPeople(waiting) },
          ]}
        />
      ) : null}
    </div>
  );
}
