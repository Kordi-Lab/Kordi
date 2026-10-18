import { UserPlus } from 'lucide-react';

import { formatKordiHandle } from '@/features/cloud/kordiId';
import type { AddContactFormModel } from './useContactsPageState';

export function ContactsAddForm({ form }: { form: AddContactFormModel }) {
  const {
    contactNodeId,
    changeContactNodeId,
    addContactState,
    lookupState,
    lookupResult,
    lookupRequestPending,
    requestedContactNodeIds,
    statusMessage,
    performContactLookup,
    submitAddContact,
  } = form;
  const lookupName = lookupResult ? (lookupResult.displayName || formatKordiHandle(lookupResult.kordiId) || 'Kordi user') : '';

  return (
    <form
      aria-label="Add contact"
      className="app-contacts-add-form mx-3 mb-2 px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (lookupResult) {
          void submitAddContact(lookupResult.accountId);
        } else {
          void performContactLookup();
        }
      }}
    >
      <div className="flex gap-2">
        <input
          value={contactNodeId}
          onChange={(event) => changeContactNodeId(event.target.value)}
          placeholder="Kordi ID, e.g. @482731906"
          aria-label="Kordi ID"
          autoFocus
          className="app-contacts-field h-8 min-w-0 flex-1 rounded-[8px] px-2.5 text-[12.5px] outline-none"
        />
        <button
          type="submit"
          className="app-contacts-action-chip inline-flex h-8 shrink-0 items-center rounded-[8px] px-3 text-[12px] font-medium disabled:pointer-events-none disabled:opacity-50"
          disabled={!contactNodeId.trim() || lookupState === 'searching' || addContactState === 'saving' || lookupRequestPending}
        >
          {lookupResult
            ? (lookupRequestPending ? 'Request pending' : addContactState === 'saving' ? 'Sending…' : 'Send request')
            : (lookupState === 'searching' ? 'Searching…' : 'Search')}
        </button>
      </div>
      {lookupResult ? (
        <div className="app-contacts-lookup-result mt-2 flex items-center justify-between gap-2 rounded-[8px] px-2.5 py-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium leading-4">{lookupResult.displayName || 'Kordi user'}</div>
            <div className="app-contacts-muted mt-px truncate text-[11px] leading-4">{formatKordiHandle(lookupResult.kordiId) || 'Kordi ID unavailable'}</div>
          </div>
          {lookupResult.isSelf ? (
            <span className="app-contacts-muted text-[11px]">That's you</span>
          ) : lookupResult.isContact ? (
            <span className="app-contacts-muted text-[11px]">Already added</span>
          ) : lookupRequestPending ? (
            <span className="app-contacts-muted text-[11px] font-medium">Request pending</span>
          ) : (
            <button
              type="button"
              className="app-contacts-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] disabled:pointer-events-none disabled:opacity-50"
              aria-label={`Send request to ${lookupName}`}
              title="Send request"
              disabled={addContactState === 'saving' || requestedContactNodeIds.includes(lookupResult.accountId)}
              onClick={() => { void submitAddContact(lookupResult.accountId); }}
            >
              <UserPlus className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : null}
      {statusMessage ? (
        <div className="app-contacts-muted mt-2 text-[11px] leading-4" aria-live="polite">{statusMessage}</div>
      ) : (
        <div className="sr-only" aria-live="polite" />
      )}
    </form>
  );
}
