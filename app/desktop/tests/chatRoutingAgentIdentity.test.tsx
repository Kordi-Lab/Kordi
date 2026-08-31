import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

test('canonical read model keeps the renamed default agent and owner tag after hydration', () => {
  const sessionId = 'session:self-agent:renamed-default';
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:legacy',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:legacy', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'Kordi',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'agent:legacy',
      relationshipIdentityId: null,
      metadata: {},
      createdAtMs: 1,
      updatedAtMs: 2,
      lastMessageAtMs: 2,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:legacy', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:user', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hi', content: { sender: 'Me' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'user' },
      { id: 'msg:agent', sessionId, senderIdentityId: 'agent:legacy', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hi!', content: { sender: 'Kordi' }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'agent' },
      { id: 'msg:external-role', sessionId, senderIdentityId: 'agent:legacy', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'Welcome back!', content: { sender: 'Kordi' }, status: 'complete', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'external-role' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never, { localAgentDisplayName: 'Babytang' });

  const conversation = readModel?.buildChatConversations([], (messages, fallback) => messages.at(-1)?.text ?? fallback ?? '')[0];
  const agentMessage = conversation?.messages.find((message) => message.role === 'owned-agent');

  assert.equal(conversation?.name, 'Babytang');
  assert.equal(agentMessage?.sender, 'Babytang');
  assert.equal(agentMessage?.senderOwnerName, 'You');
  assert.deepEqual(
    conversation?.messages
      .filter((message) => message.senderOwnerName === 'You')
      .map((message) => message.sender),
    ['Babytang', 'Babytang'],
  );
});
