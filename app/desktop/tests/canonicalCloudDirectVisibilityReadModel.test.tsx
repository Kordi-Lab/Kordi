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
