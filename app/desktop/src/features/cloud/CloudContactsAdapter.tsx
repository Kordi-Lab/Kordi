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

import { CLOUD_HOST_SENTINEL, cloudContactToContact, isPendingIncomingCloudContactRequest, useCloudContacts } from './useCloudContacts';
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
    () => cloud.requests.filter(isPendingIncomingCloudContactRequest),
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
    // Cloud contacts should be one row per human account. Do not merge the
    // Bridge-derived person/agent rows from the local view model, otherwise the
    // Contacts page shows the same person twice and also exposes local/remote
    // agent runtime rows ("My agent", "other users' agents") as contacts.
    const groups = contactsPageProps.filteredGroupedContacts
      .filter((group) => group.id !== 'my-agents' && group.id !== 'other-users-agents')
      .map((group) =>
        group.id === 'other-users'
          ? { ...group, items: dedupeContactsByCloudAccount(cloudMatches) }
          : group,
      );
    const hasOtherUsers = groups.some((group) => group.id === 'other-users');
    if (!hasOtherUsers && cloudMatches.length > 0) {
      groups.push({
        id: 'other-users' as ContactClass,
        label: 'Other users',
        items: dedupeContactsByCloudAccount(cloudMatches),
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
    if (isCloudSelfAgentContact(contactsPageProps.activeContact)) {
      return cloudAccountToSelfContact(account);
    }
    return contactsPageProps.activeContact;
  }, [contactsPageProps.activeContactId, contactsPageProps.activeContact, account, cloud.contacts]);

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
      onMessageContact={contactsPageProps.onMessageContact}
    />
  );
}

function isCloudSelfAgentContact(contact: Contact | undefined): boolean {
  return contact?.classType === 'my-agents' && contact.bridgeHostId === CLOUD_HOST_SENTINEL;
}

function cloudAccountToSelfContact(account: CloudAccount): Contact {
  const contact = cloudContactToContact({
    accountId: account.accountId,
    displayName: account.displayName || account.primaryEmail || account.accountId,
    avatarUrl: account.avatarUrl,
    nodeId: account.nodeId,
    createdAt: '',
  });
  return {
    ...contact,
    name: account.displayName || account.primaryEmail || account.accountId,
    subtitle: account.primaryEmail || account.accountId,
    detail: `Signed in to Kordi Cloud as ${account.accountId}.`,
    owner: 'Me',
  };
}

function dedupeContactsByCloudAccount(items: Contact[]): Contact[] {
  const seen = new Set<string>();
  const out: Contact[] = [];
  for (const item of items) {
    const key = item.bridgePeerNodeId || item.bridgeHumanId || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
