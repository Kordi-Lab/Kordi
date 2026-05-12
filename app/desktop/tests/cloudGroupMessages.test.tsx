import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_PIXEL_AVATAR_URL_PREFIX } from '../src/features/cloud/avatar';
import {
  cloudGroupIdentityRequest,
  cloudGroupAgentResponseTargetAccountIds,
  cloudGroupDeliveryStateFromMessages,
  cloudGroupControlMessagesForAccount,
  cloudGroupLocalAgentRequestAlreadyHandled,
  cloudGroupMessageReadPeerIds,
  cloudGroupMessageSessionId,
  cloudGroupPeerIdsFromContactsAndRequests,
  cloudGroupPeerIdsFromMessages,
  cloudGroupParticipantFromContact,
  cloudGroupRelatedControlsForSend,
  cloudGroupTargetAccountIds,
  cloudGroupTitleForOutgoingControl,
  cloudGroupUniqueParticipants,
  encodeCloudGroupControl,
  firstCloudGroupSendFailure,
  fulfilledCloudGroupSends,
  nonCloudGroupTargets,
  parseCloudGroupControl,
  shouldApplyCloudGroupTitleUpdate,
  shouldCountCloudGroupMessageUnread,
  shouldRouteMentionThroughCloudGroup,
} from '../src/features/cloud/cloudGroupMessages';
import { CLOUD_HOST_SENTINEL } from '../src/features/cloud/useCloudContacts';

test('cloud group control envelopes round trip and stay identifiable', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: `${CLOUD_PIXEL_AVATAR_URL_PREFIX}bob-seed`, role: 'person' },
    ],
    message: {
      id: 'msg_1',
      senderAccountId: 'acct_a',
      text: 'hello group',
      createdAtMs: 123,
      senderKind: 'agent',
      senderDisplayName: 'Agent',
      deliveryState: 'processing',
      replyToMessageId: 'msg_request',
      requestId: 'msg_request',
    },
  });

  const parsed = parseCloudGroupControl(body);
  assert.equal(parsed?.kind, 'group-message');
  assert.equal(parsed?.groupId, 'session:group:one');
  assert.equal(parsed?.participants[1]?.avatarUrl, `${CLOUD_PIXEL_AVATAR_URL_PREFIX}bob-seed`);
  assert.equal(parsed?.message?.text, 'hello group');
  assert.equal(parsed?.message?.senderKind, 'agent');
  assert.equal(parsed?.message?.senderDisplayName, 'Agent');
  assert.equal(parsed?.message?.deliveryState, 'processing');
  assert.equal(parsed?.message?.replyToMessageId, 'msg_request');
  assert.equal(parsed?.message?.requestId, 'msg_request');
});

test('cloud group related controls match continuations by shared group space id', () => {
  const rootEnvelope = {
    kind: 'group-invite' as const,
    groupId: 'session:group:root',
    groupSpaceId: 'session:group:root',
    groupTitle: '1111',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'https://images.test/alice.png', role: 'admin' as const },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'https://images.test/alice.png', role: 'admin' as const },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: 'https://images.test/bob.png', role: 'person' as const },
    ],
    message: null,
  };

  const related = cloudGroupRelatedControlsForSend([
    { envelope: rootEnvelope, createdAtMs: 1 },
  ], { groupId: 'session:group:child', groupSpaceId: 'session:group:root' });

  assert.equal(related.length, 1);
  assert.equal(related[0]?.envelope.groupTitle, '1111');
  assert.equal(related[0]?.envelope.participants[1]?.avatarUrl, 'https://images.test/bob.png');
});

test('cloud group participant merge preserves later real avatar urls', () => {
  assert.deepEqual(cloudGroupUniqueParticipants([
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'https://images.test/a.png', role: 'person' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: 'https://images.test/b.png', role: 'person' },
  ]), [
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'https://images.test/a.png', role: 'person' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: 'https://images.test/b.png', role: 'person' },
  ]);
});

test('cloud group messages carry concrete session id separately from shared group space id', () => {
  assert.equal(cloudGroupMessageSessionId({
    activeConvCanonicalSessionId: 'session:group:child-session',
    activeGroupSessionSpaceId: 'session:group:original-space',
  }), 'session:group:child-session');

  const parsed = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child-session',
    groupSpaceId: 'session:group:original-space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [{ accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' }],
    message: { id: 'msg_1', senderAccountId: 'acct_a', text: 'hello child', createdAtMs: 123 },
  }));

  assert.equal(parsed?.groupId, 'session:group:child-session');
  assert.equal(parsed?.groupSpaceId, 'session:group:original-space');
});

