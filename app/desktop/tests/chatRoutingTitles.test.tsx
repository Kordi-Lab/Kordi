import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';

test('canonical read model keeps a creator-anchored group name and normalizes stale remote self roles', () => {
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:user1',
      displayName: 'Testuser1',
      humanIdentityId: 'human:user1',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:user1', kind: 'human', displayName: 'Testuser1', source: 'bridge', humanId: 'kh_user1', sourceIdentityId: 'kd_user1', avatarKey: 'user1', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:user2', kind: 'human', displayName: 'Testuser2', source: 'bridge', humanId: 'kh_user2', sourceIdentityId: 'kd_user2', avatarKey: 'user2', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:user3', kind: 'human', displayName: 'Testuser3', source: 'bridge', humanId: 'kh_user3', sourceIdentityId: 'kd_user3', avatarKey: 'user3', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: 'session:group:shared',
      kind: 'group',
      title: 'New test group',
      status: 'active',
      createdByIdentityId: 'human:user2',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { source: 'bridge-session-thread', groupId: 'session:group:shared', groupSpaceId: 'session:group:shared' },
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 2,
    }],
    participants: [
      { sessionId: 'session:group:shared', identityId: 'human:user1', role: 'self', state: 'active', addedByIdentityId: 'human:user2', addedAtMs: 1 },
      { sessionId: 'session:group:shared', identityId: 'human:user2', role: 'self', state: 'active', addedByIdentityId: 'human:user2', addedAtMs: 1 },
      { sessionId: 'session:group:shared', identityId: 'human:user3', role: 'person', state: 'active', addedByIdentityId: 'human:user2', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:first', sessionId: 'session:group:shared', senderIdentityId: 'human:user2', senderRole: 'person', messageKind: 'text', contentText: 'hi every one', content: { sender: 'Testuser2', timeLabel: '00:02' }, status: 'sent', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const space = buildParticipantSpaces(conversations).find((candidate) => candidate.id === 'group:session:group:shared');

  assert.equal(space?.title, 'Testuser1, Testuser3');
  assert.deepEqual(space?.participants.filter((participant) => participant.role === 'self').map((participant) => participant.id), ['human:user1']);
});

test('canonical read model sorts group latest by chat activity instead of metadata sync touches', () => {
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'bridge', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:group:old-empty',
        kind: 'group',
        title: 'Alice, Bob',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', customName: 'Alice, Bob', groupId: 'session:group:old-empty', groupSpaceId: 'session:group:old-empty' },
        createdAtMs: 1_000,
        updatedAtMs: 50_000,
        lastMessageAtMs: null,
      },
      {
        id: 'session:group:testgroup-two',
        kind: 'group',
        title: 'testgroup two',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', customName: 'testgroup two', groupId: 'session:group:testgroup-two', groupSpaceId: 'session:group:testgroup-two' },
        createdAtMs: 40_000,
        updatedAtMs: 40_000,
        lastMessageAtMs: 45_000,
      },
    ],
    participants: [
      { sessionId: 'session:group:old-empty', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:old-empty', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:old-empty', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:testgroup-two', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:testgroup-two', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:testgroup-two', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:hi', sessionId: 'session:group:testgroup-two', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hi', content: { sender: 'Me', timeLabel: '09:41' }, status: 'sent', sequenceNum: 1, createdAtMs: 45_000, updatedAtMs: 45_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:hi' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[messages.length - 1]?.text ?? fallback ?? '') ?? [];
  const spaces = buildParticipantSpaces(conversations);

  assert.equal(spaces[0]?.title, 'testgroup two');
  assert.equal(spaces[0]?.sessions[0]?.canonicalSessionId, 'session:group:testgroup-two');
});

