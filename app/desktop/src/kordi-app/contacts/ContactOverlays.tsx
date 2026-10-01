import { useState } from 'react';
import { LoaderCircle, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { contactCanBeRemoved, contactDetailBodyText, contactPresenceStatus } from '../contactPresentation';
import type { Contact, ContactRequest } from '../types';

export type ContactRequestActionKind = 'accept' | 'reject';
export type ContactRequestActionState = 'accepting' | 'rejecting' | null;

type ContactOverlaysProps = {
  mode: 'contact' | 'request';
  activeContact: Contact;
  activeContactRequest?: ContactRequest;
  onCloseOverlay: () => void;
  onMessageContact?: (contact: Contact) => void;
  onRemoveContact?: (contact: Contact) => Promise<void> | void;
  canAcceptRequest: boolean;
  canRejectRequest: boolean;
  requestActionBusy: boolean;
  requestActionError: string;
  requestActionState: (request: ContactRequest) => ContactRequestActionState;
  onSubmitRequestAction: (request: ContactRequest, kind: ContactRequestActionKind) => void;
};

/** Render with a key of the mode and contact so per-contact state resets. */
export function ContactOverlays({
  mode,
  activeContact,
  activeContactRequest,
  onCloseOverlay,
  onMessageContact,
  onRemoveContact,
  canAcceptRequest,
  canRejectRequest,
  requestActionBusy,
  requestActionError,
  requestActionState,
  onSubmitRequestAction,
}: ContactOverlaysProps) {
  const [removeContactState, setRemoveContactState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [removeContactError, setRemoveContactError] = useState('');

  const activeContactDetailBody = contactDetailBodyText(activeContact);
  const activeContactPresenceStatus = contactPresenceStatus(activeContact);
  const canRemoveActiveContact = Boolean(
    onRemoveContact
      && contactCanBeRemoved(activeContact),
  );

  const submitRemoveContact = async () => {
    if (!canRemoveActiveContact || removeContactState === 'saving') return;
    setRemoveContactState('saving');
    setRemoveContactError('');
    try {
      const contactToRemove = activeContact;
      onCloseOverlay();
      await onRemoveContact?.(contactToRemove);
    } catch (error) {
      setRemoveContactState('error');
      setRemoveContactError(error instanceof Error ? error.message : 'Unable to delete contact');
    }
  };

  return (
    <div className="app-transient-overlay app-overlay absolute inset-0 z-10 flex items-center justify-center px-4 py-8 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'contact' ? `${activeContact.name} contact details` : 'Contact request review'}
        className="app-transient-surface app-modal-panel app-contact-detail-dialog w-full max-w-[420px] rounded-[18px] border p-4"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {mode === 'request' ? (
              <div className="app-transient-muted text-[11px] uppercase tracking-[0.24em]">
                Request review
              </div>
            ) : null}
            <div className={cn('text-lg font-semibold', mode === 'request' ? 'mt-1' : '')}>
              {mode === 'contact' ? activeContact.name : activeContactRequest?.title}
            </div>
          </div>
          <button
            type="button"
            onClick={onCloseOverlay}
            aria-label="Close"
            className="app-button-quiet app-transient-flat-action inline-flex h-8 w-8 items-center justify-center rounded-[10px] p-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {mode === 'contact' ? (
          <div>
            <div className="mb-4 flex items-center gap-3">
              <IdentityAvatar
                kind={activeContact.classType === 'my-agents' || activeContact.classType === 'other-users-agents' ? 'agent' : 'human'}
                seed={activeContact.avatarSeed ?? activeContact.sourceParticipantId ?? activeContact.id}
                name={activeContact.name}
                imageUrl={activeContact.profileImageUrl}
                presenceStatus={activeContactPresenceStatus}
                presenceLabel={activeContactPresenceStatus ? `${activeContact.name} is ${activeContactPresenceStatus}` : undefined}
                className="h-12 w-12 border border-[color:var(--app-transient-border)]"
              />
              <div>
                <div className="app-transient-muted text-sm">
                  {activeContact.entityType} • {activeContact.subtitle}
                </div>
              </div>
            </div>
            {activeContactDetailBody ? <div className="app-transient-muted mb-5 text-sm">{activeContactDetailBody}</div> : null}
            <div className="grid gap-1">
              <Button variant="secondary" className="app-transient-flat-action rounded-[10px]" onClick={() => onMessageContact?.(activeContact)} disabled={!onMessageContact || !activeContact.sourceHostId || !activeContact.sourceParticipantId}>
                Message
              </Button>
              {canRemoveActiveContact ? (
                <Button
                  variant="secondary"
                  className="app-transient-flat-action app-transient-flat-action-danger rounded-[10px] shadow-none"
                  onClick={() => { void submitRemoveContact(); }}
                  disabled={removeContactState === 'saving'}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {removeContactState === 'saving' ? 'Deleting…' : 'Delete contact'}
                </Button>
              ) : null}
            </div>
            {canRemoveActiveContact ? (
              <div className={cn('app-error-text mt-3 text-[11px] leading-4', removeContactState === 'error' ? 'text-rose-200' : 'app-transient-muted')} aria-live="polite">
                {removeContactState === 'error'
                  ? removeContactError || 'Unable to delete contact.'
                  : 'Deleting removes both contact directions. They will need approval before messages can reach you again.'}
              </div>
            ) : null}
          </div>
        ) : activeContactRequest ? (
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="app-badge-neutral px-2.5 py-1 text-[10px] font-medium">{activeContactRequest.time}</div>
            </div>
            <div className="app-transient-muted mb-5 text-sm">{activeContactRequest.detail}</div>
            <div className="grid gap-1">
              <Button variant="secondary" className="app-transient-flat-action rounded-[10px]" onClick={() => { onSubmitRequestAction(activeContactRequest, 'accept'); }} disabled={!canAcceptRequest || requestActionBusy}>
                {requestActionState(activeContactRequest) === 'accepting' ? (
                  <>
                    <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                    Accepting…
                  </>
                ) : 'Accept'}
              </Button>
              <Button variant="secondary" className="app-transient-flat-action app-transient-flat-action-danger rounded-[10px]" onClick={() => { onSubmitRequestAction(activeContactRequest, 'reject'); }} disabled={!canRejectRequest || requestActionBusy}>
                {requestActionState(activeContactRequest) === 'rejecting' ? (
                  <>
                    <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                    Rejecting…
                  </>
                ) : 'Reject'}
              </Button>
              <Button variant="secondary" className="app-transient-flat-action rounded-[10px]" onClick={onCloseOverlay} disabled={requestActionBusy}>
                Close review
              </Button>
            </div>
            {requestActionState(activeContactRequest) === 'accepting' ? (
              <div className="app-transient-muted mt-3 text-[11px] leading-4" aria-live="polite">Accepting and sending greeting…</div>
            ) : requestActionState(activeContactRequest) === 'rejecting' ? (
              <div className="app-transient-muted mt-3 text-[11px] leading-4" aria-live="polite">Rejecting request…</div>
            ) : requestActionError ? (
              <div className="app-error-text mt-3 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-[12px] leading-5 text-rose-100" aria-live="polite">
                {requestActionError}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
