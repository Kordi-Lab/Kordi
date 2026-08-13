import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

test('canonical read model keeps blank selected-agent sessions visible under My chats', () => {
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
      { id: 'agent:reviewer', kind: 'agent', displayName: 'Reviewer', source: 'local', avatarKey: 'reviewer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:self-agent:selected-reviewer',
        kind: 'self-agent',
        title: 'Reviewer',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'agent:reviewer',
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:reviewer', participantSpaceKind: 'self' },
        createdAtMs: 2,
        updatedAtMs: 2,
        lastMessageAtMs: null,
      },
    ],
    participants: [
      { sessionId: 'session:self-agent:selected-reviewer', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
      { sessionId: 'session:self-agent:selected-reviewer', identityId: 'agent:reviewer', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  });

  const conversations = readModel?.buildChatConversations([], () => '') ?? [];

  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]?.id, 'session:self-agent:selected-reviewer');
  assert.equal(conversations[0]?.type, 'owned-agent');
});

test('canonical read model keeps separate direct person bridge sessions for the same participant', () => {
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
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-shared', humanId: 'human-bob', avatarKey: 'human-bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session:bridge:humans:first', kind: 'direct-person', title: 'first hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 },
      { id: 'session:bridge:humans:second', kind: 'direct-person', title: 'second hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 2, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId: 'session:bridge:humans:first', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:first', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:second', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
      { sessionId: 'session:bridge:humans:second', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(conversations.map((conversation) => conversation.id), [
    'session:bridge:humans:second',
    'session:bridge:humans:first',
  ]);
});

test('canonical read model suppresses optimistic bridge UI echo after parent bridge sync confirms send', () => {
  const sessionId = 'session:bridge:humans:bob';
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:profile:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:profile:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bridge:me', kind: 'human', displayName: 'Me', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-me', humanId: 'human-me', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Bob', status: 'active', createdByIdentityId: 'human:profile:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1_800, lastMessageAtMs: 1_800 },
    ],
    participants: [
      { sessionId, identityId: 'human:bridge:me', role: 'self', state: 'active', addedByIdentityId: 'human:profile:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:profile:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:ui', sessionId, senderIdentityId: 'human:profile:me', senderRole: 'user', messageKind: 'text', contentText: 'hi taylor how are you', content: { sender: 'Me', timeLabel: '19:22' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-ui', sourceEventId: 'desktop-bridge-ui:session:bridge:humans:bob:1000' },
      { id: 'msg:parent', sessionId, senderIdentityId: 'human:bridge:me', senderRole: 'user', messageKind: 'text', contentText: 'hi taylor how are you', content: { sender: 'Me', timeLabel: '19:22', deliveryState: 'read', sourceConversationId: 'bridge:host-1:node-bob:person' }, status: 'read', sequenceNum: 2, createdAtMs: 1_800, updatedAtMs: 1_800, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'desktop-bridge-parent:session:bridge:humans:bob:bridge:host-1:node-bob:person:bridge_msg_1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.ok(readModel);

  const [conversation] = readModel.buildChatConversations([], (messages, fallback) => messages[0]?.text || fallback || '');

  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0]?.text, 'hi taylor how are you');
  assert.deepEqual(conversation.messages[0]?.statusChips, ['read']);
});

test('canonical read model preserves unread count from source bridge conversation', () => {
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
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session:bridge:humans:unread', kind: 'direct-person', title: 'Bob', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId: 'session:bridge:humans:unread', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:unread', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-1', sessionId: 'session:bridge:humans:unread', senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Unread hello', content: { sender: 'Bob', timeLabel: '10:00' }, status: 'delivered', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'unread-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.ok(readModel);

  const sourceConversation = {
    id: 'bridge:host-1:node-bob:person',
    canonicalSessionId: 'session:bridge:humans:unread',
    name: 'Bob',
    type: 'person' as const,
    subtitle: 'Direct person chat',
    unread: 3,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{ role: 'person' as const, sender: 'Bob', text: 'Unread hello', time: '10:00' }],
  };

  const [conversation] = readModel.buildChatConversations([sourceConversation], (messages, fallback) => messages[0]?.text || fallback || '');

  assert.equal(conversation.unread, 3);
});

test('canonical read model preserves unread count when bridge source is routed by outreach parent session', () => {
  const latestSessionId = 'session:bridge:humans:latest';
  const olderSessionId = 'session:bridge:humans:older';
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
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: latestSessionId, kind: 'direct-person', title: 'new unread', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceConversationId: 'bridge:host-1:node-bob:person', sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 2, updatedAtMs: 3, lastMessageAtMs: 3 },
      { id: olderSessionId, kind: 'direct-person', title: 'old thread', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceConversationId: 'bridge:host-1:node-bob:person', sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 },
    ],
    participants: [
      { sessionId: latestSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: latestSessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-latest', sessionId: latestSessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'new unread', content: { sender: 'Bob', timeLabel: '10:03' }, status: 'delivered', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'latest-1' },
      { id: 'msg-older', sessionId: olderSessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'old thread', content: { sender: 'Bob', timeLabel: '10:01' }, status: 'delivered', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'older-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.ok(readModel);

  const sourceConversation = {
    id: 'bridge:host-1:node-bob:person',
    canonicalSessionId: 'session:bridge:humans:stable-pair',
    name: 'Bob',
    type: 'person' as const,
    subtitle: 'Direct person chat',
    unread: 2,
    collaborationUnreadByParentSessionId: { [latestSessionId]: 1, [olderSessionId]: 1 },
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{ role: 'person' as const, sender: 'Bob', text: 'new unread', time: '10:03' }],
    outreach: { parentSessionId: latestSessionId },
  };

  const conversations = readModel.buildChatConversations([sourceConversation as never], (messages, fallback) => messages[0]?.text || fallback || '');

  const latestConversation = conversations.find((conversation) => conversation.canonicalSessionId === latestSessionId);
  assert.equal(latestConversation?.id, latestSessionId);
  assert.equal(latestConversation?.unread, 1);
  assert.equal(conversations.find((conversation) => conversation.canonicalSessionId === olderSessionId)?.unread, 1);
  assert.equal(conversations.some((conversation) => conversation.id === 'bridge:host-1:node-bob:person'), false);
});
