// These fixtures cover Local Edition desktop Bridge read-model compatibility.
// Hosted collaboration must not use these legacy source transports.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { cloudGroupAgentConversationId } from '../src/features/cloud/cloudGroupMessages';

test('canonical read model anchors cloud group agent progress and replies to their request', () => {
  const sessionId = 'session:group:cloud-sequence';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:me',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_peer', humanId: 'acct_peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: "Me's Kordi", source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Cloud group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { kind: 'chat-group' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:me', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: '@MesKordi hello', content: { sender: 'Peer' }, status: 'complete', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-request' },
      { id: 'msg:processing', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: 'My Kordi', deliveryState: 'processing', requestId: 'msg:request', replyToMessageId: 'msg:request' }, parentMessageId: 'msg:request', status: 'processing', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-processing' },
      { id: 'msg:duplicate-response', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Earlier duplicate.', content: { sender: 'My Kordi', deliveryState: 'complete', requestId: 'msg:request', replyToMessageId: 'msg:request' }, parentMessageId: 'msg:request', status: 'complete', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-duplicate-response' },
      { id: 'msg:response', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hello from Kordi.', content: { sender: 'My Kordi', deliveryState: 'complete', requestId: 'msg:request', replyToMessageId: 'msg:request' }, parentMessageId: 'msg:request', status: 'complete', sequenceNum: 4, createdAtMs: 4, updatedAtMs: 4, contentHash: null, sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversation = readModel?.applyConversation({ id: sessionId, canonicalSessionId: sessionId, messages: [] } as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');
  const agentTurns = conversation?.messages.filter((message) => message.turn) ?? [];

  assert.deepEqual(conversation?.messages.map((message) => message.id), ['msg:request', 'msg:response']);
  assert.equal(agentTurns.length, 1);
  assert.equal(agentTurns[0]?.replyToMessageId, 'msg:request');
  assert.equal(agentTurns[0]?.turn?.replyToMessageId, 'msg:request');
});

test('canonical read model suppresses legacy cloud-group processing rows after a separate terminal response', () => {
  const sessionId = 'session:group:cloud-legacy-processing';
  const requestId = 'msg:ui:8b5bec56-9d67-4a6e-9485-998174f7f51d';
  const responseText = 'Yes — I can see messages in this current chat.';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile:me', displayName: 'Me', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_peer', humanId: 'acct_peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:cloud:acct_owner', kind: 'agent', displayName: 'Kordi Project Driver', source: 'bridge', sourceHostId: 'cloud', ownerIdentityId: 'human:peer', avatarKey: 'agent-cloud', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{ id: sessionId, kind: 'group', title: 'Cloud group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { kind: 'chat-group' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:cloud:acct_owner', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: requestId, sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@KordiProjectDriver can you see the old message?', content: { sender: 'Me' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-request' },
      { id: `msg:cloud-agent-processing:${requestId}:acct_owner`, sessionId, senderIdentityId: 'agent:cloud:acct_owner', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: 'Kordi Project Driver', deliveryState: 'processing', requestId, replyToMessageId: requestId }, parentMessageId: requestId, status: 'processing', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-group-agent:msg_processing' },
      { id: 'msg:cloud-agent:terminal', sessionId, senderIdentityId: 'agent:cloud:acct_owner', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'Kordi Project Driver', deliveryState: 'complete', requestId, replyToMessageId: requestId }, parentMessageId: requestId, status: 'received', sequenceNum: 3, createdAtMs: 25_000, updatedAtMs: 25_000, contentHash: null, sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-group-agent:msg_terminal' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const staleExistingMessages = [
    { id: requestId, role: 'user', text: '@KordiProjectDriver can you see the old message?' },
    { id: `msg:cloud-agent-processing:${requestId}:acct_owner`, role: 'external-agent', text: '', replyToMessageId: requestId, turn: { id: 'turn:processing', status: 'processing', message: 'Processing…', assistantText: '', thinkingText: '', tools: [], completed: false, replyToMessageId: requestId } },
    { id: 'msg:cloud-agent:terminal', role: 'external-agent', text: responseText, replyToMessageId: requestId, turn: { id: 'turn:terminal', status: 'complete', message: responseText, assistantText: responseText, thinkingText: '', tools: [], completed: true, replyToMessageId: requestId } },
  ];
  const conversation = readModel?.applyConversation({ id: sessionId, canonicalSessionId: sessionId, messages: staleExistingMessages } as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');

  assert.deepEqual(conversation?.messages.map((message) => message.id), [requestId, 'msg:cloud-agent:terminal']);
  assert.equal(conversation?.messages.some((message) => message.id.startsWith('msg:cloud-agent-processing:')), false);
});

