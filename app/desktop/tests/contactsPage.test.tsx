import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContactsPage } from '../src/kordi-app/pages';
import { cloudRequestToContactRequest } from '../src/features/cloud/useCloudContacts';
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
  assert.equal((markup.match(/No requests for you to review\./g) ?? []).length, 1);
  assert.equal((markup.match(/No sent invites waiting for approval\./g) ?? []).length, 1);
  assert.doesNotMatch(markup, /app-badge-attention[^>]*>0</);
});

test('contacts request header counts incoming approvals separately from outgoing invites', () => {
  const markup = renderContactsPage([
    request({ id: 'request-in', direction: 'incoming' }),
    request({ id: 'request-out', title: 'Request sent to Maya Chen', detail: 'acct_maya_123', direction: 'outgoing' }),
  ]);

  assert.match(markup, /app-badge-attention[^>]*>1</);
  assert.doesNotMatch(markup, /app-badge-attention[^>]*>2</);
  assert.match(markup, />Review 1 pending request\.</);
  assert.match(markup, />Sent invites</);
  assert.match(markup, />Waiting on 1 person to approve\.</);
  assert.doesNotMatch(markup, />Request sent to Maya Chen</);
});

test('contacts page summarizes outgoing-only pending invites without showing the full list by default', () => {
  const markup = renderContactsPage([
    request({ id: 'request-out', title: 'Request sent to Maya Chen', detail: 'acct_maya_123', direction: 'outgoing' }),
  ]);

  assert.match(markup, />No pending</);
  assert.match(markup, />No requests for you to review\.</);
  assert.match(markup, />Sent invites</);
  assert.match(markup, />Waiting on 1 person to approve\.</);
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

  assert.match(source, /<IdentityAvatar/);
  assert.match(source, /imageUrl=\{request\.profileImageUrl\}/);
  assert.match(source, /name=\{request\.avatarName \?\? request\.title\}/);
  assert.match(source, /className="app-list-item w-full rounded-2xl bg-transparent px-3 py-2 text-white"/);
  assert.doesNotMatch(source, /max-w-\[720px\]/);
  assert.match(source, /px-3 py-2 text-white/);
  assert.match(source, /className="h-9 w-9 border border-white\/10"/);
  assert.match(source, /items-center justify-between/);
  assert.doesNotMatch(source, /mt-3 inline-flex rounded-full border border-amber-300\/20 bg-amber-300\/10/);
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

test('contacts page controls use a Vercel-style aligned rail with reduced shape', () => {
  const source = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');
  const componentSource = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');

  assert.match(source, /app-contacts-section-button/);
  assert.match(source, /app-contacts-action-chip/);
  assert.match(source, /app-contacts-status-chip/);
  assert.match(source, /app-contacts-content-rail/);
  assert.match(source, /app-contacts-request-row/);
  assert.match(source, /app-contacts-search/);
  assert.match(source, /app-contacts-group-row/);
  assert.match(source, /app-contacts-section-heading/);
  assert.match(source, /app-contacts-add-button h-8 rounded-\[8px\]/);
  assert.match(source, /app-contacts-sent-invites-row/);
  assert.doesNotMatch(source, /Classified as my agents/);
  assert.doesNotMatch(source, /Foldable classes with quick letter jump/);
  assert.doesNotMatch(source, /mb-4 flex items-center justify-between/);
  assert.doesNotMatch(source, /app-control-chip rounded-xl border-0/);
  assert.doesNotMatch(source, /app-surface-muted flex w-full items-center justify-between gap-3 rounded-2xl/);
  assert.doesNotMatch(source, /app-contacts-section-button flex w-full items-center justify-between gap-3 rounded-\[24px\]/);
  assert.doesNotMatch(source, /app-contacts-section-button flex w-full items-center justify-between rounded-\[24px\]/);
  assert.doesNotMatch(source, /app-contacts-action-chip h-9 rounded-full px-4/);
  assert.match(shellCss, /\.app-contacts-action-chip[\s\S]*box-shadow:\s*none/);
  assert.match(shellCss, /\.app-contacts-section-button[\s\S]*box-shadow:\s*none/);
  assert.match(shellCss, /\.app-contacts-content-rail[\s\S]*max-width:\s*none/);
  assert.match(shellCss, /\.app-contacts-request-row[\s\S]*border-radius:\s*8px/);
  assert.match(shellCss, /\.app-contacts-search[\s\S]*border-radius:\s*8px/);
  assert.match(shellCss, /\.app-contacts-sent-invites-row[\s\S]*border-radius:\s*8px/);
  assert.match(shellCss, /\.app-contacts-group-row[\s\S]*border-radius:\s*0/);
  assert.match(shellCss, /\.app-contacts-group-row[\s\S]*border-width:\s*0 0 1px/);
  assert.match(componentSource, /app-contact-row/);
  assert.match(shellCss, /\.app-contact-row\.app-list-item-active[\s\S]*box-shadow:\s*none/);
  assert.match(themeOverridesCss, /\.bridge-app\.theme-light \.app-contact-row\.app-list-item-active[\s\S]*box-shadow:\s*none/);
});

test('contact detail modal removes redundant repeated metadata and unused profile action', () => {
  const source = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');

  assert.match(source, /Contact detail/);
  assert.doesNotMatch(source, /Owner: \{selfObjectLabel\(activeContact\.owner\)\}/);
  assert.doesNotMatch(source, />Joined bridges</);
  assert.doesNotMatch(source, />Discoverable on</);
  assert.doesNotMatch(source, />\s*View full profile\s*</);
  assert.doesNotMatch(source, /BridgeChip key=\{bridge\}/);
});

test('contacts add surface uses account search copy without bridge implementation wording', () => {
  const source = readFileSync(new URL('../src/kordi-app/pages.tsx', import.meta.url), 'utf8');

  assert.match(source, /Search by exact account ID/);
  assert.match(source, /Send an approval request/);
  assert.match(source, /Request pending/);
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
