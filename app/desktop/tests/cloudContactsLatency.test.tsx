import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  acceptedCloudContactPeerAccountId,
  applyAcceptedCloudContactRequest,
  cloudContactAcceptedSyncDetail,
  applyCloudContactsRefreshSnapshot,
  cloudContactAddedActorAccountId,
  mergeCloudContactRequestSnapshot,
  mergeCloudContactSummarySnapshot,
  removeCloudContactRequestSnapshot,
  selectCloudContactsSnapshotForAccount,
  shouldShowCloudContactsLoading,
  shouldRefreshCloudContactsForWsSubject,
} from '../src/features/cloud/useCloudContacts';
import type { CloudContactRequest, CloudContactSummary } from '../src/features/cloud/authClient';
import { IdentityAvatar } from '../src/kordi-app/components/IdentityAvatar';

function summary(overrides: Partial<CloudContactSummary> = {}): CloudContactSummary {
  return {
    accountId: 'acct_peer',
    displayName: 'Peer User',
    avatarUrl: 'https://images.test/peer.png',
    nodeId: null,
    createdAt: '2026-05-12T00:00:00Z',
    ...overrides,
  };
}

function request(overrides: Partial<CloudContactRequest> = {}): CloudContactRequest {
  return {
    requestId: 'req_1',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    status: 'pending',
    direction: 'outgoing',
    message: null,
    createdAt: '2026-05-12T00:00:00Z',
    decidedAt: null,
    counterpart: summary(),
    ...overrides,
  };
}

test('mergeCloudContactRequestSnapshot applies a sent request immediately with counterpart avatar data', () => {
  const snapshot = mergeCloudContactRequestSnapshot({ contacts: [], requests: [] }, request());

  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0]?.requestId, 'req_1');
  assert.equal(snapshot.requests[0]?.counterpart?.avatarUrl, 'https://images.test/peer.png');
});

test('removeCloudContactRequestSnapshot clears rejected request notices immediately', () => {
  const snapshot = removeCloudContactRequestSnapshot({ contacts: [], requests: [request({ direction: 'incoming' })] }, 'req_1');

  assert.deepEqual(snapshot.requests.map((item) => item.requestId), []);
});

test('applyAcceptedCloudContactRequest removes the pending request and adds the accepted counterpart immediately', () => {
  const accepted = request({ status: 'accepted', direction: 'incoming' });
  const snapshot = applyAcceptedCloudContactRequest({ contacts: [], requests: [request({ direction: 'incoming' })] }, accepted);

  assert.deepEqual(snapshot.requests.map((item) => item.requestId), []);
  assert.equal(snapshot.contacts.length, 1);
  assert.equal(snapshot.contacts[0]?.accountId, 'acct_peer');
  assert.equal(snapshot.contacts[0]?.avatarUrl, 'https://images.test/peer.png');
});

test('stale contact refreshes do not overwrite newer accepted contacts', () => {
  const current = { contacts: [summary()], requests: [] };
  const stale = { contacts: [], requests: [request({ direction: 'incoming' })] };

  assert.deepEqual(applyCloudContactsRefreshSnapshot(current, stale, {
    startedMutationRevision: 1,
    currentMutationRevision: 2,
  }), current);
  assert.deepEqual(applyCloudContactsRefreshSnapshot(current, stale, {
    startedMutationRevision: 2,
    currentMutationRevision: 2,
  }), { contacts: [summary()], requests: [] });
});

test('contact refresh preserves locally accepted contacts while the server snapshot catches up', () => {
  const current = { contacts: [summary({ accountId: 'acct_accepted' })], requests: [] };
  const delayed = { contacts: [], requests: [] };

  assert.deepEqual(applyCloudContactsRefreshSnapshot(current, delayed, {
    startedMutationRevision: 1,
    currentMutationRevision: 1,
  }), current);
});

test('equivalent contact refresh preserves contact and request array identities', () => {
  const current = {
    contacts: [summary()],
    requests: [request({
      direction: 'incoming',
      fromAccountId: 'acct_request',
      counterpart: summary({ accountId: 'acct_request' }),
    })],
  };
  const refreshed = structuredClone(current);

  const next = applyCloudContactsRefreshSnapshot(current, refreshed, {
    startedMutationRevision: 1,
    currentMutationRevision: 1,
  });

  assert.equal(next.contacts, current.contacts);
  assert.equal(next.requests, current.requests);
});

test('contact refresh adopts newly hydrated public Kordi IDs', () => {
  const current = {
    contacts: [summary({ accountId: 'acct_contact', kordiId: null })],
    requests: [request({
      direction: 'incoming',
      fromAccountId: 'acct_request',
      counterpart: summary({ accountId: 'acct_request', kordiId: null }),
    })],
  };
  const refreshed = {
    contacts: [summary({ accountId: 'acct_contact', kordiId: '482731906' })],
    requests: [request({
      direction: 'incoming',
      fromAccountId: 'acct_request',
      counterpart: summary({ accountId: 'acct_request', kordiId: '284106395' }),
    })],
  };

  const next = applyCloudContactsRefreshSnapshot(current, refreshed, {
    startedMutationRevision: 1,
    currentMutationRevision: 1,
  });

  assert.equal(next.contacts[0]?.kordiId, '482731906');
  assert.equal(next.requests[0]?.counterpart?.kordiId, '284106395');
});

