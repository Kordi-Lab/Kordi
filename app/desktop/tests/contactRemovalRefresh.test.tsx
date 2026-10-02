import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import type { CloudAccount, CloudContactSummary } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import {
  applyCloudContactsRefreshSnapshot,
  forgetCloudContact,
  useCloudContacts,
  type UseCloudContactsResult,
} from '../src/features/cloud/useCloudContacts';
import { directConversationConsentState } from '../src/features/safety/directConversationConsent';
import { SafetyActionsProvider } from '../src/features/safety/SafetyActionsContext';
import { useSafetyActions, type SafetyActions } from '../src/features/safety/safetyActions';
import { __resetCloudBlocksForTests, refreshCloudBlocks } from '../src/features/safety/useCloudBlocks';
import { mountInDom, stubCloudNetwork } from './helpers/safetyDom';

const SELF = 'acct_contact_removal_self';

function summary(accountId: string): CloudContactSummary {
  return { accountId, displayName: accountId, avatarUrl: null, nodeId: null, createdAt: '2026-10-01T00:00:00Z' };
}

const revisions = { startedMutationRevision: 1, currentMutationRevision: 1 };

test('a refresh drops a contact the server confirmed before and no longer lists', () => {
  const current = { contacts: [summary('acct_removed'), summary('acct_accepted_here')], requests: [] };
  const next = applyCloudContactsRefreshSnapshot(
    current,
    { contacts: [], requests: [] },
    revisions,
    new Set(['account:acct_removed']),
  );
  // A contact accepted on this device stays until the server lists it.
  assert.deepEqual(next.contacts.map((contact) => contact.accountId), ['acct_accepted_here']);
});

test('removing or blocking a contact takes them off the list and the chat notice follows', async () => {
  let serverContacts = ['acct_removed', 'acct_blocked', 'acct_elsewhere'];
  const network = stubCloudNetwork(({ path }) => Response.json(
    path === '/v1/cloud/contacts/requests' ? { requests: [] } : { contacts: serverContacts.map(summary) },
  ));
  __setSessionBackendForTests({
    load: async () => ({ token: 'tok', accountId: SELF, expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  const account = { accountId: SELF } as CloudAccount;
  let contacts!: UseCloudContactsResult;
  function Harness() {
    contacts = useCloudContacts(account);
    return null;
  }
  const listed = () => contacts.contacts.map((contact) => contact.sourceParticipantId).sort();
  const consent = (peerAccountId: string, blocked: string[] = []) => directConversationConsentState({
    peerAccountId,
    contacts,
    blocks: {
      blocks: blocked.map((accountId) => ({ accountId, kordiId: null, displayName: null, avatarUrl: null, blockedAt: '' })),
      loaded: true,
      available: true,
      error: null,
    },
  })?.kind;
  const dom = await mountInDom();
  try {
    await dom.render(createElement(Harness));
    await act(async () => { await contacts.refresh(); });
    assert.deepEqual(listed(), ['acct_blocked', 'acct_elsewhere', 'acct_removed']);
    assert.equal(consent('acct_removed'), 'contact');

    // This device removes one contact and blocks another.
    serverContacts = ['acct_elsewhere'];
    await act(async () => {
      forgetCloudContact(SELF, 'acct_removed');
      forgetCloudContact(SELF, 'acct_blocked');
    });
    assert.deepEqual(listed(), ['acct_elsewhere']);
    assert.equal(consent('acct_removed'), 'none');
    assert.equal(consent('acct_blocked', ['acct_blocked']), 'blocked');
    // After an unblock the chat explains that they are not contacts.
    assert.equal(consent('acct_blocked'), 'none');

    // Another device (or the other person) ended a relationship: the next
    // refresh drops the contact the server stopped listing.
    serverContacts = [];
    await act(async () => { await contacts.refresh(); });
    assert.deepEqual(listed(), []);
    assert.equal(consent('acct_elsewhere'), 'none');
  } finally {
    await dom.cleanup();
    network.restore();
    __setSessionBackendForTests(null);
  }
});

test('the safety provider takes a removed or blocked person off the contact list at once', async () => {
  // Once a person is removed or blocked, listing fails, so only the
  // provider's own update can take them off the list.
  let listing = true;
  const blocked = { accountId: 'acct_blocked', kordiId: null, displayName: 'Blocked', avatarUrl: null, blockedAt: '2026-10-01T00:00:00Z' };
  const network = stubCloudNetwork(({ method, path }) => {
    if (method === 'GET' && path === '/v1/cloud/blocks') return Response.json({ blocks: [] });
    if (method === 'DELETE' && path === '/v1/cloud/contacts/acct_removed') {
      listing = false;
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT' && path === '/v1/cloud/blocks/acct_blocked') {
      listing = false;
      return Response.json({ block: blocked, removedContact: true });
    }
    if (!listing) return Response.json({ errorCode: 'server_error', message: 'Unavailable.' }, { status: 503 });
    return Response.json(path === '/v1/cloud/contacts/requests'
      ? { requests: [] }
      : { contacts: ['acct_removed', 'acct_blocked'].map(summary) });
  });
  __resetCloudBlocksForTests();
  __setSessionBackendForTests({
    load: async () => ({ token: 'tok', accountId: SELF, expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  const account = { accountId: SELF } as CloudAccount;
  let safety!: SafetyActions;
  let contacts!: UseCloudContactsResult;
  function Harness() {
    safety = useSafetyActions();
    contacts = useCloudContacts(account);
    return null;
  }
  const listed = () => contacts.contacts.map((contact) => contact.sourceParticipantId).sort();
  const dom = await mountInDom();
  try {
    await dom.render(createElement(SafetyActionsProvider, { account }, createElement(Harness)));
    await act(async () => {
      await refreshCloudBlocks(SELF);
      await contacts.refresh();
    });
    assert.equal(safety.safetyFeaturesAvailable, true);
    assert.deepEqual(listed(), ['acct_blocked', 'acct_removed']);

    await act(async () => { await safety.removeContact('acct_removed'); });
    assert.deepEqual(listed(), ['acct_blocked']);

    listing = true;
    await act(async () => { safety.openBlock({ accountId: 'acct_blocked', name: 'Blocked' }); });
    await dom.click(dom.findButton('Block'));
    assert.deepEqual(listed(), []);
  } finally {
    await dom.cleanup();
    network.restore();
    __setSessionBackendForTests(null);
    __resetCloudBlocksForTests();
  }
});
