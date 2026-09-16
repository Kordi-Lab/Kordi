import { CalendarClock, Check, MapPin, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { defaultCloudAuthClient, type PlanCardActionRequest } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import type { MessagePlanCard } from '@/kordi-app/types/message';

const STATE_LABEL: Record<MessagePlanCard['state'], string> = {
  polling: 'Choosing',
  awaiting_confirmation: 'Leaning yes',
  confirmed: 'Confirmed',
  canceled: 'Canceled',
};

const STATE_CLASS: Record<MessagePlanCard['state'], string> = {
  polling: 'app-plan-card-pill-polling',
  awaiting_confirmation: 'app-plan-card-pill-await',
  confirmed: 'app-plan-card-pill-confirmed',
  canceled: 'app-plan-card-pill-canceled',
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

/**
 * A shared plan card posted by Pip. State comes from the message snapshot; the
 * buttons act for the signed-in member through the plan-card route, and the
 * next Pip message carries the updated snapshot.
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
  const view = localState ?? card;
  const accountId = ownAccountId ?? sessionAccountId;
  const self = accountId ? view.participants.find((participant) => participant.participantId === accountId) : undefined;
  const isOpen = view.state !== 'canceled';
  const canRespond = Boolean(self) && isOpen;
  const canConfirm = Boolean(self?.organizer) && view.state === 'awaiting_confirmation';
  const when = formatWhen(view.startAt, view.endAt);
  const going = view.participants.filter((participant) => participant.rsvp === 'yes').length;

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
      setNotice(error instanceof Error ? error.message : 'Could not update the plan card.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="app-plan-card" data-kordi-copy-surface="message" data-plan-card-state={view.state}>
      <div className="app-plan-card-head">
        <span className={cn('app-plan-card-pill', STATE_CLASS[view.state])}>{STATE_LABEL[view.state]}</span>
        {view.state === 'confirmed' && view.participants.length > 0 ? (
          <span className="app-plan-card-count">{going} going</span>
        ) : null}
      </div>
      <div className={cn('app-plan-card-title', view.state === 'canceled' && 'line-through opacity-60')}>{view.title}</div>
      <div className="app-plan-card-meta">
        {when ? <span><CalendarClock size={13} aria-hidden /> {when}</span> : null}
        {view.location ? <span><MapPin size={13} aria-hidden /> {view.location}</span> : null}
        {view.unresolvedFields.length > 0 ? (
          <span className="app-plan-card-unresolved">unresolved: {view.unresolvedFields.join(', ')}</span>
        ) : null}
      </div>
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
      {canRespond || canConfirm ? (
        <div className="app-plan-card-actions">
          {canRespond ? (
            <>
              <button
                type="button"
                className={cn('app-plan-card-button', self?.rsvp === 'yes' && 'app-plan-card-button-active')}
                disabled={Boolean(busy)}
                onClick={() => { void act('yes', { action: 'rsvp', eventId: view.eventId, revision: view.revision, participantId: accountId ?? '', rsvp: 'yes' }); }}
              >
                <Check size={13} aria-hidden /> I'm in
              </button>
              <button
                type="button"
                className={cn('app-plan-card-button', self?.rsvp === 'no' && 'app-plan-card-button-active')}
                disabled={Boolean(busy)}
                onClick={() => { void act('no', { action: 'rsvp', eventId: view.eventId, revision: view.revision, participantId: accountId ?? '', rsvp: 'no' }); }}
              >
                <X size={13} aria-hidden /> Can't make it
              </button>
            </>
          ) : null}
          {canConfirm ? (
            <button
              type="button"
              className="app-plan-card-button app-plan-card-button-primary"
              disabled={Boolean(busy)}
              onClick={() => { void act('confirm', { action: 'confirm', eventId: view.eventId, revision: view.revision, confirmedBy: accountId ?? '' }); }}
            >
              Confirm for everyone
            </button>
          ) : null}
        </div>
      ) : null}
      {notice ? <div className="app-plan-card-notice" role="status">{notice}</div> : null}
    </div>
  );
}
