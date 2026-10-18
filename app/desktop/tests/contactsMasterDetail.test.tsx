import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContactDetailDialog } from '../src/kordi-app/contacts/ContactDetailPane';
import { contact, renderContactsPage, request } from './helpers/contactsPageFixtures';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

test('contacts page is a master-detail layout with themed list controls', () => {
  const pageSource = readFileSync(new URL('../src/kordi-app/contacts/ContactsPage.tsx', import.meta.url), 'utf8');
  const listSource = readFileSync(new URL('../src/kordi-app/contacts/ContactsListColumn.tsx', import.meta.url), 'utf8');
  const activitySource = readFileSync(new URL('../src/kordi-app/contacts/ContactsRequestActivity.tsx', import.meta.url), 'utf8');
  const componentSource = readFileSync(new URL('../src/kordi-app/components/transcriptContacts.tsx', import.meta.url), 'utf8');
  const shellCss = readDesktopShellCss();

  assert.match(pageSource, /useIsNarrowContainer\(rootRef, CONTACTS_SPLIT_MIN_WIDTH\)/);
  assert.match(pageSource, /const CONTACTS_SPLIT_MIN_WIDTH = 720;/);
  assert.match(pageSource, /<ContactDetailDialog/);
  assert.match(pageSource, /<ContactDetailPane/);
  assert.match(listSource, /app-contacts-list-column/);
  assert.match(listSource, /app-contacts-search/);
  assert.match(listSource, /aria-label="Add contact"/);
  assert.match(listSource, /<UserPlus/);
  assert.match(listSource, /app-contacts-group-row/);
  assert.doesNotMatch(listSource, /getContactSortLetter|uppercase/);
  assert.match(activitySource, /app-contacts-request-activity/);
  assert.match(activitySource, /app-contacts-request-row/);
  assert.match(activitySource, /app-contacts-sent-invites-row/);
  assert.match(activitySource, /pendingRequestCount > 0 && \(/);
  assert.match(activitySource, /sentInviteCount > 0 && \(/);
  assert.doesNotMatch(activitySource, /app-contacts-status-chip|No pending|None sent/);
  assert.match(shellCss, /\.app-contacts-list-column\s*\{[^}]*border-right:\s*1px solid var\(--app-divider\);/s);
  assert.match(shellCss, /\.app-contacts-search\s*\{[^}]*border-radius:\s*9px;/s);
  assert.match(shellCss, /\.app-contacts-request-row\s*\{[^}]*border-radius:\s*10px;/s);
  assert.match(shellCss, /\.app-contacts-group-row\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(shellCss, /\.app-contact-request-item,[\s\S]*?\.app-contacts-sent-invite-item\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  assert.match(shellCss, /\.app-contacts-add-form\s*\{[^}]*box-shadow:\s*none;/s);
  assert.match(shellCss, /\.app-contact-row\.app-contact-row-selected[\s\S]*?background:\s*color-mix\(in oklab, var\(--app-accent\)/);
  assert.match(shellCss, /\.app-contacts-primary-action\s*\{[^}]*background:\s*var\(--utility-foreground\);[^}]*color:\s*var\(--utility-background\);/s);
  const contactsCss = readFileSync(new URL('../src/styles/shell-contacts.css', import.meta.url), 'utf8');
  assert.doesNotMatch(contactsCss, /#[0-9a-f]{3,8}\b|rgb\(/i, 'contacts styles should only use theme tokens');
  const contactRowStart = componentSource.indexOf('export function ContactRow');
  const contactRowEnd = componentSource.indexOf('export function ContactRequestRow', contactRowStart + 1);
  assert.ok(contactRowStart >= 0, 'ContactRow source block should be present');
  const contactRowBlock = componentSource.slice(contactRowStart, contactRowEnd > contactRowStart ? contactRowEnd : undefined);
  assert.match(contactRowBlock, /app-contact-row app-list-item/);
  assert.match(contactRowBlock, /cornerRadius="50%"/);
  assert.doesNotMatch(contactRowBlock, /app-list-item-active|text-white|ChevronRight/);
});

test('wide contacts page shows the selected contact in a detail pane, not a modal', () => {
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

  assert.doesNotMatch(markup, /role="dialog"/);
  assert.match(markup, /app-contacts-detail-pane/);
  assert.match(markup, /aria-label="Maya Chen contact details"/);
  assert.match(markup, /app-contacts-primary-action[^"]*"[^>]*>.*Message</);
  assert.match(markup, /app-contacts-danger-action/);
  assert.match(markup, />Delete contact</);
  assert.match(markup, /Deleting removes both contact directions/);
  assert.match(markup, /aria-label="Close"/);
});

test('contacts page shows a quiet empty detail pane when nothing is selected', () => {
  const markup = renderContactsPage([]);

  assert.match(markup, />No contact selected</);
  assert.doesNotMatch(markup, /role="dialog"/);
});

test('narrow-window detail dialog keeps the shared popup shell for contacts and requests', () => {
  const requestActions = {
    busy: false,
    canAccept: true,
    canReject: true,
    error: '',
    stateFor: () => null,
    submit: () => Promise.resolve(),
  };
  const markup = renderToStaticMarkup(createElement(ContactDetailDialog, {
    mode: 'contact',
    activeContact: contact({ name: 'Maya Chen', sourceHostId: 'cloud', sourceParticipantId: 'acct_peer' }),
    onCloseOverlay: () => undefined,
    onMessageContact: () => undefined,
    onRemoveContact: () => undefined,
    requestActions,
  }));
  const requestMarkup = renderToStaticMarkup(createElement(ContactDetailDialog, {
    mode: 'request',
    activeContact: contact(),
    activeContactRequest: request(),
    onCloseOverlay: () => undefined,
    requestActions,
  }));

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /app-transient-surface/);
  assert.match(markup, /app-contact-detail-dialog/);
  assert.match(markup, />Delete contact</);
  assert.match(requestMarkup, /aria-label="Contact request review"/);
  assert.match(requestMarkup, />Testuser wants to connect</);
  assert.match(requestMarkup, />Accept</);
  assert.match(requestMarkup, />Reject</);
  assert.doesNotMatch(requestMarkup, /Close review/);
  assert.doesNotMatch(requestMarkup, /uppercase/);
});

test('a single contact group shows no label or letter headers, several groups get sentence-case labels', () => {
  const single = renderContactsPage([], {
    filteredGroupedContacts: [
      { id: 'other-users', label: 'Other users', items: [contact({ id: 'a', name: 'Maya Chen' }), contact({ id: 'b', name: 'Hana Sato' })] },
    ],
  });
  assert.doesNotMatch(single, />Other users</);
  assert.match(single, />Maya Chen</);
  assert.match(single, />Hana Sato</);
  assert.doesNotMatch(single, /uppercase/);

  const several = renderContactsPage([], {
    filteredGroupedContacts: [
      { id: 'other-users', label: 'Other users', items: [contact({ id: 'a', name: 'Maya Chen' })] },
      { id: 'my-agents', label: 'My agents', items: [contact({ id: 'c', name: 'Research agent', classType: 'my-agents' })] },
    ],
    expandedContactGroups: { 'my-agents': false, 'other-users-agents': false, 'other-users': true },
  });
  assert.match(several, />Other users</);
  assert.match(several, />My agents</);
  assert.match(several, />Maya Chen</);
  assert.doesNotMatch(several, />Research agent</);
});

test('contacts list renders optional leading items above the request inbox', () => {
  const markup = renderContactsPage([request({ id: 'request-in', direction: 'incoming' })], {
    leadingListItems: createElement('div', { 'data-testid': 'pinned-row' }, 'Pinned row'),
  });

  assert.ok(markup.indexOf('Pinned row') >= 0);
  assert.ok(markup.indexOf('Pinned row') < markup.indexOf('New requests'));
  assert.match(markup, /aria-label="Add contact"/);
});
