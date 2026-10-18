import { useState } from 'react';
import { LoaderCircle, MessageSquare, Trash2, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ContactRequestTime } from '../components';
import { contactTypeLabel } from '../components/contactTypeLabel';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { contactCanBeRemoved, contactDetailBodyText, contactPresenceStatus } from '../contactPresentation';
import type { Contact, ContactRequest } from '../types';
import type { ContactsPageProps } from './contactsPageTypes';
import type { ContactRequestActions } from './useContactsPageState';

type ContactDetailPaneProps = Pick<ContactsPageProps, 'activeContact' | 'activeContactRequest' | 'onCloseOverlay' | 'onMessageContact' | 'onRemoveContact'> & {
  mode: 'contact' | 'request';
  requestActions: ContactRequestActions;
};

function ContactDetailBody({
  contact,
  onCloseOverlay,
  onMessageContact,
  onRemoveContact,
}: {
  contact: Contact;
  onCloseOverlay: () => void;
  onMessageContact?: (contact: Contact) => void;
  onRemoveContact?: (contact: Contact) => Promise<void> | void;
}) {
  const [removeState, setRemoveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [removeError, setRemoveError] = useState('');
  const presenceStatus = contactPresenceStatus(contact);
  const detailBody = contactDetailBodyText(contact);
  const meta = [contactTypeLabel(contact), contact.subtitle].filter(Boolean).join(' · ');
  const canRemove = Boolean(onRemoveContact && contactCanBeRemoved(contact));
  const canMessage = Boolean(onMessageContact && contact.sourceHostId && contact.sourceParticipantId);

  const submitRemoveContact = async () => {
    if (!canRemove || removeState === 'saving') return;
    setRemoveState('saving');
    setRemoveError('');
    try {
      onCloseOverlay();
      await onRemoveContact?.(contact);
    } catch (error) {
      setRemoveState('error');
      setRemoveError(error instanceof Error ? error.message : 'Unable to delete contact');
    }
  };

  return (
    <>
      <IdentityAvatar
        kind={contact.classType === 'my-agents' || contact.classType === 'other-users-agents' ? 'agent' : 'human'}
        seed={contact.avatarSeed ?? contact.sourceParticipantId ?? contact.id}
        name={contact.name}
        imageUrl={contact.profileImageUrl}
        presenceStatus={presenceStatus}
        presenceLabel={presenceStatus ? `${contact.name} is ${presenceStatus}` : undefined}
        cornerRadius="50%"
        className="app-contacts-avatar app-contacts-detail-avatar h-24 w-24"
      />
      <h2 className="mt-4 max-w-full truncate text-[22px] font-bold leading-7 tracking-[-0.01em]">{contact.name}</h2>
      {meta ? <div className="app-contacts-muted mt-1 max-w-full truncate text-[13px] leading-5">{meta}</div> : null}
      {detailBody ? <p className="app-contacts-muted mt-3 max-w-[360px] text-[13px] leading-5">{detailBody}</p> : null}
      <div className="mt-6 grid w-full max-w-[240px] gap-1.5">
        <button
          type="button"
          className="app-contacts-primary-action inline-flex h-9 items-center justify-center gap-2 rounded-[9px] px-4 text-[13.5px] font-semibold disabled:pointer-events-none disabled:opacity-50"
          onClick={() => onMessageContact?.(contact)}
          disabled={!canMessage}
        >
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          Message
        </button>
        {canRemove ? (
          <button
            type="button"
            className="app-contacts-danger-action inline-flex h-9 items-center justify-center gap-2 rounded-[9px] px-4 text-[13px] font-medium disabled:pointer-events-none disabled:opacity-50"
            onClick={() => { void submitRemoveContact(); }}
            disabled={removeState === 'saving'}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {removeState === 'saving' ? 'Deleting…' : 'Delete contact'}
          </button>
        ) : null}
      </div>
      {canRemove ? (
        <div
          className={cn('mt-3 max-w-[300px] text-[11.5px] leading-4', removeState === 'error' ? 'app-error-text app-contacts-error' : 'app-contacts-muted')}
          aria-live="polite"
        >
          {removeState === 'error'
            ? removeError || 'Unable to delete contact.'
            : 'Deleting removes both contact directions. They will need approval before messages can reach you again.'}
        </div>
      ) : null}
    </>
  );
}

function ContactRequestDetailBody({ request, requestActions }: { request: ContactRequest; requestActions: ContactRequestActions }) {
  const state = requestActions.stateFor(request);
  return (
    <>
      <IdentityAvatar
        kind={/agent/i.test(request.title) ? 'agent' : 'human'}
        seed={request.avatarSeed ?? request.id}
        name={request.avatarName ?? request.title}
        imageUrl={request.profileImageUrl}
        cornerRadius="50%"
        className="app-contacts-avatar app-contacts-detail-avatar h-24 w-24"
      />
      <h2 className="mt-4 max-w-full text-[22px] font-bold leading-7 tracking-[-0.01em]">{request.title}</h2>
      <div className="app-badge-neutral mt-2 px-2.5 py-1 text-[10px] font-medium"><ContactRequestTime value={request.time} /></div>
      {request.detail ? <p className="app-contacts-muted mt-3 max-w-[360px] text-[13px] leading-5">{request.detail}</p> : null}
      <div className="mt-6 grid w-full max-w-[240px] gap-1.5">
        <button
          type="button"
          className="app-contacts-primary-action inline-flex h-9 items-center justify-center gap-2 rounded-[9px] px-4 text-[13.5px] font-semibold disabled:pointer-events-none disabled:opacity-50"
          onClick={() => { void requestActions.submit(request, 'accept'); }}
          disabled={requestActions.busy || !requestActions.canAccept}
        >
          {state === 'accepting' ? <><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Accepting…</> : 'Accept'}
        </button>
        <button
          type="button"
          className="app-contacts-danger-action inline-flex h-9 items-center justify-center gap-2 rounded-[9px] px-4 text-[13px] font-medium disabled:pointer-events-none disabled:opacity-50"
          onClick={() => { void requestActions.submit(request, 'reject'); }}
          disabled={requestActions.busy || !requestActions.canReject}
        >
          {state === 'rejecting' ? <><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Rejecting…</> : 'Reject'}
        </button>
      </div>
      {state === 'accepting' ? (
        <div className="app-contacts-muted mt-3 text-[11.5px] leading-4" aria-live="polite">Accepting and sending greeting…</div>
      ) : state === 'rejecting' ? (
        <div className="app-contacts-muted mt-3 text-[11.5px] leading-4" aria-live="polite">Rejecting request…</div>
      ) : requestActions.error ? (
        <div className="app-error-text app-contacts-error mt-3 max-w-[300px] text-[12px] leading-5" aria-live="polite">{requestActions.error}</div>
      ) : null}
    </>
  );
}

/** Centered contact or request detail, shared by the split-view pane and the narrow-window dialog. */
export function ContactDetailContent({
  mode,
  activeContact,
  activeContactRequest,
  onCloseOverlay,
  onMessageContact,
  onRemoveContact,
  requestActions,
}: ContactDetailPaneProps) {
  if (mode === 'request' && !activeContactRequest) return null;
  return (
    <div className="app-contacts-detail-content flex flex-col items-center px-6 py-8 text-center">
      <button
        type="button"
        onClick={onCloseOverlay}
        aria-label="Close"
        title="Close"
        disabled={mode === 'request' && requestActions.busy}
        className="app-contacts-icon-button absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-[8px] disabled:pointer-events-none disabled:opacity-50"
      >
        <X className="h-4 w-4" />
      </button>
      {mode === 'contact' ? (
        <ContactDetailBody
          key={activeContact.id}
          contact={activeContact}
          onCloseOverlay={onCloseOverlay}
          onMessageContact={onMessageContact}
          onRemoveContact={onRemoveContact}
        />
      ) : activeContactRequest ? (
        <ContactRequestDetailBody request={activeContactRequest} requestActions={requestActions} />
      ) : null}
    </div>
  );
}

function contactDetailLabel(mode: 'contact' | 'request', activeContact: Contact) {
  return mode === 'contact' ? `${activeContact.name} contact details` : 'Contact request review';
}

export function ContactDetailPane(props: ContactDetailPaneProps) {
  return (
    <section
      aria-label={contactDetailLabel(props.mode, props.activeContact)}
      className="app-contacts-detail-pane relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto"
    >
      <div className="w-full max-w-[460px]">
        <ContactDetailContent {...props} />
      </div>
    </section>
  );
}

export function ContactDetailDialog(props: ContactDetailPaneProps) {
  return (
    <div className="app-transient-overlay app-overlay absolute inset-0 z-10 flex items-center justify-center px-4 py-8 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={contactDetailLabel(props.mode, props.activeContact)}
        className="app-transient-surface app-modal-panel app-contact-detail-dialog relative w-full max-w-[420px] rounded-[18px] border"
      >
        <ContactDetailContent {...props} />
      </div>
    </div>
  );
}

export function ContactDetailEmpty() {
  return (
    <section aria-label="Contact details" className="app-contacts-detail-pane flex min-h-0 min-w-0 flex-1 items-center justify-center">
      <div className="app-contacts-muted text-[13px]">No contact selected</div>
    </section>
  );
}
