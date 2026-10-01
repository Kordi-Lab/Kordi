import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudAuthError } from '../src/features/cloud/authClient';
import { BlockedAccountsSection } from '../src/features/safety/BlockedAccountsSection';
import { SafetyActionsContext, UNAVAILABLE_SAFETY_ACTIONS, type SafetyActions } from '../src/features/safety/safetyActions';
import { rememberBlockedAccount } from '../src/features/safety/useCloudBlocks';
import { ContactsPage } from '../src/kordi-app/pages';
import type { Contact, ContactRequest } from '../src/kordi-app/types';
import { mountInDom } from './helpers/safetyDom';

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

function safetyStub(overrides: Partial<SafetyActions> = {}): SafetyActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    ...UNAVAILABLE_SAFETY_ACTIONS,
    account: { accountId: 'acct_me' } as SafetyActions['account'],
    safetyFeaturesAvailable: true,
    blockedAccountIds: new Set(),
    openBlock: (target) => { calls.push(`block:${target.accountId}:${target.name}`); },
    openUnblock: (target) => { calls.push(`unblock:${target.accountId}`); },
    openReport: (target) => { calls.push(`report:${target.accountId}:${target.contactRequestId ?? ''}`); },
    calls,
    ...overrides,
  };
}

const cloudPeer = () => contact({
  id: 'cloud:acct_peer',
  name: 'Maya Chen',
  subtitle: '@482731906',
  sourceHostId: 'cloud',
  sourceParticipantId: 'acct_peer',
  sourceHumanId: 'acct_peer',
});

const cloudIncomingRequest = () => request({
  id: 'cloud:req_1',
  title: 'Maya Chen wants to connect',
  avatarName: 'Maya Chen',
  source: 'collaboration',
  sourceHostId: 'cloud',
  sourceRequestId: 'req_1',
  requesterNodeId: 'acct_peer',
  targetNodeId: 'acct_me',
  status: 'pending',
  direction: 'incoming',
});

function renderWithSafety(safety: SafetyActions, overrides: Partial<Parameters<typeof ContactsPage>[0]>, requests: ContactRequest[] = []) {
  return renderToStaticMarkup(createElement(SafetyActionsContext.Provider, { value: safety },
    createElement(ContactsPage, {
      filteredGroupedContacts: [],
      isContactRequestsOpen: true,
      onToggleRequests: () => undefined,
      contactRequests: requests,
      activeContactRequestId: '',
      contactSearch: '',
      onContactSearchChange: () => undefined,
      expandedContactGroups: { 'my-agents': false, 'other-users-agents': false, 'other-users': false },
      onToggleGroup: () => undefined,
      activeContactId: '',
      onSelectContact: () => undefined,
      contactOverlayMode: null,
      activeContact: contact(),
      onCloseOverlay: () => undefined,
      getStatusBadgeClass: () => '',
      ...overrides,
    })));
}

test('contact details offer Remove contact instead of a delete wording', () => {
  const markup = renderContactsPage([], {
    contactOverlayMode: 'contact',
    activeContact: cloudPeer(),
    onRemoveContact: () => undefined,
  });

  assert.match(markup, />Remove contact</);
  assert.doesNotMatch(markup, /Delete contact|Deleting/);
  assert.doesNotMatch(markup, />Block…</, 'no block action without a supporting server');
  assert.doesNotMatch(markup, />Report…</);
});

