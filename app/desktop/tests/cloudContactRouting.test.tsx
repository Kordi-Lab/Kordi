import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_HOST_SENTINEL,
  cloudContactToContact,
  isCloudContact,
  isPendingIncomingCloudContactRequest,
} from '../src/features/cloud/useCloudContacts';
import { CLOUD_PIXEL_AVATAR_URL_PREFIX } from '../src/features/cloud/avatar';
import type { Contact } from '../src/kordi-app/types';

function localBridgeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'bridge:alice',
    name: 'Alice',
    initials: 'AL',
    classType: 'other-users',
    entityType: 'user',
    subtitle: 'node_alice',
    bridges: ['local'],
    status: 'online',
    discoverableOn: ['local'],
    detail: 'node_alice',
    owner: 'Alice',
    bridgeHostId: 'local-host',
    bridgePeerNodeId: 'node_alice',
    bridgeContactStatus: 'accepted',
    avatarSeed: 'node_alice',
    profileImageUrl: null,
    ...overrides,
  };
}

test('cloud contacts are identified by the cloud host sentinel', () => {
  const cloud = cloudContactToContact({
    accountId: 'acct_peer',
    displayName: 'Cloud Peer',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-05-11T00:00:00Z',
  });

  assert.equal(CLOUD_HOST_SENTINEL, 'cloud');
  assert.equal(isCloudContact(cloud), true);
  assert.equal(isCloudContact(localBridgeContact()), false);
});

test('cloud request badge only counts incoming pending requests', () => {
  assert.equal(isPendingIncomingCloudContactRequest({ direction: 'incoming', status: 'pending' }), true);
  assert.equal(isPendingIncomingCloudContactRequest({ direction: 'incoming', status: 'accepted' }), false);
  assert.equal(isPendingIncomingCloudContactRequest({ direction: 'outgoing', status: 'pending' }), false);
});

test('cloud contacts carry bridge-compatible routing metadata', () => {
  const cloud = cloudContactToContact({
    accountId: 'acct_peer',
    displayName: 'Cloud Peer',
    avatarUrl: `${CLOUD_PIXEL_AVATAR_URL_PREFIX}shared-avatar-seed`,
    nodeId: null,
    createdAt: '2026-05-11T00:00:00Z',
  });

  assert.equal(cloud.bridgeHostId, CLOUD_HOST_SENTINEL);
  assert.equal(cloud.bridgePeerNodeId, 'acct_peer');
  assert.equal(cloud.bridgePeerRuntime, 'person');
  assert.equal(cloud.bridgeContactStatus, 'accepted');
  assert.equal(cloud.avatarSeed, 'shared-avatar-seed');
  assert.equal(cloud.profileImageUrl, null);
  assert.equal(isCloudContact(localBridgeContact()), false);
});
