import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudGroupIdentityRequest, cloudGroupParticipantFromContact, cloudGroupParticipantsWithProfiles, cloudGroupTargetAccountIds, firstCloudGroupSendFailure, fulfilledCloudGroupSends, nonCloudGroupTargets, shouldRouteMentionThroughCloudGroup } from '../src/features/cloud/cloudGroupMessages';
import { CLOUD_HOST_SENTINEL } from '../src/features/cloud/useCloudContacts';

test('cloud group send helpers treat partial recipient success as a send success', () => {
  const results: PromiseSettledResult<string>[] = [
    { status: 'fulfilled', value: 'msg_ok' },
    { status: 'rejected', reason: new Error('not contacts') },
  ];

  assert.deepEqual(fulfilledCloudGroupSends(results), ['msg_ok']);
  assert.equal(firstCloudGroupSendFailure(results) instanceof Error, true);
});

test('cloud agent mentions inside cloud groups stay on cloud group transport', () => {
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'cloud', activeGroupSessionIsGroup: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true }), false);
  assert.equal(shouldRouteMentionThroughCloudGroup({ activeGroupSessionIsGroup: true, hasCloudGroupRecipients: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true, mentionsLocalAgent: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true, mentionsCollaborationAgent: true, hasCloudGroupRecipients: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true, mentionsCollaborationAgent: true, hasCloudGroupRecipients: false }), false);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'cloud', activeGroupSessionIsGroup: false, mentionsLocalAgent: true }), false);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'cloud', activeGroupSessionIsGroup: false, mentionsCollaborationAgent: true, hasCloudGroupRecipients: true }), false);
});

test('cloud group helpers split cloud recipients from bridge recipients', () => {
  const targets = [
    { hostId: CLOUD_HOST_SENTINEL, nodeId: 'acct_b' },
    { hostId: 'local-bridge', nodeId: 'node_c' },
  ];

  assert.deepEqual(cloudGroupTargetAccountIds(targets), ['acct_b']);
  assert.deepEqual(nonCloudGroupTargets(targets), [{ hostId: 'local-bridge', nodeId: 'node_c' }]);
});

test('cloud group profile hydration preserves public Kordi IDs and large stored signup avatar images', () => {
  const avatarUrl = `data:image/png;base64,${'a'.repeat(100_000)}`;
  const participants = cloudGroupParticipantsWithProfiles(
    [{ accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' }],
    [{ accountId: 'acct_peer', kordiId: '123456789', displayName: 'Korditest', avatarUrl }],
  );

  assert.equal(participants[0]?.displayName, 'Korditest');
  assert.equal(participants[0]?.kordiId, '123456789');
  assert.equal(participants[0]?.avatarUrl, avatarUrl);
});

test('cloud group self identity uses the stable cloud account id and uploaded avatar image', () => {
  const request = cloudGroupIdentityRequest(
    {
      accountId: 'acct_self',
      kordiId: '987654321',
      displayName: 'Self',
      avatarUrl: 'data:image/jpeg;base64,self',
      role: 'self',
    },
    {
      accountId: 'acct_self',
      displayName: 'Self',
      primaryEmail: 'self@example.com',
      avatarUrl: 'data:image/jpeg;base64,self',
      nodeId: null,
      passwordSet: true,
    },
    'human:local-profile',
  );

  assert.equal(request.id, 'human:acct_self');
  assert.equal(request.humanId, 'acct_self');
  assert.equal(request.avatarKey, 'acct_self');
  assert.equal((request.metadata as Record<string, unknown>).kordiId, '987654321');
});

test('cloud group contact participant does not synthesize generated avatar urls', () => {
  const participant = cloudGroupParticipantFromContact({
    id: 'cloud:acct_b',
    name: 'Bob',
    initials: 'BO',
    classType: 'other-users',
    entityType: 'user',
    subtitle: '@246813579',
    collaborationSources: [CLOUD_HOST_SENTINEL],
    status: 'online',
    discoverableOn: [CLOUD_HOST_SENTINEL],
    detail: 'acct_b',
    owner: 'Bob',
    sourceHostId: CLOUD_HOST_SENTINEL,
    sourceParticipantId: 'acct_b',
    sourceHumanId: 'acct_b',
    contactStatus: 'accepted',
    avatarSeed: 'bob-seed',
    profileImageUrl: null,
  });

  assert.equal(participant?.avatarUrl, null);
  assert.equal(participant?.kordiId, '246813579');
});