test('a system agent and its owner human remain distinct contacts', () => {
  const human = summary({ accountId: 'acct_support', displayName: 'Support owner' });
  const systemAgent = summary({
    contactId: 'cloud-system:kordi-support',
    contactKind: 'system_agent',
    accountId: 'acct_support',
    displayName: 'Kordi Support',
    targetCloudAgentId: 'cloud_agent_kordi_support',
    locked: true,
    supportTicketEnabled: true,
  });

  const next = applyCloudContactsRefreshSnapshot(
    { contacts: [human], requests: [] },
    { contacts: [systemAgent, human], requests: [] },
    { startedMutationRevision: 1, currentMutationRevision: 1 },
  );

  assert.equal(next.contacts.length, 2);
  assert.deepEqual(next.contacts.map((contact) => contact.contactId ?? contact.accountId), [
    'acct_support',
    'cloud-system:kordi-support',
  ]);
});

test('accepted contact response identifies the peer and hello message for immediate local insert', () => {
  const accepted = request({ status: 'accepted', fromAccountId: 'acct_me', toAccountId: 'acct_peer' });
  const helloMessage = {
    messageId: 'msg_hello',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: 'hello',
    createdAt: '2026-05-12T00:00:00Z',
    deliveredAt: '2026-05-12T00:00:00Z',
    readAt: null,
    direction: 'outgoing' as const,
  };

  assert.equal(acceptedCloudContactPeerAccountId(accepted, 'acct_me'), 'acct_peer');
  assert.equal(acceptedCloudContactPeerAccountId(request({ status: 'accepted', fromAccountId: 'acct_peer', toAccountId: 'acct_me' }), 'acct_me'), 'acct_peer');
  assert.equal(acceptedCloudContactPeerAccountId(request({ status: 'pending' }), 'acct_me'), null);
  assert.deepEqual(cloudContactAcceptedSyncDetail(accepted, 'acct_me', helloMessage), {
    requestId: 'req_1',
    peerAccountId: 'acct_peer',
    message: helloMessage,
  });
});

test('contact.added websocket payload identifies the counterpart for immediate insertion', () => {
  const actorId = cloudContactAddedActorAccountId({ actor_account_id: 'acct_peer', peer_account_id: 'acct_me' }, 'acct_me');
  assert.equal(actorId, 'acct_peer');
  assert.equal(cloudContactAddedActorAccountId({ actor_account_id: 'acct_me', peer_account_id: 'acct_peer' }, 'acct_me'), null);

  const snapshot = mergeCloudContactSummarySnapshot({ contacts: [], requests: [request()] }, summary());
  assert.equal(snapshot.contacts[0]?.accountId, 'acct_peer');
  assert.equal(snapshot.requests.length, 1);
});

test('background cloud contact refreshes do not show loading over existing rows', () => {
  assert.equal(shouldShowCloudContactsLoading({ contacts: [], requests: [], initialLoadSettled: false }), true);
  assert.equal(shouldShowCloudContactsLoading({ contacts: [summary()], requests: [], initialLoadSettled: true }), false);
  assert.equal(shouldShowCloudContactsLoading({ contacts: [], requests: [request()], initialLoadSettled: true }), false);
});

test('an account switch never exposes the previous account contact snapshot', () => {
  const accountASnapshot = {
    contacts: [summary({ accountId: 'acct_a_peer' })],
    requests: [],
    loading: false,
    error: null,
    initialLoadSettled: true,
  };
  const accountBSnapshot = {
    contacts: [summary({ accountId: 'acct_b_peer' })],
    requests: [],
    loading: true,
    error: null,
    initialLoadSettled: false,
  };

  assert.equal(selectCloudContactsSnapshotForAccount(
    { accountId: 'acct_a', snapshot: accountASnapshot },
    'acct_b',
    accountBSnapshot,
  ), accountBSnapshot);
  assert.equal(selectCloudContactsSnapshotForAccount(
    { accountId: 'acct_a', snapshot: accountASnapshot },
    'acct_a',
    accountBSnapshot,
  ), accountASnapshot);
});

test('shouldRefreshCloudContactsForWsSubject refreshes contact request notices and contact changes', () => {
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.contact.request.created.acct_me'), true);
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.contact.request.accepted.acct_me'), true);
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.contact.added.acct_me'), true);
  assert.equal(shouldRefreshCloudContactsForWsSubject('kordi.events.message.arrived.acct_me'), false);
});

test('IdentityAvatar with a real image avoids rendering the generated pixel avatar underneath', () => {
  const markup = renderToStaticMarkup(createElement(IdentityAvatar, {
    kind: 'human',
    seed: 'acct_peer',
    name: 'Peer User',
    imageUrl: 'https://images.test/peer.png',
  }));

  assert.match(markup, /src="https:\/\/images\.test\/peer\.png"/);
  assert.doesNotMatch(markup, /<svg/);
});

test('IdentityAvatar falls back to the signup-style initials avatar when a human image is missing', () => {
  const markup = renderToStaticMarkup(createElement(IdentityAvatar, {
    kind: 'human',
    seed: 'acct_peer',
    name: 'Peer User',
  }));

  assert.match(markup, />PE<\/span>/);
  assert.match(markup, /linear-gradient\(135deg,/);
  assert.doesNotMatch(markup, /<svg/);
});
