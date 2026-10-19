import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContactRequestRow, ContactRow } from '../src/kordi-app/components/transcript';
import { cloudRequestToContactRequest } from '../src/features/cloud/useCloudContacts';
import { KORDI_SUPPORT_AVATAR_URL } from '../src/features/support/supportIdentity';
import { contactRequestDisplayName } from '../src/kordi-app/contactPresentation';
import { contact, presenceContacts, renderContactsPage, request } from './helpers/contactsPageFixtures';

test('contact request rows do not repeat the review-details action beside accept and reject', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcriptContacts.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('export function ContactRequestRow');
  assert.ok(start >= 0, 'ContactRequestRow source block should be present');
  const block = source.slice(start);

  assert.doesNotMatch(block, /Review details/);
  assert.doesNotMatch(block, /onReview/);
});

test('contacts page hides the complete request activity area when no requests or invites are pending', () => {
  const markup = renderContactsPage([]);

  assert.doesNotMatch(markup, /app-contacts-request-activity/);
  assert.doesNotMatch(markup, />Requests</);
  assert.doesNotMatch(markup, /No pending|None sent/);
  assert.match(markup, />Contacts</);
  assert.match(markup, /aria-label="Search contacts"/);
});

test('incoming requests are single compact rows: name, handle, and an Accept pill', () => {
  const markup = renderContactsPage([
    request({ id: 'request-in', direction: 'incoming', detail: '@305918274' }),
  ], { onAcceptRequest: () => undefined, onRejectRequest: () => undefined, onSelectRequest: () => undefined });

  assert.match(markup, /app-contacts-request-activity/);
  assert.match(markup, /aria-label="Requests"/);
  assert.match(markup, />Requests</);
  assert.match(markup, /app-contacts-group-count">1</);
  assert.match(markup, />Testuser</);
  assert.doesNotMatch(markup, />Testuser wants to connect</);
  assert.match(markup, />@305918274</);
  assert.match(markup, /app-contacts-accept-pill[^>]*>Accept</);
  assert.doesNotMatch(markup, />Reject</, 'Reject lives in the detail pane');
  assert.doesNotMatch(markup, />New requests<|>Sent invites<|Review \d+ pending/);
});

test('request rows fall back to a state line when no handle is known', () => {
  const markup = renderContactsPage([
    request({ id: 'request-in', direction: 'incoming' }),
    request({ id: 'request-out', title: 'Request sent to Maya Chen', detail: 'acct_maya_123', direction: 'outgoing' }),
  ]);

  assert.match(markup, />Wants to connect</);
  assert.match(markup, />Maya Chen</);
  assert.match(markup, />Awaiting approval</);
  assert.match(markup, />Pending</);
  assert.match(markup, /app-contacts-group-count">2</);
  assert.equal((markup.match(/app-contacts-accept-pill/g) ?? []).length, 1, 'only incoming rows can be accepted');
  assert.doesNotMatch(markup, /acct_maya_123/);
  assert.doesNotMatch(markup, />Request sent to Maya Chen</);
});

test('outgoing-only requests show in the Requests section without accept controls', () => {
  const markup = renderContactsPage([
    request({ id: 'request-out', title: 'Request sent to Maya Chen', avatarName: 'Maya Chen', detail: '@482731906', direction: 'outgoing' }),
  ]);

  assert.match(markup, />Requests</);
  assert.match(markup, />Maya Chen</);
  assert.match(markup, />@482731906</);
  assert.match(markup, />Pending</);
  assert.doesNotMatch(markup, />Accept</);
  assert.doesNotMatch(markup, />Reject</);
});

test('the Requests section collapses with the requests toggle', () => {
  const markup = renderContactsPage([request({ id: 'request-in', direction: 'incoming' })], { isContactRequestsOpen: false });

  assert.match(markup, /aria-expanded="false"[^>]*>.*Requests/);
  assert.doesNotMatch(markup, />Testuser</);
});

test('request display names strip the request phrasing', () => {
  assert.equal(contactRequestDisplayName({ title: 'Noor Haddad wants to connect' }), 'Noor Haddad');
  assert.equal(contactRequestDisplayName({ title: 'Request sent to Elio Marin' }), 'Elio Marin');
  assert.equal(contactRequestDisplayName({ title: 'Ignored title', avatarName: 'Oskar Berg' }), 'Oskar Berg');
  assert.equal(contactRequestDisplayName({ title: 'Carol Ops Agent trust request' }), 'Carol Ops Agent trust request');
});

test('cloud request mapping keeps counterpart name for request avatar fallback', () => {
  const mapped = cloudRequestToContactRequest({
    requestId: 'req-1',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_111',
    status: 'pending',
    direction: 'outgoing',
    message: null,
    createdAt: 'now',
    decidedAt: null,
    counterpart: {
      accountId: 'acct_111',
      kordiId: '482731906',
      displayName: '111',
      avatarUrl: 'data:image/png;base64,avatar-111',
      nodeId: null,
      createdAt: 'now',
    },
  });

  assert.equal(mapped.avatarName, '111');
  assert.equal(mapped.profileImageUrl, 'data:image/png;base64,avatar-111');
  assert.equal(mapped.detail, '@482731906');
  assert.doesNotMatch(`${mapped.title}\n${mapped.detail}`, /acct_/);
});

test('cloud request mapping never falls back to an internal account key', () => {
  const mapped = cloudRequestToContactRequest({
    requestId: 'req-legacy-fallback',
    fromAccountId: 'acct_internal_requester',
    toAccountId: 'acct_me',
    status: 'pending',
    direction: 'incoming',
    message: null,
    createdAt: 'now',
    decidedAt: null,
    counterpart: {
      accountId: 'acct_internal_requester',
      kordiId: null,
      displayName: null,
      avatarUrl: null,
      nodeId: null,
      createdAt: 'now',
    },
  });

  assert.equal(mapped.title, 'Kordi user wants to connect');
  assert.equal(mapped.detail, 'Kordi ID unavailable');
  assert.doesNotMatch(`${mapped.title}\n${mapped.detail}`, /acct_/);
});

test('the locked Kordi Support contact routes reporting through its chat', () => {
  const markup = renderContactsPage([], {
    activeContact: contact({
      id: 'cloud-contact:cloud-system:kordi-support',
      name: 'Kordi Support',
      entityType: 'user',
      classType: 'other-users',
      subtitle: 'Ask questions or suggest improvements',
      detail: 'Ask questions or suggest improvements',
      sourceHostId: 'cloud',
      sourceParticipantId: 'acct_support',
      sourceAgentId: 'cloud_agent_kordi_support',
      systemContact: true,
      locked: true,
      supportTicketEnabled: true,
      profileImageUrl: KORDI_SUPPORT_AVATAR_URL,
    }),
    contactOverlayMode: 'contact',
    onMessageContact: () => undefined,
    onRemoveContact: () => undefined,
  });

  assert.match(markup, />Kordi Support</);
  assert.match(markup, /src="\/kordi-support-avatar\.svg"/);
  assert.match(markup, />Message</);
  assert.doesNotMatch(markup, />Submit a request</);
  assert.doesNotMatch(markup, />Delete contact</);
  assert.doesNotMatch(markup, /aria-label="More actions"/);
});

test('active contact rows use the soft selection tint instead of the raised list-item style', () => {
  const markup = renderToStaticMarkup(createElement(ContactRow, {
    contact: contact({ id: 'cloud:acct_peer', name: 'Maya Chen', subtitle: 'acct_33bb4b1b5c8349ad8f26467854f3f18e' }),
    active: true,
    onSelect: () => undefined,
  }));

  assert.match(markup, /app-contact-row/);
  assert.match(markup, /app-list-item/);
  assert.match(markup, /app-contact-row-selected/);
  assert.match(markup, /aria-current="true"/);
  assert.doesNotMatch(markup, /app-list-item-active/);
  assert.doesNotMatch(markup, /text-slate-100|text-white/);
});

test('contact rows hide the plain user type and keep informative ones', () => {
  const row = (overrides: Partial<Contact>) => renderToStaticMarkup(createElement(ContactRow, {
    contact: contact({ subtitle: '@123456789', ...overrides }),
    active: false,
    onSelect: () => undefined,
  }));

  for (const entityType of ['user', 'Person']) {
    const markup = row({ entityType });
    assert.doesNotMatch(markup, new RegExp(`>${entityType}<`));
    assert.match(markup, />@123456789</);
  }
  assert.match(row({ entityType: 'My agent', classType: 'my-agents' }), />My agent</);
  assert.match(row({ entityType: 'agent', classType: 'other-users-agents' }), />agent</);
});

test('contact rows show presence for people, descriptions for agents, and search still finds Kordi IDs', () => {
  const row = (overrides: Partial<Contact>) => renderToStaticMarkup(createElement(ContactRow, {
    contact: contact({ subtitle: '@482731906', ...overrides }),
    active: false,
    onSelect: () => undefined,
    now: Date.parse('2026-10-18T15:30:00Z'),
  }));

  const online = row({ presenceStatus: 'online' });
  assert.match(online, /app-contact-row-meta[^"]*app-contacts-presence-online[^"]*">online</);
  assert.doesNotMatch(online, /@482731906/, 'the Kordi ID moves to the detail pane');
  assert.match(row({ presenceStatus: 'offline', presenceLastSeenAt: '2026-10-18T15:21:00Z' }), />last seen 9 minutes ago</);
  assert.match(row({ presenceStatus: 'offline' }), />last seen recently</);
  assert.match(row({ presenceStatus: null }), />@482731906</, 'unknown presence keeps the subtitle');

  const support = row({ subtitle: 'Ask questions or suggest improvements', presenceStatus: 'online', systemContact: true });
  assert.match(support, />Ask questions or suggest improvements</);
  assert.doesNotMatch(support, /app-contacts-presence-online/);
  assert.match(row({ classType: 'my-agents', entityType: 'My agent', subtitle: 'On this Mac', presenceStatus: 'offline' }), />On this Mac</);

  const requestRow = renderToStaticMarkup(createElement(ContactRequestRow, {
    request: request({ title: 'Noor Haddad wants to connect', avatarName: 'Noor Haddad', detail: '@305918274', direction: 'incoming' }),
    active: false,
  }));
  assert.match(requestRow, />@305918274</, 'request rows keep their handle line');

  const adapterSource = readFileSync(new URL('../src/features/cloud/CloudContactsAdapter.tsx', import.meta.url), 'utf8');
  assert.match(adapterSource, /\[contact\.name, contact\.subtitle, contact\.detail, contact\.sourceParticipantId/);
  assert.match(adapterSource, /presenceLastSeenAt:/);
});

test('contacts list shows presence lines instead of Kordi IDs', () => {
  const markup = renderContactsPage([], {
    filteredGroupedContacts: [{ id: 'other-users', label: 'Other users', items: presenceContacts() }],
    expandedContactGroups: { 'my-agents': false, 'other-users-agents': false, 'other-users': true },
  });
  assert.match(markup, /">online</);
  assert.match(markup, />last seen 9 minutes ago</);
  // Just after midnight, yesterday 18:58 is still under six hours old and reads relatively.
  assert.match(markup, />last seen (yesterday at 18:58|[1-5] hours ago)</);
  assert.match(markup, />last seen recently</);
  assert.doesNotMatch(markup, /@482731906|@193847562|@650218437|@771045293/);
});

test('contact detail modal mirrors real presence instead of deriving it from status text', () => {
  const statusOnlyMarkup = renderContactsPage([], {
    contactOverlayMode: 'contact',
    activeContact: contact({
      id: 'cloud:acct_peer',
      name: 'Maya Chen',
      subtitle: 'acct_33bb4b1b5c8349ad8f26467854f3f18e',
      status: 'online',
      presenceStatus: null,
    }),
  });

  assert.doesNotMatch(statusOnlyMarkup, /data-presence-status=/);
  assert.doesNotMatch(statusOnlyMarkup, />online<\/span>/);

  const presenceMarkup = renderContactsPage([], {
    contactOverlayMode: 'contact',
    activeContact: contact({
      id: 'cloud:acct_peer',
      name: 'Maya Chen',
      subtitle: 'acct_33bb4b1b5c8349ad8f26467854f3f18e',
      status: 'online',
      presenceStatus: 'online',
    }),
  });

  assert.match(presenceMarkup, /data-presence-status="online"/);
  assert.match(presenceMarkup, /aria-label="Maya Chen is online"/);
  assert.doesNotMatch(presenceMarkup, />online<\/span>/);
});

test('contact detail modal shows other users with a read-only avatar', () => {
  const markup = renderContactsPage([], {
    contactOverlayMode: 'contact',
    activeContact: contact({
      id: 'cloud:acct_peer',
      name: 'Maya Chen',
      subtitle: 'acct_33bb4b1b5c8349ad8f26467854f3f18e',
      sourceHostId: 'cloud',
      sourceParticipantId: 'acct_33bb4b1b5c8349ad8f26467854f3f18e',
    }),
  });

  assert.doesNotMatch(markup, />\s*Contact detail\s*</);
  assert.match(markup, /Maya Chen/);
  assert.doesNotMatch(markup, /app-avatar-upload-button/);
  assert.doesNotMatch(markup, /Upload maya chen avatar/i);
  assert.doesNotMatch(markup, /type="file"/);
});

test('contact detail removes redundant repeated metadata and unused profile action', () => {
  const source = readFileSync(new URL('../src/kordi-app/contacts/ContactDetailPane.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, />\s*Contact detail\s*</);
  assert.doesNotMatch(source, /Owner: \{selfObjectLabel\(activeContact\.owner\)\}/);
  assert.doesNotMatch(source, />Joined collaborationSources</);
  assert.doesNotMatch(source, />Discoverable on</);
  assert.doesNotMatch(source, />\s*View full profile\s*</);
  assert.doesNotMatch(source, /CollaborationChip key=\{bridge\}/);
});

test('contact detail modal suppresses detail text when it repeats the visible account identifier', () => {
  const markup = renderContactsPage([], {
    contactOverlayMode: 'contact',
    activeContact: contact({
      id: 'cloud:acct_peer_123',
      name: 'Taylor',
      entityType: 'Person',
      subtitle: 'acct_peer_123',
      detail: 'acct_peer_123',
      sourceParticipantId: 'acct_peer_123',
      sourceHostId: 'cloud',
    }),
  });

  const visibleText = markup.replace(/<[^>]*>/g, ' ');
  assert.equal((visibleText.match(/acct_peer_123/g) ?? []).length, 1);
});

test('contacts add surface uses concise public Kordi ID controls without implementation wording', () => {
  const source = readFileSync(new URL('../src/kordi-app/contacts/ContactsAddForm.tsx', import.meta.url), 'utf8');

  assert.match(source, /placeholder="Kordi ID, e\.g\. @482731906"/);
  assert.match(source, /Send request/);
  assert.doesNotMatch(source, /Search by exact account ID/);
  assert.doesNotMatch(source, /Send an approval request/);
  assert.match(source, /Request pending/);
  assert.doesNotMatch(source, /Account ID, e\.g\. acct_/);
  assert.doesNotMatch(source, /Bridge node ID/);
  assert.doesNotMatch(source, /Add by node ID/);
  assert.doesNotMatch(source, /Bridge users/);
  assert.doesNotMatch(source, /Visible users/);
});

test('cloud contacts adapter passes outgoing requests through to Contacts', () => {
  const source = readFileSync(new URL('../src/features/cloud/CloudContactsAdapter.tsx', import.meta.url), 'utf8');

  assert.match(source, /contactRequests=\{cloud\.requests\}/);
  assert.doesNotMatch(source, /contactRequests=\{inboxRequests\}/);
  assert.match(source, /isRequestPending/);
});
