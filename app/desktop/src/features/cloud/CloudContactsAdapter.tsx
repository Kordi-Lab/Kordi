// CloudContactsAdapter — when the desktop runs in cloud edition, wrap
// the existing ContactsPage with a thin layer that overrides its
// callbacks + data with the cloud auth client's responses. The page's
// markup, grouping, and "New requests" inbox are all reused — only
// the data source and the mutations change.
//
// Used by MainContentSwitch on the contacts route, and exposes the
// raw cloud-aware contact list for the ChatCreateDialog so the "+"
// menu's "Add contacts" surface can route through cloud too.

import { useMemo } from 'react';
import type { ComponentProps } from 'react';

import { useCloudContacts } from './useCloudContacts';
import type { CloudAccount } from './authClient';
import { ContactsPage } from '@/kordi-app/pages';
import type { Contact, ContactClass, ContactRequest } from '@/kordi-app/types';

type CloudContactsAdapterProps = {
  account: CloudAccount;
  contactsPageProps: ComponentProps<typeof ContactsPage>;
};

/**
 * Wraps the normal ContactsPage and replaces:
 *   - filteredGroupedContacts (adds the cloud contacts under "Other users")
 *   - contactRequests          (replaces with cloud pending requests)
 *   - onAcceptRequest / onRejectRequest / onAddContactByNodeId
 *     (routes them through the cloud auth client)
 *   - addableContacts          (clears bridge-only addables; cloud's add
 *                               flow is a free-text account ID lookup)
 */
export function CloudContactsAdapter({ account, contactsPageProps }: CloudContactsAdapterProps) {
  const cloud = useCloudContacts(account);

  // Inbox only shows incoming requests — outgoing ones are the
  // sender's own actions and surfacing them in the inbox with
  // Accept/Reject would be wrong. They'll re-appear as accepted
  // contacts (or vanish on rejection) on the next refresh.
  const inboxRequests = useMemo(
    () => cloud.requests.filter((req) => req.direction === 'incoming'),
    [cloud.requests],
  );

  const filteredGroupedContacts = useMemo(() => {
    const search = contactsPageProps.contactSearch?.trim().toLowerCase() ?? '';
    const cloudMatches = (
      search
        ? cloud.contacts.filter((contact) =>
            (contact.name + ' ' + contact.subtitle + ' ' + (contact.bridgePeerNodeId ?? '')).toLowerCase().includes(search),
          )
        : cloud.contacts
    );
    // Merge: existing local groups + a synthetic "other-users" group for cloud.
    // We splice cloud rows into the existing other-users group when one is
    // already present, otherwise add it.
    const groups = contactsPageProps.filteredGroupedContacts.map((group) =>
      group.id === 'other-users'
        ? { ...group, items: dedupeContacts([...group.items, ...cloudMatches]) }
        : group,
    );
    const hasOtherUsers = groups.some((group) => group.id === 'other-users');
    if (!hasOtherUsers && cloudMatches.length > 0) {
      groups.push({
        id: 'other-users' as ContactClass,
        label: 'Other users',
        items: cloudMatches,
      });
    }
    return groups;
  }, [contactsPageProps.contactSearch, contactsPageProps.filteredGroupedContacts, cloud.contacts]);

  const onAcceptRequest = async (request: ContactRequest) => {
    const requestId = request.bridgeRequestId;
    if (!requestId) return;
    await cloud.acceptRequest(requestId);
  };

  const onRejectRequest = async (request: ContactRequest) => {
    const requestId = request.bridgeRequestId;
    if (!requestId) return;
    await cloud.rejectRequest(requestId);
  };

  const onAddContactByNodeId = async (rawId: string) => {
    const trimmed = rawId.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('acct_')) {
      throw new Error('Cloud account IDs start with "acct_".');
    }
    await cloud.sendRequest(trimmed);
  };

  // When the active selection is a cloud row, the parent pipeline has
  // no idea what it points at (it only knows about local contacts and
  // requests). Override activeContact / activeContactRequest with
  // resolved-from-cloud values so the detail card matches the row the
  // user clicked.
  const activeContact = useMemo(() => {
    const id = contactsPageProps.activeContactId;
    if (id?.startsWith('cloud:')) {
      const found = cloud.contacts.find((contact) => contact.id === id);
      if (found) return found;
    }
    return contactsPageProps.activeContact;
  }, [contactsPageProps.activeContactId, contactsPageProps.activeContact, cloud.contacts]);

  const activeContactRequest = useMemo(() => {
    const id = contactsPageProps.activeContactRequestId;
    if (id?.startsWith('cloud:')) {
      const found = cloud.requests.find((req) => req.id === id);
      if (found) return found;
    }
    return contactsPageProps.activeContactRequest;
  }, [contactsPageProps.activeContactRequestId, contactsPageProps.activeContactRequest, cloud.requests]);

  return (
    <ContactsPage
      {...contactsPageProps}
      filteredGroupedContacts={filteredGroupedContacts}
      addableContacts={[]}
      contactRequests={inboxRequests}
      activeContact={activeContact}
      activeContactRequest={activeContactRequest}
      onAcceptRequest={onAcceptRequest}
      onRejectRequest={onRejectRequest}
      onAddContactByNodeId={onAddContactByNodeId}
    />
  );
}

function dedupeContacts(items: Contact[]): Contact[] {
  const seen = new Set<string>();
  const out: Contact[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
