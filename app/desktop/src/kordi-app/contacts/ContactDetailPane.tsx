import { useState } from 'react';
import { Check, LoaderCircle, MessageCircle, Trash2, X } from 'lucide-react';

import { formatKordiHandle } from '@/features/cloud/kordiId';
import { formatDesktopContactRequestTimeLabel } from '@/lib/time';
import { cn } from '@/lib/utils';
import { IdentityAvatar } from '../components/IdentityAvatar';
import {
  contactCanBeRemoved,
  contactDetailBodyText,
  contactKordiHandle,
  contactPresenceStatus,
  contactRequestDisplayName,
  contactSecondaryLine,
  isAgentContact,
  isOutgoingContactRequest,
} from '../contactPresentation';
import type { Contact, ContactRequest } from '../types';
import { CopyButton, DetailHeader, DetailTile, DetailTiles, InfoCard, MoreTile, type InfoCardRow } from './ContactDetailParts';
import type { ContactsPageProps } from './contactsPageTypes';
import type { ContactRequestActions } from './useContactsPageState';
import { usePresenceNow } from './usePresenceNow';

type ContactDetailPaneProps = Pick<ContactsPageProps, 'activeContact' | 'activeContactRequest' | 'onCloseOverlay' | 'onMessageContact' | 'onRemoveContact'> & {
  mode: 'contact' | 'request';
  requestActions: ContactRequestActions;
};

const DETAIL_AVATAR_CLASS = 'app-contacts-avatar app-contacts-detail-avatar h-24 w-24 shrink-0';

function kordiIdRow(handle: string): InfoCardRow {
  return {
    key: 'kordi-id',
    value: handle,
    caption: 'Kordi ID',
    accent: true,
    trailing: <CopyButton value={handle} label="Copy Kordi ID" />,
  };
}

