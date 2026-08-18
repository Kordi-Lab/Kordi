import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

const directSessionId = 'session:direct-person:acct_me:acct_peer';
const runtimeConversationId = 'cloud:acct_peer:person';

const runtimeDirectConversation = {
  id: runtimeConversationId,
  canonicalSessionId: directSessionId,
  name: 'Peer',
  type: 'person',
  subtitle: 'Cloud hello',
  unread: 1,
  collaborationSources: ['kordi.ai'],
  trust: 'Cloud',
  directness: 'Person chat',
  participants: ['Me', 'Peer'],
  messages: [{
    id: 'runtime:message:1',
    role: 'person',
    sender: 'Peer',
    senderType: 'human',
    text: 'Cloud hello',
    time: '10:00',
  }],
};

function canonicalState({ materializeDirectSession = false } = {}) {
  return {
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
      {
        id: 'human:me',
        kind: 'human',
        displayName: 'Me',
        source: 'local',
        avatarKey: 'me',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      {
        id: 'human:peer',
        kind: 'human',
        displayName: 'Peer',
        source: 'cloud',
        sourceIdentityId: 'acct_peer',
        humanId: 'acct_peer',
        avatarKey: 'peer',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      {
        id: 'agent:local',
        kind: 'agent',
        displayName: 'My Kordi',
        source: 'local',
        ownerIdentityId: 'human:me',
        avatarKey: 'agent-local',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    sessions: [
      {
        id: 'session:group:existing',
        kind: 'group',
        title: 'Existing group',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { groupSpaceId: 'group:existing' },
        createdAtMs: 1,
        updatedAtMs: 1,
        lastMessageAtMs: null,
      },
      {
        id: 'session:self-agent:existing',
        kind: 'self-agent',
        title: 'Existing agent chat',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'agent:local',
        relationshipIdentityId: null,
        metadata: {},
        createdAtMs: 1,
        updatedAtMs: 1,
        lastMessageAtMs: null,
      },
      ...(materializeDirectSession ? [{
        id: directSessionId,
        kind: 'direct-person',
        title: 'Peer',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'human:peer',
        relationshipIdentityId: 'human:peer',
        metadata: { source: 'cloud-direct' },
        createdAtMs: 2,
        updatedAtMs: 3,
        lastMessageAtMs: 3,
      }] : []),
    ],
    participants: materializeDirectSession ? [
      {
        sessionId: directSessionId,
        identityId: 'human:me',
        role: 'self',
        state: 'active',
        addedByIdentityId: 'human:me',
        addedAtMs: 2,
      },
      {
        sessionId: directSessionId,
        identityId: 'human:peer',
        role: 'person',
        state: 'active',
        addedByIdentityId: 'human:me',
        addedAtMs: 2,
      },
    ] : [],
    messages: materializeDirectSession ? [{
      id: 'canonical:message:1',
      sessionId: directSessionId,
      senderIdentityId: 'human:peer',
      senderRole: 'person',
      messageKind: 'text',
      contentText: 'Cloud hello',
      content: { sender: 'Peer', timeLabel: '10:00' },
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: 3,
      updatedAtMs: 3,
      contentHash: null,
      sourceTransport: 'cloud-direct',
      sourceEventId: 'cloud:message:1',
    }] : [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

function directConversations(materializeDirectSession = false) {
  const readModel = createCanonicalSessionReadModel(
    canonicalState({ materializeDirectSession }) as never,
  );
  return readModel
    ?.buildChatConversations(
      [runtimeDirectConversation as never],
      (messages, fallback) => messages.at(-1)?.text ?? fallback ?? '',
    )
    .filter((conversation) => conversation.canonicalSessionId === directSessionId) ?? [];
}

test('canonical read model keeps runtime-only Cloud direct conversations visible', () => {
  const conversations = directConversations();

  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]?.id, runtimeConversationId);
  assert.equal(conversations[0]?.messages[0]?.text, 'Cloud hello');
});

test('canonical materialization hydrates the runtime Cloud direct conversation without a duplicate', () => {
  const runtimeOnly = directConversations();
  const canonicalBacked = directConversations(true);

  assert.equal(runtimeOnly.length, 1);
  assert.equal(canonicalBacked.length, 1);
  assert.equal(canonicalBacked[0]?.id, runtimeOnly[0]?.id);
  assert.equal(canonicalBacked[0]?.canonicalStoragePath, '/tmp/canonical.sqlite3');
  assert.deepEqual(
    canonicalBacked[0]?.messages.map((message) => message.text),
    ['Cloud hello'],
  );
});

test('canonical agent requests use one check until read and two after an agent reply starts', () => {
  const state = canonicalState() as ReturnType<typeof canonicalState> & {
    messages: Array<Record<string, unknown>>;
  };
  const sessionId = 'session:self-agent:existing';
  state.messages.push(
    {
      id: 'request:sent',
      sessionId,
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'Waiting for the agent',
      content: { sender: 'Me' },
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: 10,
      updatedAtMs: 10,
      contentHash: null,
      sourceTransport: 'cloud-self-agent',
      sourceEventId: 'request:sent',
    },
    {
      id: 'request:read',
      sessionId,
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'The agent has started',
      content: { sender: 'Me' },
      status: 'sent',
      sequenceNum: 2,
      createdAtMs: 20,
      updatedAtMs: 20,
      contentHash: null,
      sourceTransport: 'cloud-self-agent',
      sourceEventId: 'request:read',
    },
    {
      id: 'response:processing',
      sessionId,
      senderIdentityId: 'agent:local',
      senderRole: 'owned-agent',
      messageKind: 'agent-turn',
      contentText: 'processing...',
      content: {
        sender: 'My Kordi',
        deliveryState: 'processing',
        requestId: 'request:read',
        replyToMessageId: 'request:read',
      },
      parentMessageId: 'request:read',
      status: 'processing',
      sequenceNum: 3,
      createdAtMs: 21,
      updatedAtMs: 21,
      contentHash: null,
      sourceTransport: 'cloud-self-agent',
      sourceEventId: 'response:processing',
    },
  );

  const messages = createCanonicalSessionReadModel(state as never)?.messages(sessionId) ?? [];

  assert.deepEqual(messages.find((message) => message.id === 'request:sent')?.statusChips, ['sent']);
  assert.deepEqual(messages.find((message) => message.id === 'request:read')?.statusChips, ['read']);
});

test('canonical runtime messages remain visible when the legacy canonical snapshot is behind', () => {
  const readModel = createCanonicalSessionReadModel(
    canonicalState({ materializeDirectSession: true }) as never,
  );
  const runtimeWithNewChatMessage = {
    ...runtimeDirectConversation,
    subtitle: 'Newest chat message',
    messages: [
      ...runtimeDirectConversation.messages,
      {
        id: 'chat:message:2',
        role: 'user',
        sender: 'Me',
        senderType: 'human',
        text: 'Newest chat message',
        time: '10:01',
      },
    ],
  };

  const [conversation] = readModel?.buildChatConversations(
    [runtimeWithNewChatMessage as never],
    (messages, fallback) => messages.at(-1)?.text ?? fallback ?? '',
  ) ?? [];

  assert.deepEqual(
    conversation?.messages.map((message) => message.text),
    ['Cloud hello', 'Newest chat message'],
  );
  assert.equal(conversation?.subtitle, 'Newest chat message');
});

test('canonical read model hides accidentally persisted local draft sessions', () => {
  const state = canonicalState() as ReturnType<typeof canonicalState> & {
    sessions: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
  };
  state.sessions.push({
    id: 'draft:local-chat',
    kind: 'self-agent',
    title: 'New chat',
    status: 'active',
    createdByIdentityId: 'human:me',
    primaryIdentityId: 'agent:local',
    relationshipIdentityId: null,
    metadata: { cloudSelfAgentSession: true },
    createdAtMs: 4,
    updatedAtMs: 4,
    lastMessageAtMs: 4,
  });
  state.messages.push({
    id: 'msg:draft-model-change',
    sessionId: 'draft:local-chat',
    senderIdentityId: 'agent:local',
    senderRole: 'system',
    messageKind: 'agent-model-change',
    contentText: 'Switched model to openai/gpt-5.6-luna',
    content: null,
    status: 'sent',
    sequenceNum: 1,
    createdAtMs: 4,
    updatedAtMs: 4,
    contentHash: null,
    sourceTransport: 'cloud-self-agent',
    sourceEventId: 'cloud:model-change',
  });

  const conversations = createCanonicalSessionReadModel(state as never)
    ?.buildChatConversations([], () => '') ?? [];

  assert.equal(
    conversations.some((conversation) => (
      conversation.canonicalSessionId === 'draft:local-chat'
    )),
    false,
  );
});
