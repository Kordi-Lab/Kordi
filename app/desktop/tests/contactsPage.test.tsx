import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContactRow } from '../src/kordi-app/components/transcript';
import { ContactsPage } from '../src/kordi-app/pages';
import { cloudRequestToContactRequest } from '../src/features/cloud/useCloudContacts';
import { KORDI_SUPPORT_AVATAR_URL } from '../src/features/support/supportIdentity';
import type { Contact, ContactRequest } from '../src/kordi-app/types';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

function contact(overrides: Partial<Contact> = {}): Contact {
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

function renderContactsPage(contactRequests: ContactRequest[], overrides: Partial<Parameters<typeof ContactsPage>[0]> = {}) {
  return renderToStaticMarkup(createElement(ContactsPage, {
    filteredGroupedContacts: [],
    addableContacts: [],
    isContactRequestsOpen: true,
    onToggleRequests: () => undefined,
    contactRequests,
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
    ...overrides,
  }));
}

test('contact request rows do not repeat the review-details action beside accept and reject', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
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
  const source = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');

  assert.match(source, /isSentInvitesOpen/);
  assert.match(source, /setIsSentInvitesOpen\(\(open\) => !open\)/);
  assert.match(source, /aria-expanded=\{isSentInvitesOpen\}/);
  assert.match(source, /\{isSentInvitesOpen && \(/);
});

test('sent invite rows use real account avatars in a compact row', () => {
  const source = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');
  const sentInvitesStart = source.indexOf('{sentInviteCount > 0 && (');
  const sentInvitesEnd = source.indexOf('<div className="app-contacts-section-heading', sentInvitesStart);
  assert.ok(sentInvitesStart >= 0, 'Sent invites source block should be present');
  const sentInvitesBlock = source.slice(sentInvitesStart, sentInvitesEnd > sentInvitesStart ? sentInvitesEnd : undefined);

  assert.match(source, /<IdentityAvatar/);
  assert.match(source, /imageUrl=\{request\.profileImageUrl\}/);
  assert.match(source, /name=\{sentInviteDisplayName\(request\)\}/);
  assert.match(source, /className="app-contacts-sent-invite-item w-full px-3 py-2\.5 text-white"/);
  assert.doesNotMatch(source, /className="app-list-item w-full rounded-2xl bg-transparent px-3 py-2 text-white"/);
  assert.doesNotMatch(source, /max-w-\[720px\]/);
  assert.match(source, /app-contacts-sent-invite-item w-full px-3 py-2\.5 text-white/);
  assert.match(source, /className="h-9 w-9 border border-white\/10"/);
  assert.match(source, /Awaiting approval/);
  assert.match(source, /formatDesktopContactRequestTimeLabel\(request\.time\)/);
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
      displayName: '111',
      avatarUrl: 'data:image/png;base64,avatar-111',
      nodeId: null,
      createdAt: 'now',
    },
  });

  assert.equal(mapped.avatarName, '111');
  assert.equal(mapped.profileImageUrl, 'data:image/png;base64,avatar-111');
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

test('active contact rows stay visually neutral until hover', () => {
  const markup = renderToStaticMarkup(createElement(ContactRow, {
    contact: contact({ id: 'cloud:acct_peer', name: 'Maya Chen', subtitle: 'acct_33bb4b1b5c8349ad8f26467854f3f18e' }),
    active: true,
    onSelect: () => undefined,
  }));

  assert.match(markup, /app-contact-row/);
  assert.match(markup, /app-list-item/);
  assert.doesNotMatch(markup, /app-list-item-active/);
  assert.doesNotMatch(markup, /text-slate-100/);
});

test('contacts page uses positive-only request activity and flat page-plane controls', () => {
  const source = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');
  const componentSource = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
  const shellCss = readDesktopShellCss();
  const themeOverridesCss = shellCss;

  assert.match(source, /app-contacts-section-button/);
  assert.match(source, /app-contacts-action-chip/);
  assert.match(source, /app-contacts-request-activity/);
  assert.match(source, /app-contacts-content-rail/);
  assert.match(source, /app-contacts-request-row/);
  assert.match(source, /app-flat-input app-contacts-search/);
  assert.match(source, /app-contacts-add-form/);
  assert.match(source, /app-contacts-group-row/);
  assert.match(source, /app-contacts-section-heading/);
  assert.match(source, /app-contacts-add-button h-8 rounded-\[8px\]/);
  assert.match(source, /app-contacts-sent-invites-row/);
  assert.match(source, /pendingRequestCount > 0 && \(/);
  assert.match(source, /sentInviteCount > 0 && \(/);
  assert.doesNotMatch(source, /app-contacts-status-chip|No pending|None sent/);
  assert.doesNotMatch(source, /Classified as my agents/);
  assert.doesNotMatch(source, /Foldable classes with quick letter jump/);
  assert.doesNotMatch(source, /mb-4 flex items-center justify-between/);
  assert.doesNotMatch(source, /app-control-chip rounded-xl border-0/);
  assert.doesNotMatch(source, /app-surface-muted flex w-full items-center justify-between gap-3 rounded-2xl/);
  assert.doesNotMatch(source, /className="app-surface-muted mb-4 rounded-2xl px-3 py-3"/);
  assert.doesNotMatch(source, /app-contacts-section-button flex w-full items-center justify-between gap-3 rounded-\[24px\]/);
  assert.doesNotMatch(source, /app-contacts-section-button flex w-full items-center justify-between rounded-\[24px\]/);
  assert.doesNotMatch(source, /app-contacts-action-chip h-9 rounded-full px-4/);
  assert.match(shellCss, /\.app-contacts-action-chip[\s\S]*box-shadow:\s*none/);
  assert.match(shellCss, /\.app-contacts-section-button[\s\S]*box-shadow:\s*none/);
  assert.match(shellCss, /\.app-contacts-content-rail[\s\S]*max-width:\s*none/);
  assert.match(shellCss, /\.app-contacts-request-row[\s\S]*border-radius:\s*8px/);
  assert.match(shellCss, /\.app-contacts-search[\s\S]*border-radius:\s*8px/);
  assert.match(shellCss, /\.app-contacts-sent-invites-row\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  assert.match(shellCss, /\.app-contacts-sent-invites-row > button:hover\s*\{[^}]*background:\s*transparent;/s);
  assert.match(shellCss, /\.app-contact-request-item,[\s\S]*?\.app-contacts-sent-invite-item\s*\{[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  assert.match(shellCss, /\.app-contacts-add-form\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  assert.match(shellCss, /\.app-input-shell\.app-flat-input\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*transition:\s*none;/s);
  assert.match(shellCss, /\.kordi-app\.theme-light \.app-input-shell\.app-flat-input\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*transition:\s*none;/s);
  assert.match(shellCss, /\.app-contacts-group-row[\s\S]*border-radius:\s*0/);
  assert.match(shellCss, /\.app-contacts-group-row[\s\S]*border-width:\s*0 0 1px/);
  const contactRowStart = componentSource.indexOf('export function ContactRow');
  const contactRowEnd = componentSource.indexOf('export function ContactRequestRow', contactRowStart + 1);
  assert.ok(contactRowStart >= 0, 'ContactRow source block should be present');
  const contactRowBlock = componentSource.slice(contactRowStart, contactRowEnd > contactRowStart ? contactRowEnd : undefined);
  assert.match(contactRowBlock, /app-contact-row app-list-item/);
  assert.doesNotMatch(contactRowBlock, /app-list-item-active/);
  assert.match(shellCss, /\.app-list-item:hover[\s\S]*background:\s*var\(--app-control-bg\)/);
  assert.match(shellCss, /\.app-contacts-content-rail \.app-contact-row\.app-list-item:hover\s*\{[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(shellCss, /\.app-contact-row\.app-list-item-active/);
  assert.doesNotMatch(themeOverridesCss, /\.kordi-app\.theme-light \.app-contact-row\.app-list-item-active/);
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

test('contact overlays use the shared popup shell with flat actions at rest', () => {
  const markup = renderContactsPage([], {
    contactOverlayMode: 'contact',
    activeContact: contact({
      id: 'cloud:acct_peer',
      name: 'Maya Chen',
      subtitle: 'acct_33bb4b1b5c8349ad8f26467854f3f18e',
      sourceHostId: 'cloud',
      sourceParticipantId: 'acct_33bb4b1b5c8349ad8f26467854f3f18e',
    }),
    onMessageContact: () => undefined,
    onRemoveContact: () => undefined,
  });
  const css = readFileSync(new URL('../src/styles/transient-surfaces.css', import.meta.url), 'utf8');
  const requestMarkup = renderContactsPage([request()], {
    contactOverlayMode: 'request',
    activeContactRequest: request(),
    onAcceptRequest: () => undefined,
    onRejectRequest: () => undefined,
  });

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /app-contact-detail-dialog/);
  assert.ok((markup.match(/app-transient-flat-action/g) ?? []).length >= 3);
  assert.match(markup, /app-transient-flat-action-danger/);
  assert.doesNotMatch(markup, /app-transient-row-danger rounded-full/);
  assert.match(requestMarkup, /aria-label="Contact request review"/);
  assert.ok((requestMarkup.match(/app-transient-flat-action/g) ?? []).length >= 4);
  assert.match(requestMarkup, /app-transient-flat-action-danger/);
  assert.match(css, /\.app-transient-surface \.app-transient-flat-action \{[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.app-transient-surface \.app-transient-flat-action:hover,[\s\S]*?background:\s*var\(--app-transient-hover-bg\);/);
  assert.match(css, /\.app-transient-surface \.app-transient-flat-action-danger:hover,[\s\S]*?background:\s*var\(--app-transient-danger-hover-bg\);/);
});

test('contact detail modal removes redundant repeated metadata and unused profile action', () => {
  const source = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');

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

  assert.equal((markup.match(/acct_peer_123/g) ?? []).length, 1);
});

test('contacts add surface uses concise public Kordi ID controls without implementation wording', () => {
  const source = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');

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
