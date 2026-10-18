import { cn } from '@/lib/utils';
import { LoaderCircle } from 'lucide-react';
import type { Contact, ContactRequest } from '../types';
import { contactTypeLabel } from './contactTypeLabel';
import { IdentityAvatar, type IdentityAvatarKind } from './IdentityAvatar';
import { ContactRequestTime } from './transcriptMessageTime';

function contactAvatarKind(contact: Contact): IdentityAvatarKind {
  return contact.classType === 'my-agents' || contact.classType === 'other-users-agents' ? 'agent' : 'human';
}

function requestAvatarKind(request: ContactRequest): IdentityAvatarKind {
  return /agent/i.test(request.title) ? 'agent' : 'human';
}

export function ContactRow({ contact, active, onSelect }: { contact: Contact; active: boolean; onSelect: () => void }) {
  const typeLabel = contactTypeLabel(contact);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'app-contact-row app-list-item flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-none',
        active && 'app-contact-row-selected',
      )}
    >
      <IdentityAvatar
        kind={contactAvatarKind(contact)}
        seed={contact.avatarSeed ?? contact.sourceParticipantId ?? contact.id}
        name={contact.name}
        imageUrl={contact.profileImageUrl}
        cornerRadius="50%"
        className="app-contacts-avatar h-10 w-10"
        presenceStatus={contact.presenceStatus}
        presenceLabel={contact.presenceStatus ? `${contact.name} is ${contact.presenceStatus === 'online' ? 'online' : 'offline'}` : null}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14px] font-semibold leading-5">{contact.name}</span>
          {typeLabel ? <span className="app-contact-row-meta shrink-0 text-[11px] leading-4">{typeLabel}</span> : null}
        </div>
        <div className="app-contact-row-meta truncate text-[12px] leading-4">{contact.subtitle}</div>
      </div>
    </button>
  );
}

export function ContactRequestRow({
  request,
  active,
  onAccept,
  onReject,
  actionState = null,
}: {
  request: ContactRequest;
  active: boolean;
  onAccept?: () => void;
  onReject?: () => void;
  actionState?: 'accepting' | 'rejecting' | null;
}) {
  const isBusy = Boolean(actionState);
  const statusText = actionState === 'accepting'
    ? 'Accepting and sending greeting…'
    : actionState === 'rejecting'
      ? 'Rejecting request…'
      : '';

  return (
    <div
      className={cn(
        'app-contact-request-item rounded-[10px] px-2.5 py-2.5 transition-none',
        active && 'app-contact-request-item-active',
      )}
    >
      <div className="flex items-start gap-3">
        <IdentityAvatar
          kind={requestAvatarKind(request)}
          seed={request.avatarSeed ?? request.id}
          name={request.title}
          imageUrl={request.profileImageUrl}
          cornerRadius="50%"
          className="app-contacts-avatar h-10 w-10"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="truncate text-[14px] font-semibold leading-5">{request.title}</div>
            <ContactRequestTime value={request.time} />
          </div>
          <div className="app-contact-row-meta mt-0.5 text-[12px] leading-4">{request.detail}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="app-contacts-primary-action inline-flex h-7 items-center justify-center gap-1.5 rounded-[8px] px-3 text-[12px] font-medium disabled:pointer-events-none disabled:opacity-50" onClick={onAccept} disabled={!onAccept || isBusy}>
              {actionState === 'accepting' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Accepting…
                </>
              ) : 'Accept'}
            </button>
            <button type="button" className="app-contacts-danger-action inline-flex h-7 items-center justify-center gap-1.5 rounded-[8px] px-3 text-[12px] font-medium disabled:pointer-events-none disabled:opacity-50" onClick={onReject} disabled={!onReject || isBusy}>
              {actionState === 'rejecting' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Rejecting…
                </>
              ) : 'Reject'}
            </button>
          </div>
          {statusText ? (
            <div className="app-contact-row-meta mt-2 text-[11px] leading-4" aria-live="polite">
              {statusText}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
