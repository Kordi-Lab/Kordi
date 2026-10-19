import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContactsPage } from '../../src/kordi-app/pages';
import type { Contact, ContactRequest } from '../../src/kordi-app/types';

export function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    name: 'Testuser',
    initials: 'TU',
    classType: 'other-users',
    entityType: 'Person',
    subtitle: 'Testuser',
    collaborationSources: ['Bridge'],
    status: 'Available',
    discoverableOn: [],
    detail: 'Bridge contact',
    owner: 'Testuser',
    ...overrides,
  };
}

/** People with varied presence: online, seen 9 minutes ago, seen yesterday at 18:58, and no timestamp. */
export function presenceContacts(now: number = Date.now()): Contact[] {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(18, 58, 0, 0);
  const person = (id: string, name: string, handle: string, overrides: Partial<Contact>) => contact({
    id: `cloud:${id}`, name, subtitle: handle, detail: handle, entityType: 'user', sourceHostId: 'cloud', sourceParticipantId: id, ...overrides,
  });
  return [
    person('acct_maya', 'Maya Chen', '@482731906', { presenceStatus: 'online' }),
    person('acct_hana', 'Hana Sato', '@193847562', { presenceStatus: 'offline', presenceLastSeenAt: new Date(now - 9 * 60_000).toISOString() }),
    person('acct_ines', 'Ines Wolf', '@650218437', { presenceStatus: 'offline', presenceLastSeenAt: yesterday.toISOString() }),
    person('acct_rafa', 'Rafa Mendes', '@771045293', { presenceStatus: 'offline' }),
  ];
}

export function request(overrides: Partial<ContactRequest> = {}): ContactRequest {
  return {
    id: 'request-1',
    initials: 'TU',
    title: 'Testuser wants to connect',
    detail: "I am Testuser. I'd like to add you as a Kordi contact.",
    time: 'now',
    ...overrides,
  };
}

type ContactsPageFixtureProps = Parameters<typeof ContactsPage>[0];

export function contactsPageProps(overrides: Partial<ContactsPageFixtureProps> = {}): ContactsPageFixtureProps {
  return {
    filteredGroupedContacts: [],
    addableContacts: [],
    isContactRequestsOpen: true,
    onToggleRequests: () => undefined,
    activeContactRequestId: '',
    contactSearch: '',
    onContactSearchChange: () => undefined,
    expandedContactGroups: {
      'my-agents': false,
      'other-users-agents': false,
      'other-users': false,
    },
    onToggleGroup: () => undefined,
    activeContactId: '',
    onSelectContact: () => undefined,
    contactOverlayMode: null,
    activeContact: contact(),
    onCloseOverlay: () => undefined,
    getStatusBadgeClass: () => '',
    contactRequests: [],
    ...overrides,
  };
}

export function renderContactsPage(contactRequests: ContactRequest[], overrides: Partial<ContactsPageFixtureProps> = {}) {
  return renderToStaticMarkup(createElement(ContactsPage, contactsPageProps({ contactRequests, ...overrides })));
}
