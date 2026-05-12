import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  applyAcceptedCloudContactRequest,
  mergeCloudContactRequestSnapshot,
  removeCloudContactRequestSnapshot,
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

test('removeCloudContactRequestSnapshot clears accepted request notices before the server round trip finishes', () => {
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
