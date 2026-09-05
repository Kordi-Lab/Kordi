import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudGroupDeliveryStateFromMessages, cloudGroupReadReceiptSummaryFromMessages, cloudGroupControlMessagesForAccount, cloudGroupManualSessionTitleSnapshot, cloudGroupMessageSessionId, cloudGroupSessionTitleSnapshotForControl, cloudGroupPeerIdsFromContactsAndRequests, cloudGroupPeerIdsFromMessages, cloudGroupTitleForOutgoingControl, cloudGroupNonGenericTitle, cloudGroupUniqueParticipants, encodeCloudGroupControl, parseCloudGroupControl, shouldApplyCloudGroupTitleUpdate, cloudSessionTitleUpdateTitle } from '../src/features/cloud/cloudGroupMessages';

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

test('cloud group participant envelopes drop local-only ids, huge data avatars, and legacy pixel avatars', () => {
  assert.deepEqual(cloudGroupUniqueParticipants([
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'data:image/jpeg;base64,'.padEnd(5000, 'x'), role: 'admin' },
    { accountId: 'kh_local_human', displayName: 'Local Human', avatarUrl: null, role: 'self' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: 'kordi-pixel-avatar://cloud-signup:seed', role: 'person' },
  ]), [
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
  ]);
});

test('encoded cloud group controls never transport avatar image values', () => {
  const decoded = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:avatars',
    groupTitle: 'Avatar test',
    createdByAccountId: 'acct_a',
    actor: {
      accountId: 'acct_a',
      displayName: 'Alice',
      avatarUrl: 'https://images.test/alice.jpg',
      role: 'admin',
    },
    participants: [{
      accountId: 'acct_b',
      displayName: 'Bob',
      avatarUrl: 'data:image/jpeg;base64,avatar',
      role: 'person',
    }],
    message: {
      id: 'message',
      senderAccountId: 'acct_a',
      text: 'hello',
      createdAtMs: 1,
    },
  }));

  assert.equal(decoded?.actor.avatarUrl, null);
  assert.deepEqual(decoded?.participants.map((participant) => participant.avatarUrl), [null]);
});

test('group title updates never transport a channel title snapshot', () => {
  const decoded = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-title-update',
    groupId: 'session:group:general',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Renamed group',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [{ accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' }],
    sessionTitle: {
      title: 'stale local channel title',
      titleSource: 'manual',
      titleRevision: 1,
      titlePolicyVersion: 1,
      updatedAtMs: 1,
      updatedByAccountId: 'acct_a',
    },
    message: null,
  }));

  assert.equal(decoded?.groupTitle, 'Renamed group');
  assert.equal(decoded?.sessionTitle, null);
});

test('cloud group participant normalization rejects kh local ids', () => {
  const participants = cloudGroupUniqueParticipants([
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    { accountId: 'kh_local', displayName: 'Localhost', avatarUrl: null, role: 'person' },
    { accountId: 'node_local', displayName: 'Node', avatarUrl: null, role: 'person' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
  ]);

  assert.deepEqual(participants.map((participant) => participant.accountId), ['acct_a', 'acct_b']);
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

test('cloud group delivery status becomes read when any recipient has read the outbound message', () => {
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
  }), 'read');

  assert.equal(cloudGroupDeliveryStateFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_group_1',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_me', toAccountId: 'acct_peer_a', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: '2026-05-11T00:00:02Z', direction: 'outgoing' },
      { messageId: 'cloud_2', fromAccountId: 'acct_me', toAccountId: 'acct_peer_b', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: '2026-05-11T00:00:03Z', direction: 'outgoing' },
    ],
  }), 'read');
});

test('cloudGroupReadReceiptSummaryFromMessages returns only recipients who read the outbound group message', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:test',
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_1',
      text: 'hello',
      senderAccountId: 'acct_me',
      senderDisplayName: 'Me',
      createdAt: '2026-06-06T12:00:00Z',
    },
  });

  const summary = cloudGroupReadReceiptSummaryFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_1',
    messages: [
      {
        messageId: 'copy_1',
        fromAccountId: 'acct_me',
        toAccountId: 'acct_a',
        body,
        createdAt: '2026-06-06T12:00:00Z',
        deliveredAt: '2026-06-06T12:00:01Z',
        readAt: '2026-06-06T12:00:02Z',
        direction: 'outgoing',
      },
      {
        messageId: 'copy_2',
        fromAccountId: 'acct_me',
        toAccountId: 'acct_b',
        body,
        createdAt: '2026-06-06T12:00:00Z',
        deliveredAt: '2026-06-06T12:00:01Z',
        readAt: null,
        direction: 'outgoing',
      },
    ],
  });

  assert.deepEqual(summary, {
    count: 1,
    participants: [{ accountId: 'acct_a', identityId: 'human:acct_a', readAt: '2026-06-06T12:00:02Z' }],
  });
});

