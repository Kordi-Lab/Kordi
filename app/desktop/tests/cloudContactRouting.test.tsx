import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_HOST_SENTINEL,
  cloudContactToContact,
  isCloudContact,
  isPendingIncomingCloudContactRequest,
} from '../src/features/cloud/useCloudContacts';
import type { Contact } from '../src/kordi-app/types';
import { KORDI_SUPPORT_AVATAR_URL } from '../src/features/support/supportIdentity';
import { cloudContactToAgentPeer } from '../src/features/cloud/cloudContactPeers';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

function localBridgeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'bridge:alice',
    name: 'Alice',
    initials: 'AL',
    classType: 'other-users',
    entityType: 'user',
    subtitle: 'node_alice',
    collaborationSources: ['local'],
    status: 'online',
    discoverableOn: ['local'],
    detail: 'node_alice',
    owner: 'Alice',
    sourceHostId: 'local-host',
    sourceParticipantId: 'node_alice',
    contactStatus: 'accepted',
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
    avatarUrl: 'data:image/jpeg;base64,shared',
    nodeId: null,
    createdAt: '2026-05-11T00:00:00Z',
  });

  assert.equal(cloud.sourceHostId, CLOUD_HOST_SENTINEL);
  assert.equal(cloud.sourceParticipantId, 'acct_peer');
  assert.equal(cloud.sourceRuntime, 'person');
  assert.equal(cloud.contactStatus, 'accepted');
  assert.equal(cloud.avatarSeed, 'acct_peer');
  assert.equal(cloud.profileImageUrl, 'data:image/jpeg;base64,shared');
  assert.equal(isCloudContact(localBridgeContact()), false);
});

test('remote default agent presentation comes from the owner Cloud profile', () => {
  const cloud = cloudContactToContact({
    accountId: 'acct_peer',
    displayName: 'Cloud Peer',
    avatarUrl: null,
    defaultAgent: {
      agentId: 'cloud-agent:acct_peer',
      displayName: 'BabyTREE',
      avatarUrl: 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef',
      avatar: {
        ...cloudAccountAvatarFixture,
        entityType: 'agent',
        entityId: 'cloud-agent:acct_peer',
        style: 'thumbs',
        seed: 'baby-tree',
      },
    },
    nodeId: null,
    createdAt: '2026-08-29T00:00:00Z',
  });
  const agent = cloudContactToAgentPeer(cloud);

  assert.equal(agent.agentId, 'cloud-agent:acct_peer');
  assert.equal(agent.displayName, 'BabyTREE');
  assert.equal(agent.profileImageUrl, 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef');
  assert.equal(agent.avatarSeed, 'baby-tree');
});

test('the built-in support contact maps to one locked hosted-agent identity', () => {
  const support = cloudContactToContact({
    contactId: 'cloud-system:kordi-support',
    contactKind: 'system_agent',
    accountId: 'acct_kordi_support',
    displayName: 'Kordi Support',
    subtitle: 'Ask questions or suggest improvements',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-08-04T00:00:00Z',
    locked: true,
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_kordi_support',
    targetCloudAgentOwnerName: 'Kordi',
    supportTicketEnabled: true,
  });

  assert.equal(support.id, 'cloud-contact:cloud-system:kordi-support');
  assert.equal(support.classType, 'other-users');
  assert.equal(support.entityType, 'user');
  assert.equal(support.sourceRuntime, 'kordi-desktop');
  assert.equal(support.sourceAgentId, 'cloud_agent_kordi_support');
  assert.equal(support.sourceParticipantId, 'acct_kordi_support');
  assert.equal(support.systemContact, true);
  assert.equal(support.locked, true);
  assert.equal(support.supportTicketEnabled, true);
  assert.equal(support.profileImageUrl, KORDI_SUPPORT_AVATAR_URL);
});
