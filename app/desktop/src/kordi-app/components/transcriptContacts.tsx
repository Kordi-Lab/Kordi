import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import type { Contact, ContactRequest } from '../types';
import { IdentityAvatar, type IdentityAvatarKind } from './IdentityAvatar';
import { ContactRequestTime } from './transcriptMessageTime';

function contactAvatarKind(contact: Contact): IdentityAvatarKind {
  return contact.classType === 'my-agents' || contact.classType === 'other-users-agents' ? 'agent' : 'human';
}

function requestAvatarKind(request: ContactRequest): IdentityAvatarKind {
  return /agent/i.test(request.title) ? 'agent' : 'human';
}

export function ContactRow({ contact, active, onSelect }: { contact: Contact; active: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className="app-contact-row app-list-item flex w-full items-center gap-3 rounded-[15px] px-3 py-2 text-left text-white transition-none"
    >
      <IdentityAvatar
        kind={contactAvatarKind(contact)}
        seed={contact.avatarSeed ?? contact.sourceParticipantId ?? contact.id}
        name={contact.name}
        imageUrl={contact.profileImageUrl}
        className="h-10 w-10 border border-white/10"
        presenceStatus={contact.presenceStatus}
        presenceLabel={contact.presenceStatus ? `${contact.name} is ${contact.presenceStatus === 'online' ? 'online' : 'offline'}` : null}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium leading-5">{contact.name}</span>
          <span className="text-[10.5px] leading-4 text-slate-300">{contact.entityType}</span>
        </div>
        <div className="truncate text-[11.5px] leading-4 text-slate-300">{contact.subtitle}</div>
      </div>
      <ChevronRight className="h-4 w-4 text-slate-500" />
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
        'app-contact-request-item px-3 py-3 text-white transition-none',
        active && 'app-contact-request-item-active',
      )}
    >
      <div className="flex items-start gap-3">
        <IdentityAvatar
          kind={requestAvatarKind(request)}
          seed={request.avatarSeed ?? request.id}
          name={request.title}
          imageUrl={request.profileImageUrl}
          className="h-10 w-10 border border-white/10"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="truncate text-sm font-medium">{request.title}</div>
            <ContactRequestTime value={request.time} />
          </div>
          <div className={`mt-1 text-xs ${active ? 'text-slate-100' : 'text-slate-300'}`}>{request.detail}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button className="h-8 rounded-xl px-3 text-[11px]" onClick={onAccept} disabled={!onAccept || isBusy}>
              {actionState === 'accepting' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Accepting…
                </>
              ) : 'Accept'}
            </Button>
            <Button variant="secondary" className="h-8 rounded-xl px-3 text-[11px]" onClick={onReject} disabled={!onReject || isBusy}>
              {actionState === 'rejecting' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Rejecting…
                </>
              ) : 'Reject'}
            </Button>
          </div>
          {statusText ? (
            <div className="mt-2 text-[11px] leading-4 text-slate-400" aria-live="polite">
              {statusText}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
