import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContactRow } from '../src/kordi-app/components/transcript';
import { cloudRequestToContactRequest } from '../src/features/cloud/useCloudContacts';
import { KORDI_SUPPORT_AVATAR_URL } from '../src/features/support/supportIdentity';
import { contact, renderContactsPage, request } from './helpers/contactsPageFixtures';

test('contact request rows do not repeat the review-details action beside accept and reject', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcriptContacts.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('export function ContactRequestRow');
  const end = source.indexOf('export function ContactRow', start + 1);
  assert.ok(start >= 0, 'ContactRequestRow source block should be present');
  const block = source.slice(start, end > start ? end : undefined);

  assert.doesNotMatch(block, /Review details/);
  assert.doesNotMatch(block, /onReview/);
});

test('contacts page hides the complete request activity area when no requests or invites are pending', () => {
  const markup = renderContactsPage([]);

  assert.doesNotMatch(markup, /app-contacts-request-activity/);
  assert.doesNotMatch(markup, />New requests</);
  assert.doesNotMatch(markup, />Sent invites</);
  assert.doesNotMatch(markup, /No pending|None sent/);
  assert.match(markup, />Contacts</);
  assert.match(markup, /aria-label="Search contacts"/);
});

test('contacts page shows incoming requests without an empty sent-invites section', () => {
  const markup = renderContactsPage([
    request({ id: 'request-in', direction: 'incoming' }),
  ]);

  assert.match(markup, /app-contacts-request-activity/);
  assert.match(markup, />New requests</);
  assert.match(markup, />Review 1 pending request\.</);
  assert.match(markup, /app-badge-attention[^>]*>1</);
  assert.match(markup, />Testuser wants to connect</);
  assert.match(markup, />Accept</);
  assert.match(markup, />Reject</);
  assert.doesNotMatch(markup, />Sent invites</);
  assert.doesNotMatch(markup, /No pending|None sent/);
});

test('contacts request activity counts incoming approvals separately from outgoing invites', () => {
  const markup = renderContactsPage([
    request({ id: 'request-in', direction: 'incoming' }),
    request({ id: 'request-out', title: 'Request sent to Maya Chen', detail: 'acct_maya_123', direction: 'outgoing' }),
  ]);

  assert.equal((markup.match(/app-badge-attention/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /app-badge-attention[^>]*>2</);
  assert.match(markup, />Review 1 pending request\.</);
  assert.match(markup, />Sent invites</);
  assert.match(markup, />1 awaiting approval</);
  assert.doesNotMatch(markup, />Request sent to Maya Chen</);
  assert.doesNotMatch(markup, /No pending|None sent/);
});

test('contacts page summarizes outgoing-only pending invites without showing the full list by default', () => {
  const markup = renderContactsPage([
    request({ id: 'request-out', title: 'Request sent to Maya Chen', detail: 'acct_maya_123', direction: 'outgoing' }),
  ]);

  assert.doesNotMatch(markup, />New requests</);
  assert.match(markup, />Sent invites</);
  assert.match(markup, />1 awaiting approval</);
  assert.doesNotMatch(markup, /app-badge-attention/);
  assert.doesNotMatch(markup, /No pending|None sent/);
  assert.doesNotMatch(markup, />Waiting for approval</);
  assert.doesNotMatch(markup, />Request sent to Maya Chen</);
  assert.doesNotMatch(markup, />Accept</);
  assert.doesNotMatch(markup, />Reject</);
  assert.doesNotMatch(markup, />Review details</);
});

test('sent invites section has independent fold and expand controls', () => {
  const source = readFileSync(new URL('../src/kordi-app/contacts/ContactsRequestActivity.tsx', import.meta.url), 'utf8');

  assert.match(source, /isSentInvitesOpen/);
  assert.match(source, /setIsSentInvitesOpen\(\(open\) => !open\)/);
  assert.match(source, /aria-expanded=\{isSentInvitesOpen\}/);
  assert.match(source, /\{isSentInvitesOpen && \(/);
});

test('sent invite rows use real account avatars in a compact row', () => {
  const source = readFileSync(new URL('../src/kordi-app/contacts/ContactsRequestActivity.tsx', import.meta.url), 'utf8');
  const sentInvitesStart = source.indexOf('{sentInviteCount > 0 && (');
  assert.ok(sentInvitesStart >= 0, 'Sent invites source block should be present');
  const sentInvitesBlock = source.slice(sentInvitesStart);

  assert.match(sentInvitesBlock, /<IdentityAvatar/);
  assert.match(sentInvitesBlock, /imageUrl=\{request\.profileImageUrl\}/);
  assert.match(sentInvitesBlock, /name=\{sentInviteDisplayName\(request\)\}/);
  assert.match(sentInvitesBlock, /cornerRadius="50%"/);
  assert.match(sentInvitesBlock, /className="app-contacts-sent-invite-item /);
  assert.doesNotMatch(sentInvitesBlock, /text-white/);
  assert.match(sentInvitesBlock, /Awaiting approval/);
  assert.match(sentInvitesBlock, /<ContactRequestTime value=\{request\.time\} \/>/);
  assert.doesNotMatch(sentInvitesBlock, /\{request\.detail\}/);
  assert.doesNotMatch(sentInvitesBlock, /Waiting for approval/);
  assert.doesNotMatch(sentInvitesBlock, /border-amber|bg-amber|text-amber/);
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
