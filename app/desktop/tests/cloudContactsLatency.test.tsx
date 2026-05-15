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
