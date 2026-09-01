import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudGroupUnreadCountsBySessionId, encodeCloudGroupControl, shouldCountCloudGroupMessageUnread } from '../src/features/cloud/cloudGroupMessages';

test('cloud group read targeting matches only the exact active session', () => {
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'session:group:child', groupId: 'session:group:child' }), false);
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'group:session:group:child', groupId: 'session:group:child' }), false);
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'session:group:space', groupId: 'session:group:child' }), true);
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationIds: ['ui-row-id', 'group:session:group:space'], groupId: 'session:group:child' }), true);
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'session:group:other', groupId: 'session:group:child' }), true);
});

test('cloud group unread count helper ignores messages at or before local read cursor', () => {
  const readMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg:read',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'Already read but stale cache says unread',
      createdAtMs: 10,
    },
  });
  const unreadMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg:unread',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'New unread after cursor',
      createdAtMs: 11,
    },
  });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    readCursorsBySessionId: {
      'session:group:child': { lastReadMessageId: 'msg:read', lastReadCreatedAtMs: 10 },
    },
    messages: [
      { messageId: 'cloud_read_stale', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: readMessage, createdAt: '2026-05-11T00:00:10Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_unread_new', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: unreadMessage, createdAt: '2026-05-11T00:00:11Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), { 'session:group:child': 1 });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    readCursorsBySessionId: {
      'session:group:child': { lastReadMessageId: 'msg:unread', lastReadCreatedAtMs: 11 },
    },
    messages: [
      { messageId: 'cloud_read_stale', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: readMessage, createdAt: '2026-05-11T00:00:10Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_unread_new', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: unreadMessage, createdAt: '2026-05-11T00:00:11Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), {});
});

test('cloud group unread helper ignores self-authored cached controls even when direction is stale incoming', () => {
  const accountId = 'acct_self';
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:self-cache',
    groupSpaceId: 'session:group:self-cache',
    groupTitle: 'Self cache',
    createdByAccountId: accountId,
    actor: { accountId, displayName: 'Me', avatarUrl: null, role: 'admin' },
    participants: [{ accountId, displayName: 'Me', avatarUrl: null, role: 'admin' }],
    message: {
      id: 'msg_self_group',
      senderAccountId: accountId,
      text: 'hello',
      createdAtMs: 1783440000000,
      senderKind: 'human',
    },
  });

  const unread = cloudGroupUnreadCountsBySessionId({
    accountId,
    messages: [{
      messageId: 'cloud_msg_self_group',
      fromAccountId: accountId,
      toAccountId: accountId,
      body,
      createdAt: '2026-07-07T18:00:00Z',
      deliveredAt: '2026-07-07T18:00:00Z',
      readAt: null,
      direction: 'incoming',
      sessionId: 'session:group:self-cache',
    }],
  });

  assert.deepEqual(unread, {});
});

test('cloud group unread helper counts self-agent replies until the local read cursor advances', () => {
  const accountId = 'acct_self';
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:self-agent',
    groupSpaceId: 'session:group:self-agent',
    groupTitle: 'Agent team',
    createdByAccountId: accountId,
    actor: { accountId, displayName: 'Me', avatarUrl: null, role: 'admin' },
    participants: [{ accountId, displayName: 'Me', avatarUrl: null, role: 'admin' }],
    message: {
      id: 'msg_self_agent_group',
      senderAccountId: accountId,
      senderDisplayName: "Researcher · Me's Agent",
      text: 'Finished the group task',
      createdAtMs: 1783440000000,
      senderKind: 'agent',
    },
  });
  const messages = [{
    messageId: 'cloud_msg_self_agent_group',
    fromAccountId: accountId,
    toAccountId: accountId,
    body,
    createdAt: '2026-07-07T18:00:00Z',
    deliveredAt: '2026-07-07T18:00:00Z',
    readAt: '2026-07-07T18:01:00Z',
    direction: 'outgoing' as const,
    sessionId: 'session:group:self-agent',
  }];

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId,
    messages,
  }), { 'session:group:self-agent': 1 });
  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId,
    readCursorsBySessionId: {
      'session:group:self-agent': {
        lastReadMessageId: 'msg_self_agent_group',
        lastReadCreatedAtMs: 1783440000000,
      },
    },
    messages,
  }), {});
});

test('cloud group unread count helper deduplicates inbound controls without hiding selected unread', () => {
  const groupMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg:one',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'Unread group hello',
      createdAt: '2026-05-11T00:00:00Z',
    },
  });
  const secondGroupMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:other',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg:two',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'Another unread group hello',
      createdAt: '2026-05-11T00:00:01Z',
    },
  });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: groupMessage, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_1_duplicate', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: groupMessage, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_read', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: secondGroupMessage, createdAt: '2026-05-11T00:00:01Z', deliveredAt: null, readAt: '2026-05-11T00:00:02Z', direction: 'incoming' },
      { messageId: 'cloud_outgoing', fromAccountId: 'acct_me', toAccountId: 'acct_peer', body: groupMessage, createdAt: '2026-05-11T00:00:03Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
    ],
  }), { 'session:group:child': 1 });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: groupMessage, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), { 'session:group:child': 1 });
});

test('cloud group unread count helper ignores inherited fork snapshots and counts only new fork messages', () => {
  const forkSnapshotMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:fork:child',
    groupSpaceId: 'session:fork:child',
    groupTitle: 'Fork',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    fork: {
      forkSessionId: 'session:fork:child',
      parentSessionId: 'session:group:parent',
      parentMessageId: 'msg:parent',
      createdAtMs: 1,
    },
    message: {
      id: 'msg:old-snapshot',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'Inherited old message',
      createdAtMs: 1,
      forkSnapshot: true,
    },
  });
  const newForkMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:fork:child',
    groupSpaceId: 'session:fork:child',
    groupTitle: 'Fork',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    fork: {
      forkSessionId: 'session:fork:child',
      parentSessionId: 'session:group:parent',
      parentMessageId: 'msg:parent',
      createdAtMs: 1,
    },
    message: {
      id: 'msg:new-after-fork',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'New message after fork',
      createdAtMs: 2,
    },
  });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    messages: [
      { messageId: 'cloud_snapshot', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: forkSnapshotMessage, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_new', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: newForkMessage, createdAt: '2026-05-11T00:00:01Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), { 'session:fork:child': 1 });
});