test('cloudGroupReadReceiptSummaryFromMessages returns null when no recipients have read', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:test',
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_1',
      text: 'hello',
      senderAccountId: 'acct_me',
      senderDisplayName: 'Me',
      createdAt: '2026-06-06T12:00:00Z',
    },
  });

  const summary = cloudGroupReadReceiptSummaryFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_1',
    messages: [{
      messageId: 'copy_1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_a',
      body,
      createdAt: '2026-06-06T12:00:00Z',
      deliveredAt: '2026-06-06T12:00:01Z',
      readAt: null,
      direction: 'outgoing',
    }],
  });

  assert.equal(summary, null);
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
  assert.equal(shouldApplyCloudGroupTitleUpdate({ kind: 'session-title-update', groupTitle: 'Thread title' }), false);
  assert.equal(shouldApplyCloudGroupTitleUpdate({ kind: 'group-title-update', groupTitle: 'Lalla' }), true);
  assert.equal(cloudSessionTitleUpdateTitle({ kind: 'session-title-update', groupTitle: 'Thread title' }), 'Thread title');
  assert.equal(cloudSessionTitleUpdateTitle({
    kind: 'session-title-update',
    groupTitle: 'Parent group',
    sessionTitle: {
      title: 'Thread title',
      titleSource: 'manual',
      titleRevision: 2,
      titlePolicyVersion: 1,
      updatedAtMs: 1,
      updatedByAccountId: 'acct_admin',
    },
  }), 'Thread title');
  assert.equal(cloudSessionTitleUpdateTitle({ kind: 'group-title-update', groupTitle: 'Lalla' }), null);
});

test('placeholder session titles are not replicated as manual Cloud titles', () => {
  for (const title of ['New chat', '# New chat', 'New session', 'New fork', 'Untitled session', 'Session']) {
    assert.equal(cloudGroupNonGenericTitle(title), null);
    assert.equal(cloudSessionTitleUpdateTitle({ kind: 'session-title-update', groupTitle: title }), null);
    assert.equal(cloudGroupTitleForOutgoingControl({
      kind: 'session-title-update',
      groupTitle: title,
      relatedGroupTitles: ['Previous title'],
    }), null);
  }

  assert.equal(cloudGroupManualSessionTitleSnapshot({
    session: {
      title: 'New chat',
      createdByIdentityId: 'human:acct_creator',
      updatedAtMs: 800,
      metadata: {
        sessionTitleSource: 'manual',
        sessionTitleRevision: 1,
        sessionTitlePolicyVersion: 1,
        sessionTitleUpdatedAtMs: 700,
      },
    },
    identities: [{ id: 'human:acct_creator', humanId: 'acct_creator', sourceIdentityId: null }],
  }), null);
});

test('group controls preserve the administrator-authored manual session title snapshot', () => {
  const sessionTitle = cloudGroupManualSessionTitleSnapshot({
    session: {
      title: 'main',
      createdByIdentityId: 'human:acct_creator',
      updatedAtMs: 800,
      metadata: {
        groupCreatorIdentityId: 'human:acct_creator',
        sessionTitleSource: 'manual',
        sessionTitleRevision: 3,
        sessionTitlePolicyVersion: 1,
        sessionTitleUpdatedAtMs: 700,
      },
    },
    identities: [{ id: 'human:acct_creator', humanId: 'acct_creator', sourceIdentityId: null }],
  });
  assert.deepEqual(sessionTitle, {
    title: 'main',
    titleSource: 'manual',
    titleRevision: 3,
    titlePolicyVersion: 1,
    updatedAtMs: 700,
    updatedByAccountId: 'acct_creator',
  });

  const envelope = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:title-snapshot',
    groupSpaceId: 'session:group:title-snapshot',
    groupTitle: null,
    createdByAccountId: 'acct_creator',
    actor: { accountId: 'acct_member', displayName: 'Member', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_creator', displayName: 'Creator', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_member', displayName: 'Member', avatarUrl: null, role: 'person' },
    ],
    sessionTitle,
    message: { id: 'msg:title-snapshot', senderAccountId: 'acct_member', text: 'hello', createdAtMs: 900 },
  }));

  assert.deepEqual(envelope?.sessionTitle, sessionTitle);
  assert.deepEqual(cloudGroupSessionTitleSnapshotForControl(envelope!, 900), sessionTitle);
});