function DeleteConfirm({
  removeState,
  removeError,
  onCancel,
  onDelete,
}: {
  removeState: 'idle' | 'saving' | 'error';
  removeError: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="app-contacts-confirm mt-2 rounded-[12px] px-3.5 py-3" role="group" aria-label="Delete contact">
      <div
        className={cn('text-[12.5px] leading-[18px]', removeState === 'error' ? 'app-error-text app-contacts-error' : 'app-contacts-muted')}
        aria-live="polite"
      >
        {removeState === 'error'
          ? removeError || 'Unable to delete contact.'
          : 'Deleting removes both contact directions. They will need approval before messages can reach you again.'}
      </div>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button
          type="button"
          className="app-contacts-quiet-action inline-flex h-7 items-center rounded-[7px] px-3 text-[12.5px] font-medium"
          onClick={onCancel}
          disabled={removeState === 'saving'}
        >
          Cancel
        </button>
        <button
          type="button"
          className="app-contacts-danger-fill inline-flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-semibold disabled:pointer-events-none disabled:opacity-50"
          onClick={onDelete}
          disabled={removeState === 'saving'}
        >
          {removeState === 'saving' ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Deleting…</> : 'Delete'}
        </button>
      </div>
    </div>
  );
}

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
  const now = usePresenceNow();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [removeState, setRemoveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [removeError, setRemoveError] = useState('');
  const presenceStatus = contactPresenceStatus(contact);
  const detailBody = contactDetailBodyText(contact);
  const handle = contactKordiHandle(contact);
  const isAgent = isAgentContact(contact);
  const secondaryLine = contactSecondaryLine(contact, now);
  const headerLine = secondaryLine.text && secondaryLine.text !== handle && secondaryLine.text !== contact.name ? secondaryLine.text : '';
  const canRemove = Boolean(onRemoveContact && contactCanBeRemoved(contact));
  const canMessage = Boolean(onMessageContact && contact.sourceHostId && contact.sourceParticipantId);
  const rows: InfoCardRow[] = [];
  if (handle) rows.push(kordiIdRow(handle));
  if (detailBody && detailBody !== headerLine) rows.push({ key: 'about', value: detailBody, caption: 'About' });
  if (isAgent) rows.push({ key: 'type', value: 'Agent', caption: 'Type' });

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
      <DetailHeader
        avatar={(
          <IdentityAvatar
            kind={isAgent ? 'agent' : 'human'}
            seed={contact.avatarSeed ?? contact.sourceParticipantId ?? contact.id}
            name={contact.name}
            imageUrl={contact.profileImageUrl}
            presenceStatus={presenceStatus}
            presenceLabel={presenceStatus ? `${contact.name} is ${presenceStatus}` : undefined}
            cornerRadius="50%"
            className={DETAIL_AVATAR_CLASS}
          />
        )}
        name={contact.name}
        line={headerLine}
        lineAccent={secondaryLine.online}
      />
      <DetailTiles>
        <DetailTile
          icon={<MessageCircle className="h-5 w-5" aria-hidden="true" />}
          label="Message"
          onClick={() => onMessageContact?.(contact)}
          disabled={!canMessage}
        />
        {canRemove ? <MoreTile onDelete={() => setIsConfirmOpen(true)} /> : null}
      </DetailTiles>
      <InfoCard rows={rows} />
      {canRemove ? (
        <>
          <div className="app-contacts-card mt-3 rounded-[12px]">
            <button
              type="button"
              className="app-contacts-card-action flex h-11 w-full items-center gap-3 rounded-[12px] px-4 text-left text-[14px]"
              aria-expanded={isConfirmOpen || removeState === 'error'}
              onClick={() => setIsConfirmOpen(true)}
            >
              <Trash2 className="h-[18px] w-[18px]" aria-hidden="true" />
              Delete contact
            </button>
          </div>
          {isConfirmOpen || removeState === 'error' ? (
            <DeleteConfirm
              removeState={removeState}
              removeError={removeError}
              onCancel={() => {
                setIsConfirmOpen(false);
                setRemoveState('idle');
              }}
              onDelete={() => { void submitRemoveContact(); }}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function RequestActionStatus({ state, error }: { state: ReturnType<ContactRequestActions['stateFor']>; error: string }) {
  if (state === 'accepting') {
    return <div className="app-contacts-muted mt-3 text-center text-[12px] leading-4" aria-live="polite">Accepting and sending greeting…</div>;
  }
  if (state === 'rejecting') {
    return <div className="app-contacts-muted mt-3 text-center text-[12px] leading-4" aria-live="polite">Rejecting request…</div>;
  }
  if (error) {
    return <div className="app-error-text app-contacts-error mt-3 text-center text-[12px] leading-5" aria-live="polite">{error}</div>;
  }
  return null;
}

function ContactRequestDetailBody({ request, requestActions }: { request: ContactRequest; requestActions: ContactRequestActions }) {
  const state = requestActions.stateFor(request);
  const name = contactRequestDisplayName(request);
  const outgoing = isOutgoingContactRequest(request);
  const isAgent = /agent/i.test(request.title);
  const handle = formatKordiHandle(request.detail);
  const note = request.detail.trim() && !handle ? request.detail.trim() : '';
  const timestampMs = Date.parse(request.time);
  const rows: InfoCardRow[] = [];
  if (handle) rows.push(kordiIdRow(handle));
  rows.push({
    key: 'requested',
    value: (
      <time className="app-contacts-detail-time" dateTime={Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : undefined}>
        {formatDesktopContactRequestTimeLabel(request.time)}
      </time>
    ),
    caption: 'Requested',
  });
  if (note) rows.push({ key: 'note', value: note, caption: 'Note' });

  return (
    <>
      <DetailHeader
        avatar={(
          <IdentityAvatar
            kind={isAgent ? 'agent' : 'human'}
            seed={request.avatarSeed ?? request.targetNodeId ?? request.id}
            name={name}
            imageUrl={request.profileImageUrl}
            cornerRadius="50%"
            className={DETAIL_AVATAR_CLASS}
          />
        )}
        name={name}
        line={outgoing ? 'Awaiting approval' : 'Wants to connect'}
      />
      {outgoing ? null : (
        <>
          <DetailTiles>
            <DetailTile
              tone="primary"
              icon={state === 'accepting'
                ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
                : <Check className="h-5 w-5" aria-hidden="true" />}
              label={state === 'accepting' ? 'Accepting…' : 'Accept'}
              onClick={() => { void requestActions.submit(request, 'accept'); }}
              disabled={requestActions.busy || !requestActions.canAccept}
            />
            <DetailTile
              tone="danger"
              icon={state === 'rejecting'
                ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
                : <X className="h-5 w-5" aria-hidden="true" />}
              label={state === 'rejecting' ? 'Rejecting…' : 'Reject'}
              onClick={() => { void requestActions.submit(request, 'reject'); }}
              disabled={requestActions.busy || !requestActions.canReject}
            />
          </DetailTiles>
          <RequestActionStatus state={state} error={requestActions.error} />
        </>
      )}
      <InfoCard rows={rows} />
    </>
  );
}

/** Contact or request detail, shared by the split-view pane and the narrow-window dialog. */
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
    <div className="app-contacts-detail-content relative mx-auto w-full max-w-[420px] px-6 pb-10 pt-10">
      <button
        type="button"
        onClick={onCloseOverlay}
        aria-label="Close"
        title="Close"
        disabled={mode === 'request' && requestActions.busy}
        className="app-contacts-icon-button app-contacts-detail-close absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-[8px] disabled:pointer-events-none disabled:opacity-50"
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
      className="app-contacts-detail-pane relative min-h-0 min-w-0 flex-1 overflow-y-auto"
    >
      <ContactDetailContent {...props} />
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
        className="app-transient-surface app-modal-panel app-contact-detail-dialog relative w-full max-w-[440px] rounded-[18px] border"
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
