import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { CommonGroundContactsRow } from '../src/features/commonGround/CommonGroundContactsRow';
import { ContactDetailDialog } from '../src/kordi-app/contacts/ContactDetailPane';
import { ContactsPage } from '../src/kordi-app/pages';
import type { ContactsPageProps } from '../src/kordi-app/contacts/contactsPageTypes';
import { contact, contactsPageProps, renderContactsPage, request } from './helpers/contactsPageFixtures';
import { installDom } from './helpers/transcriptAttachmentDom';
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
  assert.match(listSource, /<SidebarSearchField/);
  assert.match(listSource, /<SidebarListHeader title="Contacts">/);
  assert.match(pageSource, /createPortal\(<ContactsListColumn \{\.\.\.listProps\} inSidebar \/>, slot\)/);
  assert.match(listSource, /label="Add contact"/);
  assert.match(listSource, /icon={UserPlus}/);
  assert.match(listSource, /<ContactsListSection/);
  assert.match(listSource, /app-contacts-list-divider/);
  assert.doesNotMatch(listSource, /getContactSortLetter|uppercase/);
  assert.match(activitySource, /app-contacts-request-activity/);
  assert.match(activitySource, /<ContactsListSection/);
  assert.match(activitySource, /label="Requests"/);
  assert.doesNotMatch(activitySource, /isSentInvitesOpen|New requests|Sent invites|app-contacts-status-chip|No pending|None sent/);
  assert.match(shellCss, /\.app-contacts-list-column\.is-standalone\s*\{[^}]*border-right:\s*1px solid var\(--app-divider\);/s);
  assert.match(shellCss, /\.app-contacts-group-row\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font-size:\s*12px;[^}]*font-weight:\s*600;/s);
  assert.match(shellCss, /:is\(\.app-contacts-page, \.app-contacts-list-column\) \.app-contact-row\.app-list-item,\s*:is\(\.app-contacts-page, \.app-contacts-list-column\) \.app-contact-request-row\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(shellCss, /\.app-contacts-accept-pill,\s*\.app-contacts-tile\.is-primary\s*\{[^}]*background:\s*var\(--app-accent\);[^}]*color:\s*var\(--app-palette-accent-ink\);/s);
  assert.match(shellCss, /\.app-contacts-add-form\s*\{[^}]*box-shadow:\s*none;/s);
  assert.match(shellCss, /\.app-contact-row\.app-contact-row-selected[\s\S]*?background:\s*var\(--app-sidebar-selected-bg\)/);
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
      presenceStatus: 'online',
    }),
    onMessageContact: () => undefined,
    onRemoveContact: () => undefined,
  });

  assert.doesNotMatch(markup, /role="dialog"/);
  assert.match(markup, /app-contacts-detail-pane/);
  assert.match(markup, /aria-label="Maya Chen contact details"/);
  assert.match(markup, /app-contacts-tile[^"]*"[^>]*>.*Message</);
  assert.match(markup, /aria-label="More actions"/);
  assert.match(markup, />More</);
  assert.doesNotMatch(markup, /Deleting removes both contact directions/, 'the confirm waits for a click');
  assert.match(markup, /aria-label="Close"/);
  assert.match(markup, />Maya Chen</);
  assert.match(markup, /app-contacts-detail-presence[^"]*app-contacts-presence-online[^"]*">online</);
  assert.doesNotMatch(markup, />Status</);
});

