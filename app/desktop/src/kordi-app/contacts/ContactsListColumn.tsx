import { useState } from 'react';
import { Search, UserPlus } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ContactRow } from '../components';
import type { ContactClass } from '../types';
import { ContactsAddForm } from './ContactsAddForm';
import { ContactsListSection } from './ContactsListSection';
import { ContactsRequestActivity } from './ContactsRequestActivity';
import { usePresenceNow } from './usePresenceNow';
import type { ContactGroup, ContactOverlayMode, ContactsPageProps } from './contactsPageTypes';
import { useAddContactForm, type ContactRequestActions, type PartitionedContactRequests } from './useContactsPageState';

type ContactsListColumnProps = Pick<ContactsPageProps,
  | 'filteredGroupedContacts'
  | 'isContactRequestsOpen'
  | 'onToggleRequests'
  | 'onSelectRequest'
  | 'activeContactRequestId'
  | 'onAddContactByNodeId'
  | 'onLookupContact'
  | 'contactSearch'
  | 'onContactSearchChange'
  | 'expandedContactGroups'
  | 'onToggleGroup'
  | 'activeContactId'
  | 'onSelectContact'
  | 'contactOverlayMode'
  | 'leadingListItems'
> & {
  requests: PartitionedContactRequests;
  requestActions: ContactRequestActions;
  fullWidth: boolean;
};

/** Sentence-case heading for a contact group; people read better as "Contacts" than "Other users". */
function contactGroupHeading(group: Pick<ContactGroup, 'id' | 'label'>) {
  return group.id === 'other-users' ? 'Contacts' : group.label;
}

function ContactGroupList({
  groups,
  expandedContactGroups,
  onToggleGroup,
  isSelected,
  onSelectContact,
}: {
  groups: ContactGroup[];
  expandedContactGroups: Record<ContactClass, boolean>;
  onToggleGroup: (groupId: ContactClass) => void;
  isSelected: (contactId: string) => boolean;
  onSelectContact: (groupId: ContactClass, contactId: string) => void;
}) {
  const now = usePresenceNow();
  return (
    <>
      {groups.map((group) => (
        <ContactsListSection
          key={group.id}
          label={contactGroupHeading(group)}
          count={group.items.length}
          expanded={Boolean(expandedContactGroups[group.id])}
          onToggle={() => onToggleGroup(group.id)}
        >
          {group.items.length > 0 ? (
            group.items.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                active={isSelected(contact.id)}
                now={now}
                onSelect={() => onSelectContact(group.id, contact.id)}
              />
            ))
          ) : (
            <div className="app-contacts-muted px-2 py-2 text-[12.5px]">No contacts match this search.</div>
          )}
        </ContactsListSection>
      ))}
    </>
  );
}

function selectionMatcher(mode: ContactOverlayMode, activeContactId: string) {
  return (contactId: string) => mode === 'contact' && activeContactId === contactId;
}

export function ContactsListColumn({
  filteredGroupedContacts,
  isContactRequestsOpen,
  onToggleRequests,
  onSelectRequest,
  activeContactRequestId,
  onAddContactByNodeId,
  onLookupContact,
  contactSearch,
  onContactSearchChange,
  expandedContactGroups,
  onToggleGroup,
  activeContactId,
  onSelectContact,
  contactOverlayMode,
  leadingListItems,
  requests,
  requestActions,
  fullWidth,
}: ContactsListColumnProps) {
  const [isAddContactOpen, setIsAddContactOpen] = useState(false);
  const addContactForm = useAddContactForm({
    onLookupContact,
    onAddContactByNodeId,
    outgoingPendingRequestAccountIds: requests.outgoingAccountIds,
  });

  return (
    <section
      aria-label="Contacts list"
      className={cn('app-contacts-list-column flex h-full min-h-0 flex-col', fullWidth ? 'w-full' : 'w-[340px] shrink-0')}
    >
      <div className="app-contacts-list-header flex shrink-0 items-center gap-2 pl-4 pr-2.5">
        <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-[-0.01em]">Contacts</h2>
        <button
          type="button"
          className="app-contacts-icon-button inline-flex h-8 w-8 items-center justify-center rounded-[8px] disabled:pointer-events-none disabled:opacity-50"
          aria-label="Add contact"
          title="Add contact"
          aria-expanded={isAddContactOpen}
          onClick={() => setIsAddContactOpen((open) => !open)}
          disabled={!onAddContactByNodeId}
        >
          <UserPlus className="h-[18px] w-[18px]" />
        </button>
      </div>

      {isAddContactOpen && <ContactsAddForm form={addContactForm} />}

      <label className="app-contacts-search mx-3 mb-2 flex shrink-0 items-center gap-2 px-2.5">
        <Search className="app-contacts-muted h-4 w-4 shrink-0" aria-hidden="true" />
        <input
          value={contactSearch}
          onChange={(event) => onContactSearchChange(event.target.value)}
          placeholder="Search"
          aria-label="Search contacts"
          className="h-full w-full min-w-0 bg-transparent text-[13px] leading-5 outline-none"
        />
      </label>

      <ScrollArea className="app-contacts-list-scroll min-h-0 flex-1">
        <div className="app-contacts-list-body grid px-2.5 pb-3">
          {leadingListItems ? (
            <>
              <div className="app-contacts-pinned grid gap-px">{leadingListItems}</div>
              <div className="app-contacts-list-divider" role="separator" />
            </>
          ) : null}
          <ContactsRequestActivity
            incomingContactRequests={requests.incoming}
            outgoingContactRequests={requests.outgoing}
            activeContactRequestId={contactOverlayMode === 'request' ? activeContactRequestId : ''}
            isContactRequestsOpen={isContactRequestsOpen}
            onToggleRequests={onToggleRequests}
            onSelectRequest={onSelectRequest}
            requestActions={requestActions}
          />
          <ContactGroupList
            groups={filteredGroupedContacts}
            expandedContactGroups={expandedContactGroups}
            onToggleGroup={onToggleGroup}
            isSelected={selectionMatcher(contactOverlayMode, activeContactId)}
            onSelectContact={onSelectContact}
          />
        </div>
      </ScrollArea>
    </section>
  );
}