test('canonical read model suppresses cloud-group requesting rows after a terminal response', () => {
  const sessionId = 'session:group:cloud-requesting-complete';
  const requestId = 'msg:ui:ed83fc62-9564-4591-bbb7-eed78caf393c';
  const responseText = 'Yes — I can see the chat history in this current conversation.';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile:me', displayName: 'Me', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:owner', kind: 'human', displayName: '111', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_owner', humanId: 'acct_owner', avatarKey: 'owner', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:cloud:acct_owner', kind: 'agent', displayName: 'Kordi Project Driver', source: 'bridge', sourceHostId: 'cloud', ownerIdentityId: 'human:owner', avatarKey: 'agent-cloud', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{ id: sessionId, kind: 'group', title: 'Cloud group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { kind: 'chat-group' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:owner', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:cloud:acct_owner', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: requestId, sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@KordiProjectDriver can you see the chat history', content: { sender: 'Me' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'cloud-group-ui', sourceEventId: 'cloud-request' },
      { id: `msg:cloud-agent-offline:${requestId}:acct_owner`, sessionId, senderIdentityId: 'agent:cloud:acct_owner', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'Requesting…', content: { sender: 'Kordi Project Driver', deliveryState: 'processing', requestId, replyToMessageId: requestId }, parentMessageId: requestId, status: 'processing', sequenceNum: 2, createdAtMs: 1_001, updatedAtMs: 1_001, contentHash: null, sourceTransport: 'cloud-group-agent-offline', sourceEventId: `cloud-group-agent-offline:${requestId}:acct_owner` },
      { id: `msg:cloud-agent-processing:${requestId}:acct_owner`, sessionId, senderIdentityId: 'agent:cloud:acct_owner', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'Kordi Project Driver', deliveryState: 'complete', requestId, replyToMessageId: requestId }, parentMessageId: requestId, status: 'complete', sequenceNum: 3, createdAtMs: 8_000, updatedAtMs: 8_000, contentHash: null, sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const staleExistingMessages = [
    { id: requestId, role: 'user', text: '@KordiProjectDriver can you see the chat history' },
    { id: `msg:cloud-agent-offline:${requestId}:acct_owner`, role: 'external-agent', sender: 'Kordi Project Driver', text: '', replyToMessageId: requestId, turn: { id: 'turn:requesting', status: 'processing', message: 'Processing…', assistantText: '', thinkingText: '', tools: [], completed: false, replyToMessageId: requestId } },
    { id: `msg:cloud-agent-processing:${requestId}:acct_owner`, role: 'owned-agent', sender: 'Kordi Project Driver', text: responseText, replyToMessageId: requestId, turn: { id: 'turn:terminal', status: 'complete', message: responseText, assistantText: responseText, thinkingText: '', tools: [], completed: true, replyToMessageId: requestId } },
  ];
  const conversation = readModel?.applyConversation({ id: sessionId, canonicalSessionId: sessionId, messages: staleExistingMessages } as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');

  assert.deepEqual(conversation?.messages.map((message) => message.id), [requestId, `msg:cloud-agent-processing:${requestId}:acct_owner`]);
  assert.equal(conversation?.messages.some((message) => message.id.startsWith('msg:cloud-agent-offline:')), false);
});

test('canonical read model renders cloud group requesting placeholders as active processing turns', () => {
  const sessionId = 'session:group:cloud-requesting';
  const requestId = 'msg:request';
  const groupConversationId = cloudGroupAgentConversationId(sessionId);
  const now = Date.now();
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile:me', displayName: 'Me', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_peer', humanId: 'acct_peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', sourceHostId: 'cloud', ownerIdentityId: 'human:peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{ id: sessionId, kind: 'group', title: 'Cloud group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { kind: 'chat-group' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: requestId, sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@PeersKordi stop test', content: { sender: 'Me' }, status: 'sent', sequenceNum: 1, createdAtMs: now, updatedAtMs: now, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-request' },
      { id: `msg:cloud-agent-offline:${requestId}:acct_peer`, sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'Requesting…', content: { sender: "Peer's Kordi", deliveryState: 'processing', sourceConversationId: groupConversationId, requestId, replyToMessageId: requestId }, parentMessageId: requestId, status: 'processing', sequenceNum: 2, createdAtMs: now + 1, updatedAtMs: now + 1, contentHash: null, sourceTransport: 'cloud-group-agent-offline', sourceEventId: 'cloud-requesting' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversation = readModel?.applyConversation({ id: sessionId, canonicalSessionId: sessionId, messages: [] } as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');
  const requestingTurn = conversation?.messages.find((message) => message.turn)?.turn;

  assert.equal(requestingTurn?.status, 'processing');
  assert.equal(requestingTurn?.message, 'Processing…');
  assert.equal(requestingTurn?.assistantText, '');
  assert.deepEqual(requestingTurn?.pendingCollaborationAgentRequest, {
    conversationId: groupConversationId,
    requestId,
  });
});

test('canonical read model renders cloud group cancellations as one request-canceled line', () => {
  const sessionId = 'session:group:cloud-cancelled';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile:me', displayName: 'Me', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_peer', humanId: 'acct_peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', sourceHostId: 'cloud', ownerIdentityId: 'human:peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{ id: sessionId, kind: 'group', title: 'Cloud group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { kind: 'chat-group' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@PeersKordi stop test', content: { sender: 'Me' }, status: 'complete', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-request' },
      { id: 'msg:cancelled', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'Request canceled by sender.', content: { sender: "Peer's Kordi", deliveryState: 'cancelled', requestId: 'msg:request', replyToMessageId: 'msg:request', cancelledByRole: 'sender' }, parentMessageId: 'msg:request', status: 'cancelled', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-cancelled' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversation = readModel?.applyConversation({ id: sessionId, canonicalSessionId: sessionId, messages: [] } as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');
  const cancelledTurn = conversation?.messages.find((message) => message.turn?.status === 'cancelled')?.turn;

  assert.equal(cancelledTurn?.message, 'Request canceled by sender.');
  assert.equal(cancelledTurn?.assistantText, 'Request canceled by sender.');
  assert.equal(cancelledTurn?.error, null);
});

test('created-agent sessions keep their selected identity while hiding My Kordi mirrors', () => {
  const sessionId = 'session:self-agent:stock-trader';
  const requestAt = 1_000;
  const responseAt = 2_000;
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:stock-trader',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:stock-trader', kind: 'agent', displayName: 'US Stock Paper Trader', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-stock', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:cloud-self:acct_me', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-cloud', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'US Stock Paper Trader',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'agent:stock-trader',
      relationshipIdentityId: null,
      metadata: { createdFrom: 'chat-create-flow', cloudAgentId: 'cloud_agent_stock', cloudAgentName: 'US Stock Paper Trader' },
      createdAtMs: requestAt,
      updatedAtMs: responseAt,
      lastMessageAtMs: responseAt,
    }],
    participants: [
      { sessionId, identityId: 'agent:stock-trader', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:desktop-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'who are you', content: { sender: 'Me' }, status: 'sent', sequenceNum: 1, createdAtMs: requestAt, updatedAtMs: requestAt, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'desktop-request' },
      { id: 'msg:desktop-answer', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'I am US Stock Paper Trader.', content: { sender: 'My Kordi' }, parentMessageId: 'entry:runtime-user', status: 'complete', sequenceNum: 2, createdAtMs: responseAt, updatedAtMs: responseAt, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'desktop-answer' },
      { id: 'msg:cloud-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'who are you', content: null, status: 'sent', sequenceNum: 3, createdAtMs: requestAt, updatedAtMs: requestAt, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'cloud-request' },
      { id: 'msg:cloud-answer', sessionId, senderIdentityId: 'agent:cloud-self:acct_me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'I am US Stock Paper Trader.', content: { cloudRequestMessageId: 'cloud-request', deliveryState: 'complete' }, parentMessageId: 'msg:cloud-request', status: 'complete', sequenceNum: 4, createdAtMs: requestAt + 1, updatedAtMs: requestAt + 1, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'cloud-answer' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    'who are you',
    'I am US Stock Paper Trader.',
  ]);
  assert.equal(messages[1]?.sender, 'US Stock Paper Trader');
  assert.equal(messages[1]?.senderOwnerName, 'You');
  assert.notEqual(messages[1]?.sender, 'My Kordi');

  const hydrated = readModel.applyConversation({
    id: sessionId,
    canonicalSessionId: sessionId,
    desktopRuntimeBacked: true,
    desktopRuntimeTranscriptLoaded: true,
    messages: [
      { id: 'runtime-request', entryId: 'msg:desktop-request', role: 'user', text: 'who are you', time: '00:00', timestampMs: requestAt },
      { id: 'runtime-answer', role: 'owned-agent', sender: 'US Stock Paper Trader', text: '', time: '00:00', timestampMs: responseAt, turn: { id: 'runtime-turn', sessionId, prompt: 'who are you', status: 'complete', message: 'Complete', assistantText: 'I am US Stock Paper Trader.', thinkingText: '', tools: [], completed: true, succeeded: true, error: null } },
    ],
  } as never, (items, fallback) => items.at(-1)?.turn?.message ?? fallback ?? '');
  assert.deepEqual(hydrated.messages.map((message) => message.text || message.turn?.assistantText), [
    'who are you',
    'I am US Stock Paper Trader.',
  ]);
  assert.equal(hydrated.messages[1]?.senderOwnerName, 'You');
});

test('canonical read model shows one error when local and Cloud self-agent failures repeat for one request', () => {
  const sessionId = 'session:self-agent:failed-mirrors';
  const requestId = 'msg:canonical-request';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:me',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'New chat',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'agent:me',
      relationshipIdentityId: null,
      metadata: { cloudSelfAgentSession: true },
      createdAtMs: 1_000,
      updatedAtMs: 3_000,
      lastMessageAtMs: 3_000,
    }],
    participants: [
      { sessionId, identityId: 'agent:me', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: requestId, sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Hihihi', content: null, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'cloud-request' },
      { id: 'msg:cloud:self:legacy-failure', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '', content: { deliveryState: 'failed', error: 'Cloud fallback could not complete this request because the configured provider/model failed.', requestId, replyToMessageId: requestId }, parentMessageId: requestId, status: 'failed', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'cloud-failure-1' },
      { id: 'msg:cloud:self:response:cloud-request', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '', content: { deliveryState: 'failed', error: 'Cloud fallback could not complete this request because the configured provider/model failed.', requestId, replyToMessageId: requestId }, parentMessageId: requestId, status: 'failed', sequenceNum: 3, createdAtMs: 3_000, updatedAtMs: 3_000, contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'cloud-failure-2' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const runtimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    desktopRuntimeBacked: true,
    desktopRuntimeTranscriptLoaded: true,
    messages: [
      { id: 'msg:runtime-request', entryId: requestId, role: 'user', text: 'Hihihi', time: '22:01', timestampMs: 1_000 },
      { id: 'turn:local-failure', role: 'owned-agent', sender: 'My Kordi', text: '', time: '22:01', timestampMs: 1_500, replyToMessageId: 'msg:runtime-request', turn: { id: 'turn:local-failure', sessionId, prompt: '', status: 'failed', message: 'Failed', assistantText: '', thinkingText: '', tools: [], completed: true, succeeded: false, error: 'Your authentication token has been invalidated.', replyToMessageId: 'msg:runtime-request' } },
    ],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversation = readModel?.applyConversation(
    runtimeConversation as never,
    (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '',
  );
  const errors = conversation?.messages.filter(
    (message) => message.turn?.status === 'failed',
  ) ?? [];

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.id, 'msg:cloud:self:response:cloud-request');
  assert.equal(
    errors[0]?.turn?.error,
    'Cloud fallback could not complete this request because the configured provider/model failed.',
  );
});

test('canonical read model exposes cloud group agent stop controls to requester and model owner', () => {
  const sessionId = 'session:group:cloud-stop';
  const requestId = 'msg:request';
  const groupConversationId = cloudGroupAgentConversationId(sessionId);
  const now = Date.now();
  const baseState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:me',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_peer', humanId: 'acct_peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: "Me's Kordi", source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', sourceHostId: 'cloud', ownerIdentityId: 'human:peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Cloud group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { kind: 'chat-group' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:me', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const processingContent = {
    sender: 'My Kordi',
    deliveryState: 'processing',
    sourceConversationId: groupConversationId,
    requestId,
    replyToMessageId: requestId,
  };
  const ownerState = {
    ...baseState,
    messages: [
      { id: requestId, sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: '@MesKordi stop test', content: { sender: 'Peer' }, status: 'complete', sequenceNum: 1, createdAtMs: now, updatedAtMs: now, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-request' },
      { id: 'msg:processing', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'processing...', content: processingContent, parentMessageId: requestId, status: 'processing', sequenceNum: 2, createdAtMs: now + 1, updatedAtMs: now + 1, contentHash: null, sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-processing' },
    ],
  };
  const requesterState = {
    ...baseState,
    messages: [
      { id: requestId, sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@PeersKordi stop test', content: { sender: 'Me' }, status: 'complete', sequenceNum: 1, createdAtMs: now, updatedAtMs: now, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud-request' },
      { id: 'msg:processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: processingContent, parentMessageId: requestId, status: 'processing', sequenceNum: 2, createdAtMs: now + 1, updatedAtMs: now + 1, contentHash: null, sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-processing' },
    ],
  };

  for (const state of [ownerState, requesterState]) {
    const readModel = createCanonicalSessionReadModel(state as never);
    const conversation = readModel?.applyConversation({ id: sessionId, canonicalSessionId: sessionId, messages: [] } as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');
    const processingTurn = conversation?.messages.find((message) => message.turn?.status === 'processing')?.turn;
    assert.deepEqual(processingTurn?.pendingCollaborationAgentRequest, {
      conversationId: groupConversationId,
      requestId,
    });
  }
});