test('contact detail is a centered profile with tiles, an info card, and a delete row', () => {
  const markup = renderContactsPage([], {
    contactOverlayMode: 'contact',
    activeContact: contact({
      id: 'cloud:acct_hana',
      name: 'Hana Sato',
      subtitle: '@193847562',
      detail: 'Memory systems group',
      sourceHostId: 'cloud',
      sourceParticipantId: 'acct_hana',
      presenceStatus: 'offline',
      presenceLastSeenAt: new Date(Date.now() - 9 * 60_000).toISOString(),
    }),
    onMessageContact: () => undefined,
    onRemoveContact: () => undefined,
  });

  assert.match(markup, /app-contacts-detail-content[^"]*max-w-\[420px\]/);
  assert.match(markup, /app-contacts-detail-header flex flex-col items-center text-center/);
  assert.match(markup, /app-contacts-detail-avatar h-24 w-24/);
  assert.match(markup, /app-contacts-muted[^"]*">last seen 9 minutes ago</);
  assert.ok(markup.indexOf('app-contacts-tiles') < markup.indexOf('app-contacts-card'), 'tiles sit above the info card');
  assert.match(markup, /app-contacts-card-value[^"]*is-accent[^"]*">@193847562</);
  assert.match(markup, />Kordi ID</);
  assert.match(markup, /aria-label="Copy Kordi ID"/);
  assert.match(markup, />Memory systems group<\/div><div[^>]*>About</);
  assert.doesNotMatch(markup, />Person</, 'a plain person needs no type row');
  assert.match(markup, /app-contacts-card-action[^>]*>.*Delete contact</);
  assert.doesNotMatch(markup, /Mute|Call/);

  const agentMarkup = renderContactsPage([], {
    contactOverlayMode: 'contact',
    activeContact: contact({ name: 'Research agent', classType: 'my-agents', entityType: 'My agent', subtitle: 'On this Mac', detail: '' }),
  });
  assert.match(agentMarkup, /app-contacts-detail-presence[^"]*app-contacts-muted[^"]*">On this Mac</);
  assert.match(agentMarkup, />Agent<\/div><div[^>]*>Type</);
  assert.doesNotMatch(agentMarkup, /aria-label="More actions"|Delete contact/);
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
  assert.match(markup, /aria-label="More actions"/);
  assert.match(requestMarkup, /aria-label="Contact request review"/);
  assert.match(requestMarkup, />Testuser</);
  assert.match(requestMarkup, />Requested</);
  assert.match(requestMarkup, />Note</);
  assert.match(requestMarkup, />Accept</);
  assert.match(requestMarkup, />Reject</);
  assert.doesNotMatch(requestMarkup, /Close review/);
  assert.doesNotMatch(requestMarkup, /uppercase/);
});

test('every contact group gets a sentence-case section header that collapses', () => {
  const single = renderContactsPage([], {
    filteredGroupedContacts: [
      { id: 'other-users', label: 'Other users', items: [contact({ id: 'a', name: 'Maya Chen' }), contact({ id: 'b', name: 'Hana Sato' })] },
    ],
    expandedContactGroups: { 'my-agents': false, 'other-users-agents': false, 'other-users': true },
  });
  assert.match(single, /app-contacts-group-row/);
  assert.match(single, />Contacts</);
  assert.match(single, /app-contacts-group-count">2</);
  assert.match(single, />Maya Chen</);
  assert.match(single, />Hana Sato</);
  assert.doesNotMatch(single, /uppercase/);

  const several = renderContactsPage([], {
    filteredGroupedContacts: [
      { id: 'other-users-agents', label: 'Kordi', items: [contact({ id: 's', name: 'Kordi Support', classType: 'other-users-agents' })] },
      { id: 'other-users', label: 'Other users', items: [contact({ id: 'a', name: 'Maya Chen' })] },
      { id: 'my-agents', label: 'My agents', items: [contact({ id: 'c', name: 'Research agent', classType: 'my-agents' })] },
    ],
    expandedContactGroups: { 'my-agents': false, 'other-users-agents': true, 'other-users': true },
  });
  assert.match(several, />Kordi</);
  assert.match(several, />Contacts</);
  assert.match(several, />My agents</);
  assert.match(several, />Maya Chen</);
  assert.doesNotMatch(several, />Research agent</);
});

test('contacts list renders optional leading items above the request inbox', () => {
  const markup = renderContactsPage([request({ id: 'request-in', direction: 'incoming' })], {
    leadingListItems: createElement('div', { 'data-testid': 'pinned-row' }, 'Pinned row'),
  });

  assert.ok(markup.indexOf('Pinned row') >= 0);
  assert.ok(markup.indexOf('Pinned row') < markup.indexOf('>Requests<'));
  assert.ok(markup.indexOf('Pinned row') < markup.indexOf('app-contacts-list-divider'));
  assert.ok(markup.indexOf('app-contacts-list-divider') < markup.indexOf('>Requests<'));
  assert.match(markup, /aria-label="Add contact"/);
});

async function mountContactsPage(overrides: Partial<ContactsPageProps> = {}) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: Partial<ContactsPageProps> = {}) => act(() => {
    root.render(createElement(ContactsPage, contactsPageProps({ ...overrides, ...next })));
  });
  await render();
  return {
    host,
    render,
    click: (element: Element | null | undefined) => act(async () => {
      assert.ok(element, 'element to click should exist');
      element.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true }));
    }),
    async cleanup() {
      await act(async () => root.unmount());
      installed.restore();
    },
  };
}

function buttonByText(host: HTMLElement, text: string) {
  return [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === text);
}

test('clicking a request row selects it and opens Accept and Reject in the detail pane', async () => {
  const selected: string[] = [];
  const noor = request({ id: 'req-noor', title: 'Noor Haddad wants to connect', avatarName: 'Noor Haddad', detail: '@305918274', direction: 'incoming' });
  const page = await mountContactsPage({
    contactRequests: [noor],
    onSelectRequest: (picked) => { selected.push(picked.id); },
    onAcceptRequest: () => undefined,
    onRejectRequest: () => undefined,
  });
  try {
    await page.click(page.host.querySelector('.app-contact-request-select'));
    assert.deepEqual(selected, ['req-noor']);

    await page.render({ contactOverlayMode: 'request', activeContactRequestId: 'req-noor' });
    const pane = page.host.querySelector('[aria-label="Contact request review"]');
    assert.ok(pane, 'the request opens in the detail pane');
    assert.match(pane.textContent ?? '', /Noor Haddad/);
    assert.match(pane.textContent ?? '', /Wants to connect/);
    assert.match(pane.textContent ?? '', /@305918274Kordi ID/);
    assert.match(pane.textContent ?? '', /Requested/);
    assert.ok(pane.querySelector('[aria-label="Copy Kordi ID"]'));
    assert.ok(pane.querySelector('.app-contacts-tile.is-primary'), 'Accept is the primary tile');
    assert.ok(pane.querySelector('.app-contacts-tile.is-danger'), 'Reject is the danger tile');
    assert.ok(buttonByText(pane as HTMLElement, 'Accept'));
    assert.ok(buttonByText(pane as HTMLElement, 'Reject'));
    assert.equal(page.host.querySelector('.app-contact-request-row')?.classList.contains('app-contact-row-selected'), true);

    await page.render({ contactOverlayMode: 'request', activeContactRequestId: 'req-noor', contactRequests: [] });
    assert.equal(page.host.querySelector('[aria-label="Contact request review"]'), null, 'a resolved request leaves the pane');
  } finally {
    await page.cleanup();
  }
});

test('delete waits behind the overflow menu and an inline confirm', async () => {
  const removed: string[] = [];
  let closed = 0;
  const maya = contact({ id: 'cloud:acct_maya', name: 'Maya Chen', sourceHostId: 'cloud', sourceParticipantId: 'acct_maya' });
  const page = await mountContactsPage({
    contactOverlayMode: 'contact',
    activeContact: maya,
    onCloseOverlay: () => { closed += 1; },
    onRemoveContact: (picked) => { removed.push(picked.id); },
  });
  try {
    assert.equal(page.host.querySelector('[role="menu"]'), null);
    await page.click(page.host.querySelector('[aria-label="More actions"]'));
    await page.click(page.host.querySelector('[role="menuitem"]'));
    assert.match(page.host.textContent ?? '', /Deleting removes both contact directions/);
    assert.deepEqual(removed, [], 'opening the confirm does not delete');

    await page.click(buttonByText(page.host, 'Cancel'));
    assert.doesNotMatch(page.host.textContent ?? '', /Deleting removes both contact directions/);

    await page.click(page.host.querySelector('[aria-label="More actions"]'));
    await page.click(page.host.querySelector('[role="menuitem"]'));
    await page.click(buttonByText(page.host, 'Delete'));
    assert.deepEqual(removed, ['cloud:acct_maya']);
    assert.equal(closed, 1);
  } finally {
    await page.cleanup();
  }
});

test('the delete row opens the same inline confirm', async () => {
  const removed: string[] = [];
  const maya = contact({ id: 'cloud:acct_maya', name: 'Maya Chen', sourceHostId: 'cloud', sourceParticipantId: 'acct_maya' });
  const page = await mountContactsPage({
    contactOverlayMode: 'contact',
    activeContact: maya,
    onRemoveContact: (picked) => { removed.push(picked.id); },
  });
  try {
    const deleteRow = page.host.querySelector('.app-contacts-card-action');
    assert.equal(deleteRow?.textContent?.trim(), 'Delete contact');
    await page.click(deleteRow);
    const confirm = page.host.querySelector('[role="group"][aria-label="Delete contact"]');
    assert.ok(confirm, 'the confirm opens below the row');
    assert.ok(deleteRow?.closest('.app-contacts-card')?.nextElementSibling === confirm);
    assert.deepEqual(removed, []);
    await page.click(buttonByText(page.host, 'Delete'));
    assert.deepEqual(removed, ['cloud:acct_maya']);
  } finally {
    await page.cleanup();
  }
});

test('the copy button copies the Kordi ID handle', async () => {
  const page = await mountContactsPage({
    contactOverlayMode: 'contact',
    activeContact: contact({ id: 'cloud:acct_maya', name: 'Maya Chen', subtitle: '@482731906', sourceHostId: 'cloud', sourceParticipantId: 'acct_maya' }),
  });
  const copied: string[] = [];
  const clipboard = { writeText: (value: string) => { copied.push(value); return Promise.resolve(); } };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  try {
    await page.click(page.host.querySelector('[aria-label="Copy Kordi ID"]'));
    assert.deepEqual(copied, ['@482731906']);
    assert.ok(page.host.querySelector('[aria-label="Copied"]'));
  } finally {
    await page.cleanup();
  }
});

test('a failed delete keeps the confirm open with the error', async () => {
  const maya = contact({ id: 'cloud:acct_maya', name: 'Maya Chen', sourceHostId: 'cloud', sourceParticipantId: 'acct_maya' });
  const page = await mountContactsPage({
    contactOverlayMode: 'contact',
    activeContact: maya,
    onRemoveContact: () => Promise.reject(new Error('Contact service unavailable')),
  });
  try {
    await page.click(page.host.querySelector('[aria-label="More actions"]'));
    await page.click(page.host.querySelector('[role="menuitem"]'));
    await page.click(buttonByText(page.host, 'Delete'));
    const error = page.host.querySelector('.app-contacts-confirm .app-error-text');
    assert.equal(error?.textContent, 'Contact service unavailable');
  } finally {
    await page.cleanup();
  }
});

test('leading detail replaces the contact detail pane and leaves the default unchanged when unset', () => {
  const selected = contact({ id: 'cloud:acct_peer', name: 'Maya Chen', sourceHostId: 'cloud', sourceParticipantId: 'acct_peer' });
  const markup = renderContactsPage([], {
    contactOverlayMode: 'contact',
    activeContact: selected,
    leadingListItems: createElement(CommonGroundContactsRow, { selected: true, hasInvitation: true, onSelect: () => undefined }),
    leadingDetail: createElement('div', { 'data-testid': 'leading-detail' }, 'Common ground page'),
  });

  assert.match(markup, /app-contacts-leading-detail/);
  assert.match(markup, />Common ground page</);
  assert.doesNotMatch(markup, /Maya Chen contact details/);
  assert.doesNotMatch(markup, /No contact selected/);
  assert.match(markup, /aria-label="Contacts list"/);
  assert.match(markup, /app-common-ground-row[^"]*app-contact-row-selected/);
  assert.match(markup, />Match. Meet. Build.</);
  assert.match(markup, /aria-label="Room invitation waiting"/);

  const cleared = renderContactsPage([], { contactOverlayMode: 'contact', activeContact: selected, leadingDetail: null });
  assert.doesNotMatch(cleared, /app-contacts-leading-detail/);
  assert.match(cleared, /aria-label="Maya Chen contact details"/);

  const quietRow = renderToStaticMarkup(createElement(CommonGroundContactsRow, { selected: false, onSelect: () => undefined }));
  assert.doesNotMatch(quietRow, /app-contact-row-selected|Room invitation waiting/);
  assert.match(quietRow, /app-common-ground-tile/);
});
