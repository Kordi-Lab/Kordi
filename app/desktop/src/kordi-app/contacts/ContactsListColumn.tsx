import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Search, UserPlus } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ContactRow } from '../components';
import type { ContactClass } from '../types';
import { ContactsAddForm } from './ContactsAddForm';
import { ContactsRequestActivity } from './ContactsRequestActivity';
import type { ContactGroup, ContactOverlayMode, ContactsPageProps } from './contactsPageTypes';
import { useAddContactForm, type ContactRequestActions, type PartitionedContactRequests } from './useContactsPageState';

type ContactsListColumnProps = Pick<ContactsPageProps,
  | 'filteredGroupedContacts'
  | 'isContactRequestsOpen'
  | 'onToggleRequests'
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

function ContactGroupSection({
  group,
  showLabel,
  expanded,
  onToggle,
  children,
}: {
  group: ContactGroup;
  showLabel: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (!showLabel) return <div>{children}</div>;
  return (
    <section aria-label={group.label}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="app-contacts-group-row flex w-full items-center gap-1.5 text-left"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <span className="app-contacts-group-count">{group.items.length}</span>
      </button>
      {expanded ? children : null}
    </section>
  );
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
  const showLabels = groups.length > 1;
  return (
    <>
      {groups.map((group) => (
        <ContactGroupSection
          key={group.id}
          group={group}
          showLabel={showLabels}
          expanded={!showLabels || Boolean(expandedContactGroups[group.id])}
          onToggle={() => onToggleGroup(group.id)}
        >
          <div className="grid gap-0.5">
            {group.items.length > 0 ? (
              group.items.map((contact) => (
                <ContactRow
                  key={contact.id}
                  contact={contact}
                  active={isSelected(contact.id)}
                  onSelect={() => onSelectContact(group.id, contact.id)}
                />
              ))
            ) : (
              <div className="app-contacts-muted px-2.5 py-2 text-[12.5px]">No contacts match this search.</div>
            )}
          </div>
        </ContactGroupSection>
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
        <div className="grid gap-0.5 px-2.5 pb-3">
          {leadingListItems}
          <ContactsRequestActivity
            incomingContactRequests={requests.incoming}
            outgoingContactRequests={requests.outgoing}
            activeContactRequestId={contactOverlayMode === 'request' ? activeContactRequestId : ''}
            isContactRequestsOpen={isContactRequestsOpen}
            onToggleRequests={onToggleRequests}
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
