import { UserPlus } from 'lucide-react';

import { SidebarSearchField } from '@/components/SidebarListChrome';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import type { AddContactFormModel } from './useContactsPageState';

/** Search by Kordi ID above the contacts search, styled like it; Enter searches. */
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
  const lookupStatus = lookupResult?.isSelf
    ? "That's you"
    : lookupResult?.isContact
      ? 'Already added'
      : lookupRequestPending
        ? 'Pending'
        : '';

  return (
    <div role="search" aria-label="Add contact" aria-busy={lookupState === 'searching' || undefined} className="app-contacts-add-form">
      <SidebarSearchField
        value={contactNodeId}
        onChange={changeContactNodeId}
        placeholder="Search by Kordi ID"
        label="Kordi ID"
        autoFocus
        onEnter={() => {
          if (contactNodeId.trim() && lookupState !== 'searching') void performContactLookup();
        }}
      />
      {lookupResult ? (
        <div className="app-contacts-lookup-result mb-2 flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate whitespace-nowrap text-[13px] font-medium leading-4">{lookupResult.displayName || 'Kordi user'}</div>
            <div className="app-contacts-muted mt-px truncate whitespace-nowrap text-[11px] leading-4">{formatKordiHandle(lookupResult.kordiId) || 'Kordi ID unavailable'}</div>
          </div>
          {lookupStatus ? (
            <span className="app-contacts-muted shrink-0 whitespace-nowrap text-[12px]">{lookupStatus}</span>
          ) : (
            <button
              type="button"
              className="app-contacts-icon-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] disabled:pointer-events-none disabled:opacity-50"
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
        <div className="app-contacts-muted mb-2 px-1 text-[11px] leading-4" aria-live="polite">{statusMessage}</div>
      ) : (
        <div className="sr-only" aria-live="polite" />
      )}
    </div>
  );
}
