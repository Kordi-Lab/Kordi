import { cn } from '@/lib/utils';
import { LoaderCircle } from 'lucide-react';
import { contactRequestDisplayName, contactRequestSummary, contactSecondaryLine, isOutgoingContactRequest } from '../contactPresentation';
import type { Contact, ContactRequest } from '../types';
import { contactTypeLabel } from './contactTypeLabel';
import { IdentityAvatar, type IdentityAvatarKind } from './IdentityAvatar';

function contactAvatarKind(contact: Contact): IdentityAvatarKind {
  return contact.classType === 'my-agents' || contact.classType === 'other-users-agents' ? 'agent' : 'human';
}

function requestAvatarKind(request: ContactRequest): IdentityAvatarKind {
  return /agent/i.test(request.title) ? 'agent' : 'human';
}

export function ContactRow({
  contact,
  active,
  onSelect,
  now,
}: {
  contact: Contact;
  active: boolean;
  onSelect: () => void;
  /** Clock for the "last seen" line; the list passes a ticking value. */
  now?: number;
}) {
  const typeLabel = contactTypeLabel(contact);
  const secondaryLine = contactSecondaryLine(contact, now);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'app-contact-row app-list-item flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1 text-left transition-none',
        active && 'app-contact-row-selected',
      )}
    >
      <IdentityAvatar
        kind={contactAvatarKind(contact)}
        seed={contact.avatarSeed ?? contact.sourceParticipantId ?? contact.id}
        name={contact.name}
        imageUrl={contact.profileImageUrl}
        cornerRadius="50%"
        className="app-contacts-avatar h-9 w-9"
        presenceStatus={contact.presenceStatus}
        presenceLabel={contact.presenceStatus ? `${contact.name} is ${contact.presenceStatus === 'online' ? 'online' : 'offline'}` : null}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[12px] font-semibold leading-4">{contact.name}</span>
          {typeLabel ? <span className="app-contact-row-meta shrink-0 text-[11px] leading-4">{typeLabel}</span> : null}
        </div>
        <div className={cn('app-contact-row-meta mt-0.5 truncate text-[10.5px] leading-4', secondaryLine.online && 'app-contacts-presence-online')}>
          {secondaryLine.text}
        </div>
      </div>
    </button>
  );
}

/**
 * One compact two-line row per pending request: avatar, name, handle or state, and a short trailing
 * control. Incoming rows carry an Accept pill; Reject and the full note live in the detail pane.
 */
export function ContactRequestRow({
  request,
  active,
  onSelect,
  onAccept,
  actionState = null,
}: {
  request: ContactRequest;
  active: boolean;
  onSelect?: () => void;
  onAccept?: () => void;
  actionState?: 'accepting' | 'rejecting' | null;
}) {
  const name = contactRequestDisplayName(request);
  const outgoing = isOutgoingContactRequest(request);
  const summary = actionState === 'accepting'
    ? 'Accepting and sending greeting…'
    : actionState === 'rejecting'
      ? 'Rejecting request…'
      : contactRequestSummary(request);

  return (
    <div
      className={cn(
        'app-contact-row app-contact-request-row relative flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1 transition-none',
        active && 'app-contact-row-selected',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={!onSelect}
        aria-current={active ? 'true' : undefined}
        className="app-contact-request-select flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <IdentityAvatar
          kind={requestAvatarKind(request)}
          seed={request.avatarSeed ?? request.targetNodeId ?? request.id}
          name={name}
          imageUrl={request.profileImageUrl}
          cornerRadius="50%"
          className="app-contacts-avatar h-9 w-9"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold leading-4">{name}</span>
          <span className="app-contact-row-meta block mt-0.5 truncate text-[10.5px] leading-4" aria-live={actionState ? 'polite' : undefined}>
            {summary}
          </span>
        </span>
      </button>
      {outgoing ? (
        <span className="app-contact-row-meta relative mt-0.5 shrink-0 self-start text-[12px] leading-5">Pending</span>
      ) : (
        <button
          type="button"
          className="app-contacts-accept-pill relative inline-flex h-6 shrink-0 items-center gap-1 self-start rounded-full px-2.5 text-[11.5px] font-semibold disabled:pointer-events-none disabled:opacity-50"
          onClick={onAccept}
          disabled={!onAccept || Boolean(actionState)}
        >
          {actionState === 'accepting' ? (
            <>
              <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
              Accepting…
            </>
          ) : 'Accept'}
        </button>
      )}
    </div>
  );
}
