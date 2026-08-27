// These fixtures cover Local Edition desktop Bridge read-model compatibility.
// Hosted collaboration must not use these legacy source transports.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import type { Message } from '../src/kordi-app/types';

test('canonical group unread honors persisted self read marker at latest message', () => {
  const sessionId = 'session:group:read-room';
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'cloud', sourceHostId: 'cloud', sourceIdentityId: 'acct_bob', humanId: 'acct_bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'main',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { cloudUnreadCount: 7, groupId: 'group:read-room' },
      createdAtMs: 1,
      updatedAtMs: 3,
      lastMessageAtMs: 3,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1, lastSeenAtMs: 3, lastReadMessageId: 'msg:latest' },
      { sessionId, identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:first', sessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'old', content: { sender: 'Bob', timeLabel: '13:10' }, status: 'sent', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-group:1' },
      { id: 'msg:latest', sessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'latest', content: { sender: 'Bob', timeLabel: '13:11' }, status: 'sent', sequenceNum: 2, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-group:2' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  const conversation = readModel.buildChatConversations([], (messages, fallback) => messages.at(-1)?.text ?? fallback ?? '')[0];
  assert.equal(conversation?.unread, 0);
  assert.equal(conversation?.canonicalCreatedAtMs, 1);
});

test('canonical Cloud unread and legacy group titles remain masked until the account snapshot is ready', () => {
  const sessionId = 'session:group:startup-unread';
  const state = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'cloud', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'New chat',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { cloudUnreadCount: 99, groupId: 'group:startup-unread' },
      createdAtMs: 1,
      updatedAtMs: 2,
      lastMessageAtMs: 2,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:unread', sessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Latest chat message', content: { sender: 'Bob', timeLabel: '13:11' }, status: 'sent', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-group:startup' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never;

  const legacyGroupSessionTitlesById = new Map([[sessionId, 'Announcement']]);
  const pendingModel = createCanonicalSessionReadModel(state, {
    cloudUnreadReady: false,
    legacyGroupSessionTitlesById,
  });
  const readyModel = createCanonicalSessionReadModel(state, {
    cloudUnreadReady: true,
    legacyGroupSessionTitlesById,
  });
  const subtitle = (messages: Message[], fallback?: string) => messages.at(-1)?.text ?? fallback ?? '';

  assert.equal(pendingModel?.buildChatConversations([], subtitle)[0]?.unread, 0);
  assert.equal(readyModel?.buildChatConversations([], subtitle)[0]?.unread, 99);
  assert.equal(pendingModel?.buildChatConversations([], subtitle)[0]?.name, 'New chat');
  assert.equal(readyModel?.buildChatConversations([], subtitle)[0]?.name, 'Announcement');
});

test('canonical group conversation title stays on first message when synced cloud group name changes', () => {
  const sessionId = 'session:group:cloud-room';
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_bob', humanId: 'acct_bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { customName: '1111', groupId: sessionId, groupSpaceId: sessionId, createdFrom: 'cloud-group-sync' },
      createdAtMs: 1,
      updatedAtMs: 2,
      lastMessageAtMs: 2,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:1', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hi every', content: { sender: 'Me', timeLabel: '13:10' }, status: 'sent', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-group:1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  const conversations = readModel.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '');
  const conversation = conversations.find((candidate) => candidate.id === sessionId);
  assert.equal(conversation?.name, 'hi every');
  assert.equal((conversation?.metadata as { customName?: string } | undefined)?.customName, '1111');
  assert.equal(conversation?.messages[0]?.reactionConversationId, sessionId);
  assert.equal(conversation?.messages[0]?.reactionTargetMessageId, 'msg:1');
});

