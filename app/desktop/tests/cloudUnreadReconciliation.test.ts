import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CanonicalSessionState,
} from '../src/kordi-app/types';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { carryDerivedCloudUnreadCounts } from '../src/features/canonical/derivedCloudUnread';
import {
  cloudOptimisticallyReadSessionIds,
  cloudUnreadCountsBySessionId,
  mergeNativeCloudUnreadCounts,
  patchCanonicalCloudUnreadCounts,
} from '../src/features/cloud/cloudUnreadReconciliation';
import { compactNativeCloudMessagesByPeer } from '../src/features/cloud/useCloudCollaborationMessageStore';

function stateWithUnread(
  cloudUnreadCount?: number,
): CanonicalSessionState {
  return {
    sessions: [{
      id: 'session:one',
      kind: 'group',
      title: 'One',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 1,
      metadata:
        cloudUnreadCount === undefined
          ? { stable: true }
          : { stable: true, cloudUnreadCount },
    }],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp',
      humanIdentityId: 'human:me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;
}

test('unread reconciliation preserves state identity when unchanged', () => {
  const state = stateWithUnread(3);
  assert.equal(
    patchCanonicalCloudUnreadCounts(
      state,
      { 'session:one': 3 },
    ),
    state,
  );
});

test('unread reconciliation updates and clears only Cloud unread metadata', () => {
  const state = stateWithUnread();
  const unread = patchCanonicalCloudUnreadCounts(
    state,
    { 'session:one': 4 },
  );
  assert.deepEqual(
    unread?.sessions[0]?.metadata,
    { stable: true, cloudUnreadCount: 4 },
  );

  const cleared = patchCanonicalCloudUnreadCounts(unread, {});
  assert.deepEqual(
    cleared?.sessions[0]?.metadata,
    { stable: true, cloudUnreadCount: 0 },
  );
  const neverUnread = stateWithUnread();
  assert.equal(patchCanonicalCloudUnreadCounts(neverUnread, {}), neverUnread);
});

test('a catalog reload or replay result keeps the published unread count until reconciliation changes it', () => {
  const published = patchCanonicalCloudUnreadCounts(stateWithUnread(), { 'session:one': 4 })!;
  const reloaded = stateWithUnread();
  const carried = carryDerivedCloudUnreadCounts(published, reloaded);
  assert.deepEqual(carried?.sessions[0]?.metadata, { stable: true, cloudUnreadCount: 4 });
  // Nothing to restore: the same object comes back.
  const unchanged = stateWithUnread(4);
  assert.equal(carryDerivedCloudUnreadCounts(published, unchanged), unchanged);
  // Reconciliation clears with an explicit zero, which the carry respects.
  const read = patchCanonicalCloudUnreadCounts(published, {})!;
  assert.deepEqual(carryDerivedCloudUnreadCounts(published, read)?.sessions[0]?.metadata, { stable: true, cloudUnreadCount: 0 });
  // A session the newer catalog dropped stays dropped.
  assert.deepEqual(carryDerivedCloudUnreadCounts(published, { ...reloaded, sessions: [] })?.sessions, []);
});

test('unread reconciliation uses full history instead of the bounded renderer projection', () => {
  const accountId = 'acct_me';
  const peerId = 'acct_peer';
  const directSessionId = 'session:direct-person:acct_me:acct_peer';
  const direct = Array.from({ length: 100 }, (_, index): CloudMessage => ({
    messageId: `direct-${index}`,
    fromAccountId: peerId,
    toAccountId: accountId,
    body: `Direct ${index}`,
    createdAt: new Date(index * 1_000).toISOString(),
    deliveredAt: new Date(index * 1_000).toISOString(),
    readAt: null,
    direction: 'incoming',
    sessionId: directSessionId,
  }));
  const groups = Array.from({ length: 10 }, (_, sessionIndex) => (
    Array.from({ length: 10 }, (_, messageIndex): CloudMessage => {
      const sessionId = `session:group:${sessionIndex}`;
      const createdAtMs = 100_000 + sessionIndex * 10 + messageIndex;
      return {
        messageId: `group-wire-${sessionIndex}-${messageIndex}`,
        fromAccountId: peerId,
        toAccountId: accountId,
        body: encodeCloudGroupControl({
          kind: 'group-message',
          groupId: sessionId,
          groupSpaceId: sessionId,
          groupTitle: `Group ${sessionIndex}`,
          createdByAccountId: peerId,
          actor: {
            accountId: peerId,
            displayName: 'Peer',
            avatarUrl: null,
            role: 'person',
          },
          participants: [
            { accountId, displayName: 'Me', avatarUrl: null, role: 'admin' },
            { accountId: peerId, displayName: 'Peer', avatarUrl: null, role: 'person' },
          ],
          message: {
            id: `group-${sessionIndex}-${messageIndex}`,
            senderAccountId: peerId,
            senderDisplayName: 'Peer',
            senderKind: 'human',
            text: `Group ${messageIndex}`,
            createdAtMs,
          },
        }),
        createdAt: new Date(createdAtMs).toISOString(),
        deliveredAt: new Date(createdAtMs).toISOString(),
        readAt: null,
        direction: 'incoming',
        sessionId,
      };
    })
  )).flat();
  const full = { [peerId]: [...direct, ...groups] };
  const compacted = compactNativeCloudMessagesByPeer(full);
  const fullUnread = cloudUnreadCountsBySessionId({
    accountId,
    messagesByPeer: full,
  });
  const compactedUnread = cloudUnreadCountsBySessionId({
    accountId,
    messagesByPeer: compacted,
  });

  assert.equal(fullUnread[directSessionId], 100);
  assert.equal(
    Object.entries(fullUnread)
      .filter(([sessionId]) => sessionId.startsWith('session:group:'))
      .reduce((sum, [, count]) => sum + count, 0),
    100,
  );
  assert.ok(
    Object.values(compactedUnread).reduce((sum, count) => sum + count, 0)
      < Object.values(fullUnread).reduce((sum, count) => sum + count, 0),
  );
});

test('reliable group cursors override stale optimistic read timestamps', () => {
  const sessionId = 'session:group:reliable';
  const message: CloudMessage = {
    messageId: 'group-wire-reliable',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId: sessionId,
      groupSpaceId: sessionId,
      groupTitle: 'Reliable',
      createdByAccountId: 'acct_peer',
      actor: {
        accountId: 'acct_peer',
        displayName: 'Peer',
        avatarUrl: null,
        role: 'person',
      },
      participants: [
        { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
        { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
      ],
      message: {
        id: 'group-reliable',
        senderAccountId: 'acct_peer',
        senderDisplayName: 'Peer',
        senderKind: 'human',
        text: 'Still unread on the server',
        createdAtMs: 1_000,
      },
    }),
    createdAt: new Date(1_000).toISOString(),
    deliveredAt: new Date(1_000).toISOString(),
    readAt: new Date(2_000).toISOString(),
    direction: 'incoming',
    sessionId,
    conversationId: 'conversation-reliable',
    conversationSequence: 1,
  };

  assert.deepEqual(cloudUnreadCountsBySessionId({
    accountId: 'acct_me',
    messagesByPeer: { acct_peer: [message] },
  }), { [sessionId]: 1 });
  assert.deepEqual(cloudUnreadCountsBySessionId({
    accountId: 'acct_me',
    messagesByPeer: { acct_peer: [message] },
    readInboundMessageIdsByPeer: {
      acct_peer: new Set([message.messageId]),
    },
  }), {});
  assert.deepEqual(cloudUnreadCountsBySessionId({
    accountId: 'acct_me',
    messagesByPeer: { acct_peer: [message] },
    readCursorsBySessionId: {
      [sessionId]: {
        lastReadMessageId: 'group-reliable',
        lastReadCreatedAtMs: 1_000,
      },
    },
  }), {});
});

test('switching sessions keeps the previous optimistic read hidden without clearing the selected unread', () => {
  const firstSessionId = 'session:direct-person:acct_me:acct_first';
  const secondSessionId = 'session:direct-person:acct_me:acct_second';
  const firstMessage: CloudMessage = {
    messageId: 'first-message',
    fromAccountId: 'acct_first',
    toAccountId: 'acct_me',
    body: 'First',
    createdAt: new Date(1_000).toISOString(),
    deliveredAt: new Date(1_000).toISOString(),
    readAt: null,
    direction: 'incoming',
    sessionId: firstSessionId,
  };
  const optimisticSessionIds = cloudOptimisticallyReadSessionIds({
    messagesByPeer: { acct_first: [firstMessage] },
    readInboundMessageIdsByPeer: { acct_first: new Set([firstMessage.messageId]) },
  });

  const counts = mergeNativeCloudUnreadCounts({
    nativeHeadsBySessionId: {
      [firstSessionId]: { lastReadSequence: 4, unreadCount: 1 },
      [secondSessionId]: { lastReadSequence: 7, unreadCount: 1 },
    },
    optimisticSessionIds,
    projectedUnreadBySessionId: {},
  });

  assert.deepEqual(counts, { [firstSessionId]: 0, [secondSessionId]: 1 });
  assert.equal(mergeNativeCloudUnreadCounts({
    nativeHeadsBySessionId: {
      [firstSessionId]: { lastReadSequence: 4, unreadCount: 1 },
      [secondSessionId]: { lastReadSequence: 7, unreadCount: 1 },
    },
    optimisticSessionIds,
    projectedUnreadBySessionId: { [firstSessionId]: 1 },
  })[firstSessionId], 1);

  assert.equal(mergeNativeCloudUnreadCounts({
    nativeHeadsBySessionId: {
      [firstSessionId]: { lastReadSequence: 4, unreadCount: 2 },
    },
    optimisticSessionIds: new Set(),
    projectedUnreadBySessionId: { [firstSessionId]: 1 },
  })[firstSessionId], 2);

  assert.equal(mergeNativeCloudUnreadCounts({
    nativeHeadsBySessionId: {
      [firstSessionId]: { lastReadSequence: 5, unreadCount: 0 },
    },
    optimisticSessionIds: new Set(),
    projectedUnreadBySessionId: { [firstSessionId]: 1 },
  })[firstSessionId], 0);

  assert.equal(mergeNativeCloudUnreadCounts({
    nativeHeadsBySessionId: {
      [firstSessionId]: { lastReadSequence: 4, unreadCount: 1 },
    },
    locallyReadSessionIds: new Set([firstSessionId]),
    optimisticSessionIds: new Set(),
    projectedUnreadBySessionId: {},
  })[firstSessionId], 0);

  assert.equal(mergeNativeCloudUnreadCounts({
    nativeHeadsBySessionId: {
      [firstSessionId]: { lastReadSequence: 4, unreadCount: 1 },
    },
    locallyReadSessionIds: new Set([firstSessionId]),
    optimisticSessionIds: new Set(),
    projectedUnreadBySessionId: { [firstSessionId]: 1 },
  })[firstSessionId], 1);
});

test('discussion replies are left to their thread read cursor', () => {
  const sessionId = 'session:group:discussion';
  const groupMessage = (id: string, extra: Record<string, unknown> = {}): CloudMessage => ({
    messageId: `wire-${id}`,
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId: sessionId,
      groupSpaceId: sessionId,
      groupTitle: 'Discussion',
      createdByAccountId: 'acct_peer',
      actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
      participants: [
        { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
        { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
      ],
      message: {
        id, senderAccountId: 'acct_peer', senderDisplayName: 'Peer', senderKind: 'human',
        text: id, createdAtMs: 1_000, ...extra,
      } as never,
    }),
    createdAt: new Date(1_000).toISOString(),
    deliveredAt: new Date(1_000).toISOString(),
    readAt: null,
    direction: 'incoming',
    sessionId,
  });
  const thread = {
    schemaVersion: 1, kind: 'thread',
    source: { sourceSessionId: sessionId, sourceMessageId: 'root', senderLabel: 'Peer' },
  };
  assert.deepEqual(cloudUnreadCountsBySessionId({
    accountId: 'acct_me',
    messagesByPeer: { acct_peer: [groupMessage('root'), groupMessage('reply', { messageAction: thread })] },
  }), { [sessionId]: 1 });
});