test('canonical read model names chat-created direct and group sessions from the first user message', () => {
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'local', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:direct-person:alice-one',
        kind: 'direct-person',
        title: 'Alice',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'human:alice',
        relationshipIdentityId: 'human:alice',
        metadata: { createdFrom: 'chat-create-flow', contactId: 'contact:alice' },
        createdAtMs: 1,
        updatedAtMs: 1,
        lastMessageAtMs: 10,
      },
      {
        id: 'session:group:crew-root',
        kind: 'group',
        title: 'Design crew',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', customName: 'Design crew', groupId: 'session:group:crew-root', groupSpaceId: 'session:group:crew-root' },
        createdAtMs: 1,
        updatedAtMs: 1,
        lastMessageAtMs: 20,
      },
    ],
    participants: [
      { sessionId: 'session:direct-person:alice-one', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:direct-person:alice-one', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:crew-root', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:crew-root', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:crew-root', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:direct:first', sessionId: 'session:direct-person:alice-one', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Plan lunch tomorrow with the launch notes before standup', content: { sender: 'Me', timeLabel: '10:01' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'direct:first' },
      { id: 'msg:group:first', sessionId: 'session:group:crew-root', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Review launch plan and assign owners before demo', content: { sender: 'Me', timeLabel: '10:02' }, status: 'sent', sequenceNum: 1, createdAtMs: 20, updatedAtMs: 20, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const directConversation = conversations.find((conversation) => conversation.id === 'session:direct-person:alice-one');
  const groupConversation = conversations.find((conversation) => conversation.id === 'session:group:crew-root');
  const groupSpace = buildParticipantSpaces(conversations).find((space) => space.id === 'group:session:group:crew-root');

  assert.equal(directConversation?.name, 'Plan lunch tomorrow with the launch notes before');
  assert.equal(groupConversation?.name, 'Review launch plan and assign owners before demo');
  assert.equal(groupSpace?.title, 'Design crew');
  assert.equal(groupSpace?.sessions[0]?.title, 'Review launch plan and assign owners before demo');
});

test('canonical read model titles private self-agent forks from the first new turn, not inherited snapshots', () => {
  const sessionId = 'session:fork:self-title';
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
      { id: 'agent:me', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'hello',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'agent:me',
      relationshipIdentityId: null,
      metadata: { fork: { forkedFromSessionId: 'parent-self-session', forkedFromMessageId: 'parent-agent-message' } },
      createdAtMs: 1,
      updatedAtMs: 40,
      lastMessageAtMs: 40,
    }],
    participants: [
      { sessionId, identityId: 'agent:me', role: 'agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'snapshot-user', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Thuwal weather today', content: { sender: 'Me', timeLabel: '11:27' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'canonical-fork-snapshot', sourceEventId: 'snapshot:user' },
      { id: 'snapshot-agent', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'weather answer', content: { sender: 'Kordi', timeLabel: '11:28' }, status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, contentHash: null, sourceTransport: 'canonical-fork-snapshot', sourceEventId: 'snapshot:agent' },
      { id: 'new-user', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello', content: { sender: 'Me', timeLabel: '11:41' }, status: 'sent', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'new:user' },
      { id: 'new-agent', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hello! How can I help you today?', content: { sender: 'Kordi', timeLabel: '11:41' }, status: 'complete', sequenceNum: 4, createdAtMs: 40, updatedAtMs: 40, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'new:agent' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages.at(-1)?.text ?? fallback ?? '') ?? [];
  const forkConversation = conversations.find((conversation) => conversation.id === sessionId);

  assert.equal(forkConversation?.name, 'hello');
});

test('canonical read model ignores inherited manual title metadata when session title is still New session', () => {
  const sessionId = 'session:group:new-child';
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'local', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: {
        createdFrom: 'chat-create-flow',
        customName: 'Good group',
        groupId: 'session:group:root',
        groupSpaceId: 'session:group:root',
        titleSource: 'manual',
        sessionTitleSource: 'manual',
      },
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 20,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:first', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'HEY GUES', content: { sender: 'Me', timeLabel: '10:47' }, status: 'sent', sequenceNum: 1, createdAtMs: 20, updatedAtMs: 20, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const groupConversation = conversations.find((conversation) => conversation.id === sessionId);
  const groupSpace = buildParticipantSpaces(conversations).find((space) => space.id === 'group:session:group:root');

  assert.equal(groupConversation?.name, 'HEY GUES');
  assert.equal(groupSpace?.title, 'Good group');
  assert.equal(groupSpace?.sessions[0]?.title, 'HEY GUES');
});

test('canonical read model prefers a manually renamed session title over the first user message', () => {
  const sessionId = 'session:direct-person:alice-renamed';
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'direct-person',
      title: 'Renamed lunch thread',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'human:alice',
      relationshipIdentityId: 'human:alice',
      metadata: { createdFrom: 'chat-create-flow', titleSource: 'manual' },
      createdAtMs: 1,
      updatedAtMs: 30,
      lastMessageAtMs: 10,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:direct:first', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Plan lunch tomorrow with the launch notes before standup', content: { sender: 'Me', timeLabel: '10:01' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'direct:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const conversation = conversations.find((item) => item.id === sessionId);
  const space = buildParticipantSpaces(conversations).find((item) => item.sessions.some((session) => session.id === sessionId));

  assert.equal(conversation?.name, 'Renamed lunch thread');
  assert.equal(space?.sessions[0]?.title, 'Renamed lunch thread');
});

test('canonical read model keeps group space names separate from first-message session titles after group rename', () => {
  const sessionId = 'session:group:renamed-space';
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'local', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'Atestgroup',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { customName: 'Atestgroup', groupId: sessionId, groupSpaceId: sessionId, titleSource: 'manual' },
      createdAtMs: 1,
      updatedAtMs: 30,
      lastMessageAtMs: 10,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:first', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello guys', content: { sender: 'Me', timeLabel: '10:13' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const space = buildParticipantSpaces(conversations).find((item) => item.id === `group:${sessionId}`);

  assert.equal(space?.title, 'Atestgroup');
  assert.equal(space?.sessions[0]?.title, 'hello guys');
});

test('canonical read model can show a manually renamed group session without changing the group space name', () => {
  const sessionId = 'session:group:manual-session-title';
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'local', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'Sprint retro notes',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { customName: 'Design crew', groupId: sessionId, groupSpaceId: sessionId, sessionTitleSource: 'manual' },
      createdAtMs: 1,
      updatedAtMs: 30,
      lastMessageAtMs: 10,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:first', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello guys', content: { sender: 'Me', timeLabel: '10:13' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const space = buildParticipantSpaces(conversations).find((item) => item.id === `group:${sessionId}`);

  assert.equal(space?.title, 'Design crew');
  assert.equal(space?.sessions[0]?.title, 'Sprint retro notes');
});