test('canonical group quote replies stay at their chronological position instead of moving beside old history', () => {
  const sessionId = 'session:group:chronological-replies';
  const quotedMessageId = 'msg:quoted-agent-history';
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 5_000,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'cloud', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'cloud', ownerIdentityId: 'human:peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'Cloud group',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { groupId: sessionId, createdFrom: 'cloud-group-sync' },
      createdAtMs: 1,
      updatedAtMs: 5_000,
      lastMessageAtMs: 5_000,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:peer', addedAtMs: 1 },
    ],
    messages: [
      { id: quotedMessageId, sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'Old agent answer', content: { sender: "Peer's Kordi", timeLabel: '05:26', deliveryState: 'complete' }, parentMessageId: null, status: 'complete', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-group-agent:old' },
      { id: 'msg:later-history', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'Old later message', content: { sender: 'Peer', timeLabel: '05:27' }, parentMessageId: null, status: 'received', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-group:later' },
      { id: 'msg:new-reply', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Test replying', content: { sender: 'Me', timeLabel: '06:16', replyToMessageId: quotedMessageId, messageAction: { kind: 'quote', schemaVersion: 1, source: { sourceMessageId: quotedMessageId, sourceSessionId: sessionId, sourceMessageKind: 'agent-turn', senderLabel: "Peer's Kordi", textPreview: 'Old agent answer', timeLabel: '05:26', attachmentCount: 0, createdAtMs: 1_000 } } }, parentMessageId: quotedMessageId, status: 'delivered', sequenceNum: 3, createdAtMs: 5_000, updatedAtMs: 5_000, contentHash: null, sourceTransport: 'cloud-group-ui', sourceEventId: 'cloud-group-ui:new-reply' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.deepEqual(readModel.messages(sessionId).map((message) => message.id), [
    quotedMessageId,
    'msg:later-history',
    'msg:new-reply',
  ]);
});

test('canonical read model keeps shared bridge transcript with local owned-agent tool details', () => {
  const sessionId = 'session:bridge:humans:shared';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-shared', humanId: 'human-bob', avatarKey: 'human-bob', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'stale later reply', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:shared:1', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hi bob', content: { sender: 'Me', timeLabel: '13:27' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'shared-1' },
      { id: 'msg:shared:2', sessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'hello', content: { sender: 'Bob', timeLabel: '13:28' }, status: 'sent', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'shared-2' },
      { id: 'msg:shared:3', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'done', content: { sender: 'Kordi', timeLabel: '13:29' }, status: 'sent', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'shared-3' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const localRuntimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'hi bob',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'Kordi'],
    messages: [{
      role: 'owned-agent',
      sender: 'Kordi',
      text: 'done',
      time: '13:29',
      turn: {
        id: 'local-turn-1',
        sessionId,
        prompt: 'run local tool',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: 'done',
        thinkingText: 'local thinking',
        tools: [{ name: 'read' }],
        completed: true,
        succeeded: true,
        error: null,
      },
    }],
  };

  const conversations = readModel?.buildChatConversations([localRuntimeConversation as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.name, 'Bob');
  assert.deepEqual(conversations[0]?.messages.map((message) => message.text || message.turn?.assistantText), ['hi bob', 'hello', 'done']);
  assert.deepEqual(conversations[0]?.messages[2]?.turn?.tools.map((tool: { name: string }) => tool.name), ['read']);
});

test('canonical read model inherits bridge targets for participant-space continuations', () => {
  const sourceSessionId = 'session:bridge:humans:source';
  const continuationSessionId = 'session:bridge:humans:continuation';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: sourceSessionId,
        kind: 'direct-person',
        title: 'Peer',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'human:peer',
        relationshipIdentityId: 'human:peer',
        metadata: {
          source: 'bridge-session-thread',
          sourceHostId: 'host-1',
          peerNodeId: 'node-peer',
          peerRuntime: 'person',
          peerDisplayName: 'Peer display',
          peerOwnerName: 'Peer owner',
          peerHumanId: 'human-peer',
        },
        createdAtMs: 1,
        updatedAtMs: 1,
        lastMessageAtMs: 1,
      },
      {
        id: continuationSessionId,
        kind: 'direct-person',
        title: 'New session',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'human:peer',
        relationshipIdentityId: 'human:peer',
        metadata: {
          createdFrom: 'chat-create-flow',
          continuedFromSessionId: sourceSessionId,
          continuedFromSpaceId: 'direct-human:human:peer',
          participantSpaceKind: 'direct-human',
        },
        createdAtMs: 2,
        updatedAtMs: 3,
        lastMessageAtMs: 3,
      },
    ],
    participants: [
      { sessionId: sourceSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: sourceSessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: sourceSessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: continuationSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
      { sessionId: continuationSessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
      { sessionId: continuationSessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [
      { id: 'msg:continuation:1', sessionId: continuationSessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'new thread', content: { sender: 'Me', timeLabel: '13:30' }, status: 'sent', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'continuation-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const continuation = conversations.find((conversation) => conversation.canonicalSessionId === continuationSessionId);

  assert.deepEqual(continuation?.collaborationTarget, {
    hostId: 'host-1',
    nodeId: 'node-peer',
    displayName: 'Peer',
    ownerName: 'Peer',
    runtime: 'person',
    humanId: 'human-peer',
    agentId: null,
  });
  assert.deepEqual(continuation?.collaborationSources, ['Cloud']);
});
