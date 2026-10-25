import { HelpEmptyExample } from '@/features/onboarding/HelpEmptyExample';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';

import { SidebarListAction, SidebarListHeader, SidebarSearchField } from '@/components/SidebarListChrome';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ContactRow } from '../components';
import type { ContactClass } from '../types';
import { ContactsAddForm } from './ContactsAddForm';
import { ContactsGroupsSection } from './ContactsGroupsSection';
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
  | 'groupSpaces'
  | 'onOpenGroup'
> & {
  requests: PartitionedContactRequests;
  requestActions: ContactRequestActions;
  fullWidth: boolean;
  /** Rendered in the sidebar session panel, which provides the width and backdrop. */
  inSidebar: boolean;
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
  groupSpaces,
  onOpenGroup,
  requests,
  requestActions,
  fullWidth,
  inSidebar,
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
      className={cn(
        'app-contacts-list-column flex h-full min-h-0 flex-col p-2.5',
        inSidebar ? 'w-full' : fullWidth ? 'is-standalone w-full' : 'is-standalone w-[248px] shrink-0',
      )}
    >
      <SidebarListHeader title="Contacts">
        <SidebarListAction
          icon={UserPlus}
          label="Add contact"
          expanded={isAddContactOpen}
          onClick={() => setIsAddContactOpen((open) => !open)}
          disabled={!onAddContactByNodeId}
        />
      </SidebarListHeader>

      {isAddContactOpen && <ContactsAddForm form={addContactForm} />}

      <SidebarSearchField
        value={contactSearch}
        onChange={onContactSearchChange}
        placeholder="Search contacts"
      />

      <ScrollArea className="app-contacts-list-scroll min-h-0 flex-1">
        <div className="app-contacts-list-body grid pb-3">
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
          {groupSpaces && onOpenGroup ? (
            <ContactsGroupsSection spaces={groupSpaces} search={contactSearch} onOpenGroup={onOpenGroup} />
          ) : null}
          {!contactSearch.trim() && filteredGroupedContacts.every((group) => group.items.length === 0) ? <HelpEmptyExample kind="contacts" /> : null}
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
