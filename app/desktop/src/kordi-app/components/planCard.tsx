import { CalendarClock, Check, MapPin, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { defaultCloudAuthClient, type PlanCardActionRequest } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import type { MessagePlanCard, MessagePlanCardOption } from '@/kordi-app/types/message';

const STATE_LABEL: Record<MessagePlanCard['state'], string> = {
  polling: 'Vote',
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
  // A click updates the card at once; a newer snapshot from the transcript
  // then takes over, so the card never sticks on an old local result.
  const view = localState && localState.revision > card.revision ? localState : card;
  const accountId = ownAccountId ?? sessionAccountId;
  const self = accountId ? view.participants.find((participant) => participant.participantId === accountId) : undefined;
  const options = view.options ?? [];
  const polling = view.state === 'polling' && options.length > 0;
  const isOpen = view.state !== 'canceled';
  const canRespond = Boolean(self) && isOpen && !polling;
  const leading = polling ? leadingOption(options) : null;
  const canConfirm = Boolean(self?.organizer) && (view.state === 'awaiting_confirmation' || (polling && leading !== null));
  const when = formatWhen(view.startAt, view.endAt);
  const going = view.participants.filter((participant) => participant.rsvp === 'yes').length;
  const nameOf = (participantId: string) => view.participants.find((participant) => participant.participantId === participantId)?.displayName ?? 'Member';

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
    <section className="app-plan-card" data-kordi-copy-surface="message" data-plan-card-state={view.state} aria-label={`Plan: ${view.title}`}>
      <div className="app-plan-card-head">
        <CalendarClock size={14} aria-hidden className="app-plan-card-icon" />
        <div className="app-plan-card-heading">
          <div className={cn('app-plan-card-title', view.state === 'canceled' && 'line-through opacity-60')}>{view.title}</div>
          <div className="app-plan-card-meta">
            {when ? <span>{when}</span> : null}
            {view.location ? <span><MapPin size={11} aria-hidden /> {view.location}</span> : null}
            {view.unresolvedFields.length > 0 && !polling ? <span className="app-plan-card-unresolved">still open: {view.unresolvedFields.join(', ')}</span> : null}
          </div>
        </div>
        <span className={cn('app-plan-card-state', `app-plan-card-state-${view.state}`)}>
          {view.state === 'confirmed' && view.participants.length > 0 ? `${going} going` : STATE_LABEL[view.state]}
        </span>
      </div>

      {polling ? (
        <div className="app-plan-card-options" role="group" aria-label="Options">
          {options.map((option) => {
            const mine = accountId ? option.votes.includes(accountId) : false;
            return (
              <div key={option.id} className={cn('app-plan-card-option', mine && 'app-plan-card-option-mine')}>
                <button
                  type="button"
                  className="app-plan-card-option-vote"
                  disabled={Boolean(busy) || !self}
                  aria-pressed={mine}
                  onClick={() => { void act(`vote:${option.id}`, { action: 'vote', eventId: view.eventId, participantId: accountId ?? '', optionId: option.id }); }}
                >
                  <span className="app-plan-card-option-mark" aria-hidden>{mine ? <Check size={11} /> : null}</span>
                  <span className="app-plan-card-option-label">{option.label}</span>
                  <span className="app-plan-card-option-count">{option.votes.length}</span>
                </button>
                {option.votes.length > 0 ? (
                  <div className="app-plan-card-option-voters" aria-label={option.votes.map(nameOf).join(', ')}>
                    {option.votes.map((voter) => <span key={voter} className="app-plan-card-avatar" title={nameOf(voter)}>{initials(nameOf(voter))}</span>)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="app-plan-card-people" aria-label="Participants">
          {view.participants.map((participant) => (
            <span
              key={participant.participantId}
              className={cn('app-plan-card-person', `app-plan-card-person-${participant.rsvp}`)}
              title={`${participant.displayName}${participant.organizer ? ' (organizer)' : ''}: ${participant.rsvp}`}
            >
              <span className="app-plan-card-avatar">{initials(participant.displayName)}</span>
              <span className="app-plan-card-person-name">{participant.displayName}</span>
            </span>
          ))}
        </div>
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
              onClick={() => { void act('confirm', { action: 'confirm', eventId: view.eventId, revision: view.revision, confirmedBy: accountId ?? '', ...(leading ? { optionId: leading.id } : {}) }); }}
            >
              {leading ? `Confirm ${leading.label}` : 'Confirm for everyone'}
            </button>
          ) : null}
        </div>
      ) : null}
      {notice ? <div className="app-plan-card-notice" role="status">{notice}</div> : null}
    </section>
  );
}