test('contact details and request review show block and report when the server supports them', () => {
  const safety = safetyStub();
  const detail = renderWithSafety(safety, { contactOverlayMode: 'contact', activeContact: cloudPeer() });
  assert.match(detail, />Block…</);
  assert.match(detail, />Report…</);

  const review = renderWithSafety(safety, {
    contactOverlayMode: 'request',
    activeContactRequest: cloudIncomingRequest(),
    onAcceptRequest: () => undefined,
    onRejectRequest: () => undefined,
  }, [cloudIncomingRequest()]);
  assert.match(review, /If you accept, Maya Chen can message you, add you to groups, see when you&#x27;re online, and ask your Kordi agent for help\./);
  assert.match(review, />Block…</);
  assert.match(review, />Report…</);

  const blocked = renderWithSafety(safetyStub({ blockedAccountIds: new Set(['acct_peer']) }), {
    contactOverlayMode: 'contact',
    activeContact: cloudPeer(),
  });
  assert.match(blocked, />Unblock…</);

  const support = renderWithSafety(safety, {
    contactOverlayMode: 'contact',
    activeContact: contact({ id: 'cloud:acct_kordi_support', name: 'Kordi Support', sourceHostId: 'cloud', sourceParticipantId: 'acct_kordi_support' }),
  });
  assert.doesNotMatch(support, />Block…</, 'service accounts cannot be blocked');
});

test('reporting from a request review sends the request id and closes the review first', async () => {
  const dom = await mountInDom();
  const safety = safetyStub();
  const order: string[] = [];
  try {
    await dom.render(createElement(SafetyActionsContext.Provider, { value: { ...safety, openReport: (target) => { order.push(`report:${target.contactRequestId}`); } } },
      createElement(ContactsPage, {
        filteredGroupedContacts: [],
        isContactRequestsOpen: false,
        onToggleRequests: () => undefined,
        contactRequests: [cloudIncomingRequest()],
        activeContactRequestId: 'cloud:req_1',
        contactSearch: '',
        onContactSearchChange: () => undefined,
        expandedContactGroups: { 'my-agents': false, 'other-users-agents': false, 'other-users': false },
        onToggleGroup: () => undefined,
        activeContactId: '',
        onSelectContact: () => undefined,
        contactOverlayMode: 'request',
        activeContact: contact(),
        activeContactRequest: cloudIncomingRequest(),
        onCloseOverlay: () => { order.push('close'); },
        getStatusBadgeClass: () => '',
      })));
    await dom.click(dom.findButton('Report…'));
    assert.deepEqual(order, ['close', 'report:req_1']);
  } finally {
    await dom.cleanup();
  }
});

test('removing a contact asks first, keeps history wording, and reports the outcome', async () => {
  const dom = await mountInDom();
  const removed: string[] = [];
  let closed = 0;
  try {
    await dom.render(createElement(ContactsPage, {
      filteredGroupedContacts: [],
      isContactRequestsOpen: false,
      onToggleRequests: () => undefined,
      contactRequests: [],
      activeContactRequestId: '',
      contactSearch: '',
      onContactSearchChange: () => undefined,
      expandedContactGroups: { 'my-agents': false, 'other-users-agents': false, 'other-users': false },
      onToggleGroup: () => undefined,
      activeContactId: 'cloud:acct_peer',
      onSelectContact: () => undefined,
      contactOverlayMode: 'contact',
      activeContact: cloudPeer(),
      onCloseOverlay: () => { closed += 1; },
      getStatusBadgeClass: () => '',
      onRemoveContact: async (target) => { removed.push(target.sourceParticipantId ?? ''); },
    }));
    await dom.click(dom.findButton('Remove contact'));
    assert.deepEqual(removed, [], 'the first click only asks');
    assert.match(dom.text(), /Remove Maya Chen from your contacts\?/);
    assert.match(dom.text(), /Your chat history stays\./);

    await dom.click(dom.findButton('Remove contact'));
    assert.deepEqual(removed, ['acct_peer']);
    assert.match(dom.text(), /Maya Chen was removed from your contacts\./);
    await dom.click(dom.findButton('Done'));
    assert.equal(closed, 1);
  } finally {
    await dom.cleanup();
  }
});

test('sent invites can be withdrawn when the server supports it', async () => {
  const dom = await mountInDom();
  const withdrawn: string[] = [];
  const outgoing = request({
    id: 'cloud:req_out',
    title: 'Request sent to Maya Chen',
    avatarName: 'Maya Chen',
    sourceRequestId: 'req_out',
    targetNodeId: 'acct_peer',
    direction: 'outgoing',
    status: 'pending',
  });
  try {
    await dom.render(createElement(ContactsPage, {
      filteredGroupedContacts: [],
      isContactRequestsOpen: false,
      onToggleRequests: () => undefined,
      contactRequests: [outgoing],
      activeContactRequestId: '',
      contactSearch: '',
      onContactSearchChange: () => undefined,
      expandedContactGroups: { 'my-agents': false, 'other-users-agents': false, 'other-users': false },
      onToggleGroup: () => undefined,
      activeContactId: '',
      onSelectContact: () => undefined,
      contactOverlayMode: null,
      activeContact: contact(),
      onCloseOverlay: () => undefined,
      getStatusBadgeClass: () => '',
      onWithdrawRequest: async (target) => {
        withdrawn.push(target.sourceRequestId ?? '');
        throw new CloudAuthError('request_decided', 'decided', 409);
      },
    }));
    await dom.click(dom.findButton(/Sent invites/));
    const withdraw = dom.document.querySelector<HTMLButtonElement>('button[aria-label="Withdraw request to Maya Chen"]');
    assert.equal(withdraw?.textContent, 'Withdraw');
    await dom.click(withdraw ?? undefined);
    assert.deepEqual(withdrawn, ['req_out']);
    assert.match(dom.text(), /This request was already answered or withdrawn\./);
  } finally {
    await dom.cleanup();
  }

  const withoutSupport = renderContactsPage([outgoing]);
  assert.doesNotMatch(withoutSupport, /Withdraw/);
});

test('blocked accounts are listed privately at the end of contacts with an unblock action', async () => {
  assert.doesNotMatch(renderContactsPage([]), /Blocked accounts/, 'hidden without a supporting server');

  const dom = await mountInDom();
  const safety = safetyStub({ account: { accountId: 'acct_list_owner' } as SafetyActions['account'] });
  rememberBlockedAccount('acct_list_owner', {
    accountId: 'acct_bea',
    kordiId: '123456789',
    displayName: 'Bea',
    avatarUrl: null,
    blockedAt: '2026-10-01T00:00:00Z',
  });
  try {
    await dom.render(createElement(SafetyActionsContext.Provider, { value: safety }, createElement(BlockedAccountsSection)));
    const toggle = dom.findButton(/Blocked accounts/);
    assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
    await dom.click(toggle);
    assert.match(dom.text(), /Bea/);
    await dom.click(dom.document.querySelector<HTMLButtonElement>('button[aria-label="Unblock Bea"]') ?? undefined);
    assert.deepEqual(safety.calls, ['unblock:acct_bea']);
  } finally {
    await dom.cleanup();
  }
});

test('cloud contacts route removal and withdrawal through the safety actions', () => {
  const source = readFileSync(new URL('../src/features/cloud/CloudContactsAdapter.tsx', import.meta.url), 'utf8');

  assert.match(source, /onRemoveContact=\{onRemoveContact\}/);
  assert.match(source, /onWithdrawRequest=\{onWithdrawRequest\}/);
  assert.match(source, /safety\.removeContact\(peerAccountId\)/);
  assert.match(source, /safety\.safetyFeaturesAvailable\s*\n?\s*\?/);
});