test('cloud group delivery status follows hidden pairwise cloud read receipts', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_group_1', senderAccountId: 'acct_me', text: 'hello', createdAtMs: 1 },
  });

  assert.equal(cloudGroupDeliveryStateFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_group_1',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_me', toAccountId: 'acct_peer_a', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: null, direction: 'outgoing' },
      { messageId: 'cloud_2', fromAccountId: 'acct_me', toAccountId: 'acct_peer_b', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: '2026-05-11T00:00:02Z', direction: 'outgoing' },
    ],
  }), 'delivered');

  assert.equal(cloudGroupDeliveryStateFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_group_1',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_me', toAccountId: 'acct_peer_a', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: '2026-05-11T00:00:02Z', direction: 'outgoing' },
      { messageId: 'cloud_2', fromAccountId: 'acct_me', toAccountId: 'acct_peer_b', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: '2026-05-11T00:00:03Z', direction: 'outgoing' },
    ],
  }), 'read');
});

test('cloud group peer discovery expands beyond direct contacts from existing controls', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-invite',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_b',
    actor: { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
      { accountId: 'acct_c', displayName: 'Carol', avatarUrl: null, role: 'person' },
    ],
  });

  assert.deepEqual(cloudGroupPeerIdsFromMessages({
    accountId: 'acct_me',
    contactPeerIds: ['acct_b'],
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_b', toAccountId: 'acct_me', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), ['acct_b', 'acct_c']);
});

test('cloud group peer discovery can bootstrap from contact request counterparts', () => {
  assert.deepEqual(cloudGroupPeerIdsFromContactsAndRequests({
    accountId: 'acct_me',
    contactPeerIds: ['acct_b'],
    contacts: [{ accountId: 'acct_c' }],
    requests: [{ requesterNodeId: 'acct_d', targetNodeId: 'acct_me' }],
  }), ['acct_b', 'acct_c', 'acct_d']);
});

test('cloud group replay includes self-authored controls after local reset', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:self-authored',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: { id: 'msg:ui:self', senderAccountId: 'acct_me', text: 'hello from me', createdAtMs: 1 },
  });

  const replay = cloudGroupControlMessagesForAccount({
    accountId: 'acct_me',
    messages: [
      { messageId: 'cloud_self', fromAccountId: 'acct_me', toAccountId: 'acct_peer', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
    ],
  });

  assert.deepEqual(replay.map((message) => message.messageId), ['cloud_self']);
});

test('cloud group messages do not inherit stale group titles from earlier rename controls', () => {
  assert.equal(cloudGroupTitleForOutgoingControl({
    kind: 'group-message',
    groupTitle: null,
    relatedGroupTitles: ['Lalla'],
  }), null);
  assert.equal(cloudGroupTitleForOutgoingControl({
    kind: 'group-title-update',
    groupTitle: 'Lalla',
    relatedGroupTitles: [],
  }), 'Lalla');
});

test('only explicit group title update controls mutate the shared group name', () => {
  assert.equal(shouldApplyCloudGroupTitleUpdate({ kind: 'group-message', groupTitle: 'Stale name' }), false);
  assert.equal(shouldApplyCloudGroupTitleUpdate({ kind: 'group-title-update', groupTitle: 'Lalla' }), true);
});

test('cloud group local agent requests are considered handled after a synced processing or final response', () => {
  const requestId = 'msg_request';
  const responseBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_response',
      senderAccountId: 'acct_a',
      text: 'done',
      createdAtMs: 200,
      senderKind: 'agent',
      deliveryState: 'complete',
      requestId,
      replyToMessageId: requestId,
    },
  });

  assert.equal(cloudGroupLocalAgentRequestAlreadyHandled({
    localAccountId: 'acct_a',
    requestMessageId: requestId,
    messages: [{
      messageId: 'cloud_response',
      fromAccountId: 'acct_a',
      toAccountId: 'acct_b',
      body: responseBody,
      createdAt: new Date(200).toISOString(),
      deliveredAt: null,
      readAt: null,
      direction: 'outgoing',
    }],
  }), true);
});

