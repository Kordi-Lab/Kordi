import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudDesktopCollaborationState, cloudContactsToCanonicalIdentityRequests, cloudGroupParticipantContacts } from '../src/features/cloud/cloudCollaborationState';
import { cloudGroupParticipantsWithProfiles, encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

const peer = cloudContactToContact({
  accountId: 'acct_peer',
  displayName: 'Peer Person',
  avatarUrl: null,
  nodeId: 'node_peer',
  createdAt: '2026-05-11T00:00:00Z',
});

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

test('cloud group participants hydrate missing avatars from account profiles', () => {
  const participants = cloudGroupParticipantsWithProfiles([
    { accountId: 'acct_79', displayName: 'Álvaro Núñez', avatarUrl: null, role: 'person' },
  ], [
    { accountId: 'acct_79', displayName: 'Álvaro Núñez', avatarUrl: 'https://lh3.googleusercontent.com/a/google-avatar=s96-c' },
  ]);

  assert.deepEqual(participants, [
    { accountId: 'acct_79', displayName: 'Álvaro Núñez', avatarUrl: 'https://lh3.googleusercontent.com/a/google-avatar=s96-c', role: 'person' },
  ]);
});

test('cloud group participant contacts include non-contact group members for mentions and sending', () => {
  const canonicalSessionState = {
    sessions: [{ id: 'session:group:1', kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 }],
    identities: [
      { id: 'human:acct_me', kind: 'human', displayName: 'Me Cloud', source: 'local', humanId: 'acct_me', avatarKey: 'seed-me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:acct_member', kind: 'human', displayName: 'Group Member', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_member', humanId: 'acct_member', avatarKey: 'seed-member', profileImageUrl: null, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [
      { sessionId: 'session:group:1', identityId: 'human:acct_me', role: 'self', state: 'active', addedAtMs: 1 },
      { sessionId: 'session:group:1', identityId: 'human:acct_member', role: 'person', state: 'active', addedAtMs: 1 },
    ],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const contacts = cloudGroupParticipantContacts({
    account,
    canonicalSessionState,
    existingPeerIds: [],
  });

  assert.deepEqual(contacts.map((contact) => ({
    id: contact.id,
    name: contact.name,
    sourceHostId: contact.sourceHostId,
    sourceParticipantId: contact.sourceParticipantId,
    contactStatus: contact.contactStatus,
    avatarSeed: contact.avatarSeed,
  })), [{
    id: 'cloud:acct_member',
    name: 'Group Member',
    sourceHostId: 'cloud',
    sourceParticipantId: 'acct_member',
    contactStatus: 'group-member',
    avatarSeed: 'seed-member',
  }]);
});

test('cloud group members do not become direct contacts or direct chat peers', () => {
  const groupMemberContact = {
    ...cloudContactToContact({
      accountId: 'acct_member',
      displayName: 'Group Member',
      avatarUrl: null,
      nodeId: 'acct_member',
      createdAt: '2026-05-11T00:00:00Z',
    }),
    contactStatus: 'group-member',
  };
  const body = encodeCloudGroupControl({
    kind: 'group-update',
    groupId: 'session:group:one',
    groupSpaceId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' },
      { accountId: 'acct_member', displayName: 'Group Member', avatarUrl: null, role: 'person' },
    ],
    message: null,
  });
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer, groupMemberContact],
    messagesByPeer: {
      acct_peer: [message],
      acct_member: [{
        messageId: 'msg_group_control',
        fromAccountId: 'acct_member',
        toAccountId: 'acct_me',
        body,
        createdAt: '2026-05-11T10:00:00Z',
        deliveredAt: null,
        readAt: null,
        direction: 'incoming',
      }],
    },
  });

  assert.equal(state.hosts[0]?.visiblePeers.some((visiblePeer) => visiblePeer.humanId === 'acct_member'), false);
  assert.equal(state.conversations.some((conversation) => conversation.peerNodeId === 'acct_member'), false);
  assert.equal(state.conversations.some((conversation) => conversation.peerNodeId === 'acct_peer'), true);
});

test('cloud contact identity requests preserve account ids, display names, and uploaded avatar images', () => {
  const requests = cloudContactsToCanonicalIdentityRequests({
    account: {
      ...account,
      avatarUrl: 'data:image/jpeg;base64,me',
    },
    contacts: [cloudContactToContact({
      accountId: 'acct_peer',
      displayName: 'Peer Person',
      avatarUrl: 'data:image/jpeg;base64,peer',
      nodeId: 'node_peer',
      createdAt: '2026-05-11T00:00:00Z',
    })],
    localHumanIdentityId: 'human:local',
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => ({
    id: request.id,
    displayName: request.displayName,
    source: request.source,
    sourceHostId: request.sourceHostId,
    sourceIdentityId: request.sourceIdentityId,
    humanId: request.humanId,
    avatarKey: request.avatarKey,
    profileImageUrl: request.profileImageUrl,
  })), [
    {
      id: 'human:acct_me',
      displayName: 'Me Cloud',
      source: 'local',
      sourceHostId: null,
      sourceIdentityId: null,
      humanId: 'acct_me',
      avatarKey: 'acct_me',
      profileImageUrl: 'data:image/jpeg;base64,me',
    },
    {
      id: 'human:acct_peer',
      displayName: 'Peer Person',
      source: 'cloud',
      sourceHostId: 'cloud',
      sourceIdentityId: 'acct_peer',
      humanId: 'acct_peer',
      avatarKey: 'acct_peer',
      profileImageUrl: 'data:image/jpeg;base64,peer',
    },
  ]);
});
