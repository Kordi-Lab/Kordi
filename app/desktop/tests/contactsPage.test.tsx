import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContactsPage } from '../src/kordi-app/pages';
import type { Contact, ContactRequest } from '../src/kordi-app/types';

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    name: 'Testuser',
    initials: 'TU',
    classType: 'other-users',
    entityType: 'Person',
    subtitle: 'Testuser',
    bridges: ['Bridge'],
    status: 'Available',
    discoverableOn: [],
    detail: 'Bridge contact',
    owner: 'Testuser',
    ...overrides,
  };
}

function request(overrides: Partial<ContactRequest> = {}): ContactRequest {
  return {
    id: 'request-1',
    initials: 'TU',
    title: 'Testuser wants to connect',
    detail: "I am Testuser. I'd like to add you as a Kordi contact.",
    time: 'now',
    ...overrides,
  };
}

function renderContactsPage(contactRequests: ContactRequest[]) {
  return renderToStaticMarkup(createElement(ContactsPage, {
    filteredGroupedContacts: [],
    addableContacts: [],
    isContactRequestsOpen: true,
    onToggleRequests: () => undefined,
    contactRequests,
    activeContactRequestId: '',
    onReviewRequest: () => undefined,
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
  }));
}

test('contacts request header does not show an attention zero badge when no requests are pending', () => {
  const markup = renderContactsPage([]);

  assert.match(markup, />No pending</);
  assert.match(markup, />No pending contact approvals\.</);
  assert.doesNotMatch(markup, /app-badge-attention[^>]*>0</);
});

test('contacts request header uses attention count only for pending requests', () => {
  const markup = renderContactsPage([request(), request({ id: 'request-2' })]);

  assert.match(markup, /app-badge-attention[^>]*>2</);
  assert.match(markup, />Review 2 pending requests\.</);
});

test('contacts add surface uses account search copy without bridge implementation wording', () => {
  const source = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');

  assert.match(source, /Search by exact account ID/);
  assert.match(source, /Send an approval request/);
  assert.doesNotMatch(source, /Bridge node ID/);
  assert.doesNotMatch(source, /Add by node ID/);
  assert.doesNotMatch(source, /Bridge users/);
  assert.doesNotMatch(source, /Visible users/);
});