test('cloud group replay deduplicates fanout rows for the same canonical message', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:fanout',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_a', displayName: 'A', avatarUrl: null, role: 'person' },
      { accountId: 'acct_b', displayName: 'B', avatarUrl: null, role: 'person' },
    ],
    message: { id: 'msg:ui:fanout', senderAccountId: 'acct_me', text: 'hello both', createdAtMs: 1 },
  });

  const replay = cloudGroupControlMessagesForAccount({
    accountId: 'acct_me',
    messages: [
      { messageId: 'cloud_to_a', fromAccountId: 'acct_me', toAccountId: 'acct_a', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
      { messageId: 'cloud_to_b', fromAccountId: 'acct_me', toAccountId: 'acct_b', body, createdAt: '2026-05-11T00:00:01Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
    ],
  });

  assert.deepEqual(replay.map((message) => message.messageId), ['cloud_to_a']);
});

test('cloud group agent response targets include original sender even when participant snapshot is incomplete', () => {
  const envelope = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_requester',
    actor: { accountId: 'acct_requester', displayName: 'Requester', avatarUrl: null, role: 'person' },
    // Regression: older/incomplete controls may only carry the owner in participants.
    participants: [{ accountId: 'acct_owner', displayName: 'Owner', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_request', senderAccountId: 'acct_requester', text: '@OwnersKordi help', createdAtMs: 1 },
  }));

  assert.ok(envelope);
  assert.deepEqual(cloudGroupAgentResponseTargetAccountIds({
    localAccountId: 'acct_owner',
    envelope,
    requestCloudMessage: { fromAccountId: 'acct_requester', toAccountId: 'acct_owner' },
  }), ['acct_requester']);
});

test('cloud group read helper marks inbound controls read when their group session is open', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_group_1', senderAccountId: 'acct_peer', text: 'hello', createdAtMs: 1 },
  });

  assert.deepEqual(cloudGroupMessageReadPeerIds({
    accountId: 'acct_me',
    activeConversationId: 'session:group:child',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), ['acct_peer']);
});

test('cloud group unread helper counts only hidden sessions', () => {
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'session:group:child', groupId: 'session:group:child', groupSpaceId: 'session:group:space' }), false);
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'session:group:space', groupId: 'session:group:child', groupSpaceId: 'session:group:space' }), false);
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'session:group:other', groupId: 'session:group:child', groupSpaceId: 'session:group:space' }), true);
});

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
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true, mentionsLocalAgent: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true, mentionsBridgeAgent: true, hasCloudGroupRecipients: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true, mentionsBridgeAgent: true, hasCloudGroupRecipients: false }), false);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'cloud', activeGroupSessionIsGroup: false, mentionsLocalAgent: true }), false);
});

test('cloud group helpers split cloud recipients from bridge recipients', () => {
  const targets = [
    { hostId: CLOUD_HOST_SENTINEL, nodeId: 'acct_b' },
    { hostId: 'local-bridge', nodeId: 'node_c' },
  ];

  assert.deepEqual(cloudGroupTargetAccountIds(targets), ['acct_b']);
  assert.deepEqual(nonCloudGroupTargets(targets), [{ hostId: 'local-bridge', nodeId: 'node_c' }]);
});

test('cloud group self identity uses the stable cloud account id and avatar seed', () => {
  const request = cloudGroupIdentityRequest(
    {
      accountId: 'acct_self',
      displayName: 'Self',
      avatarUrl: `${CLOUD_PIXEL_AVATAR_URL_PREFIX}self-seed`,
      role: 'self',
    },
    {
      accountId: 'acct_self',
      displayName: 'Self',
      primaryEmail: 'self@example.com',
      avatarUrl: `${CLOUD_PIXEL_AVATAR_URL_PREFIX}self-seed`,
      nodeId: null,
      passwordSet: true,
    },
    'human:local-profile',
  );

  assert.equal(request.id, 'human:local-profile');
  assert.equal(request.humanId, 'acct_self');
  assert.equal(request.avatarKey, 'self-seed');
});

test('cloud group contact participant preserves generated cloud avatar seed as a syncable avatar url', () => {
  const participant = cloudGroupParticipantFromContact({
    id: 'cloud:acct_b',
    name: 'Bob',
    initials: 'BO',
    classType: 'other-users',
    entityType: 'user',
    subtitle: 'acct_b',
    bridges: [CLOUD_HOST_SENTINEL],
    status: 'online',
    discoverableOn: [CLOUD_HOST_SENTINEL],
    detail: 'acct_b',
    owner: 'Bob',
    bridgeHostId: CLOUD_HOST_SENTINEL,
    bridgePeerNodeId: 'acct_b',
    bridgeHumanId: 'acct_b',
    bridgeContactStatus: 'accepted',
    avatarSeed: 'bob-seed',
    profileImageUrl: null,
  });

  assert.equal(participant?.avatarUrl, `${CLOUD_PIXEL_AVATAR_URL_PREFIX}bob-seed`);
});
