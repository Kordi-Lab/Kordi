// These fixtures cover Local Edition desktop Bridge read-model compatibility.
// Hosted collaboration must not use these legacy source transports.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

test('canonical read model keeps shared relationship history when local runtime has richer tool details', () => {
  const sessionId = '91ecedce-0766-4d34-9b4f-feb572321b22';
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
      { id: 'human:shenzhe', kind: 'human', displayName: 'Shenzhe', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-shenzhe', humanId: 'human-shenzhe', avatarKey: 'human-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'relationship', title: 'check the core agent loop', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:shenzhe', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:history:1', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'person', messageKind: 'text', contentText: 'check the core agent loop of https://github.com/openai/codex', content: { sender: 'Shenzhe', timeLabel: '20:15' }, status: 'complete', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-thread-snapshot', sourceEventId: 'history-1' },
      { id: 'msg:history:2', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'The core loop is in session handlers.', content: { sender: 'My Kordi', timeLabel: '20:15' }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-thread-snapshot', sourceEventId: 'history-2' },
      { id: 'msg:translate:1', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi can you translate it to chinese', content: { sender: 'Shenzhe', timeLabel: '20:16' }, status: 'sent', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'translate-1' },
      { id: 'msg:translate:2', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Bien sûr, voici la traduction.', content: { sender: 'My Kordi', timeLabel: '20:16' }, status: 'complete', sequenceNum: 4, createdAtMs: 4, updatedAtMs: 4, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'translate-2' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const localRuntimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: '@Kordi can you translate it to chinese',
    type: 'owned-agent',
    subtitle: '',
    unread: 1,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'Kordi'],
    collaborationTarget: { hostId: 'host-1', nodeId: 'node-shenzhe', displayName: 'Shenzhe', ownerName: 'Shenzhe', runtime: 'person', humanId: 'human-shenzhe', agentId: null },
    messages: [{
      role: 'owned-agent',
      sender: 'My Kordi',
      text: 'Bien sûr, voici la traduction.',
      time: '20:16',
      turn: {
        id: 'local-turn-translate',
        sessionId,
        prompt: 'translate it',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: 'Bien sûr, voici la traduction.',
        thinkingText: '',
        tools: [{ name: 'web_search' }],
        completed: true,
        succeeded: true,
        error: null,
      },
    }],
  };

  const conversations = readModel?.buildChatConversations([localRuntimeConversation as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(
    conversations[0]?.messages.map((message) => message.text || message.turn?.assistantText),
    [
      'check the core agent loop of https://github.com/openai/codex',
      'The core loop is in session handlers.',
      '@MyKordi can you translate it to chinese',
      'Bien sûr, voici la traduction.',
    ],
  );
  assert.deepEqual(conversations[0]?.messages[3]?.turn?.tools.map((tool: { name: string }) => tool.name), ['web_search']);
});

test('canonical read model prefers local rich owned-agent runtime over later plain bridge relay duplicate', () => {
  const sessionId = 'session:bridge:humans:rich-local-runtime';
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
      { id: 'human:shenzhe', kind: 'human', displayName: 'Shenzhe', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-shenzhe', humanId: 'human-shenzhe', avatarKey: 'human-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'inspect repo', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:shenzhe', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'person', messageKind: 'text', contentText: 'inspect repo', content: { sender: 'Shenzhe', timeLabel: '20:15' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'request' },
      { id: 'msg:local-rich', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'The repo core loop is in session handlers.', content: { sender: 'My Kordi', timeLabel: '20:16', thinkingText: 'local chain', tools: [{ id: 'tool-1', name: 'read', status: 'complete', arguments: '', liveOutput: '', resultText: 'src/main.rs', detail: null, isError: false }] }, status: 'complete', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'local-rich' },
      { id: 'msg:relay-plain', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'The repo core loop is in session handlers.', content: { sender: 'My Kordi', timeLabel: '20:16', kind: 'session-relay' }, status: 'complete', sequenceNum: 3, createdAtMs: 2_100, updatedAtMs: 2_100, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'relay-plain' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    'inspect repo',
    'The repo core loop is in session handlers.',
  ]);
  assert.equal(messages[1]?.turn?.thinkingText, 'local chain');
  assert.deepEqual(messages[1]?.turn?.tools.map((tool: { name: string }) => tool.name), ['read']);
});

test('canonical read model does not duplicate raw bridge processing while local owned agent delegation is pending', () => {
  const sessionId = 'session:bridge:humans:pending-local-agent';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Testuser5',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Testuser5', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Testuser4', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: "Testuser5's Kordi", source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Testuser4', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2_000, lastMessageAtMs: 2_000 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: '@Testuser5sKordi which model are you using?', content: { sender: 'Testuser4', timeLabel: '14:02', kind: 'mention-request', deliveryState: 'processing' }, status: 'complete', sequenceNum: 1, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'request' },
    ],
    delegatedExchanges: [
      { id: 'delegation:pending', sessionId, initiatorIdentityId: 'human:peer', targetIdentityId: 'agent:local', triggerMessageId: 'msg:request', requestMessageId: 'msg:request', responseMessageId: null, transport: 'bridge', sourceHostId: 'host-1', sourceConversationId: 'bridge:host-1:node-peer:person', sourceRequestId: 'bridge_req_pending', contextPolicy: 'recent-window', status: 'processing', error: null, createdAtMs: 2_000, updatedAtMs: 2_100 },
    ],
    presence: [],
    contextSnapshots: [],
  };
  const bridgeConversationSource = {
    id: 'bridge:host-1:node-peer:person',
    canonicalSessionId: sessionId,
    name: 'Testuser4',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Testuser4'],
    messages: [
      {
        id: 'collaboration-live-turn:bridge:host-1:node-peer:person:processing',
        role: 'owned-agent',
        sender: 'My Kordi',
        text: '',
        time: '14:02',
        turn: {
          id: 'collaboration-live-turn:processing',
          sessionId: 'bridge:host-1:node-peer:person',
          prompt: '',
          status: 'processing',
          message: 'Processing…',
          assistantText: '',
          thinkingText: '',
          tools: [],
          completed: false,
          succeeded: false,
          error: null,
        },
      },
    ],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversation = readModel?.applyConversation(bridgeConversationSource as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');
  const processingMessages = conversation?.messages.filter((message) => message.turn?.status === 'processing') ?? [];

  assert.equal(processingMessages.length, 1);
  assert.equal(processingMessages[0]?.id?.startsWith('collaboration-live-turn:'), false);
});

test('canonical read model hides joined mention notices while keeping responses after the request', () => {
  const sessionId = 'session:bridge:ordered-inbound-agent-request';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Kordi User 3',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Kordi User 3', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Kordi User 2', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: "Kordi User 3's Kordi", source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Kordi User 2', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 14_100, lastMessageAtMs: 14_100 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:previous', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'i accept your request, let\'s chat', content: { sender: 'Kordi User 2', timeLabel: '14:13' }, status: 'complete', sequenceNum: 1, createdAtMs: 13_000, updatedAtMs: 13_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'previous' },
      { id: 'msg:request', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: '@KordiUser3sKordi create a task for me', content: { sender: 'Kordi User 2', timeLabel: '14:14', kind: 'mention-request' }, status: 'complete', sequenceNum: 2, createdAtMs: 14_000, updatedAtMs: 14_000, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'request' },
      { id: 'msg:join', sessionId, senderIdentityId: 'human:peer', senderRole: 'system', messageKind: 'status', contentText: "Kordi User 3's Kordi joined via @mention", content: { kind: 'delegation-join-event', targetKind: 'agent', targetIdentityId: 'agent:local', targetDisplayName: "Kordi User 3's Kordi" }, status: 'complete', sequenceNum: 3, createdAtMs: 13_900, updatedAtMs: 13_900, parentMessageId: 'msg:request', contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'join' },
      { id: 'msg:response', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Created the task: Finish Kordi Issue 317 Review', content: { sender: 'My Kordi', timeLabel: '14:14', deliveryState: 'responded', delegatedExchangeId: 'delegation:pending' }, status: 'complete', sequenceNum: 4, createdAtMs: 14_100, updatedAtMs: 14_100, parentMessageId: 'msg:join', delegatedExchangeId: 'delegation:pending', contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'response' },
    ],
    delegatedExchanges: [
      { id: 'delegation:pending', sessionId, initiatorIdentityId: 'human:peer', targetIdentityId: 'agent:local', triggerMessageId: 'msg:request', requestMessageId: 'msg:request', responseMessageId: 'msg:response', transport: 'bridge', sourceHostId: 'host-1', sourceConversationId: 'bridge:host-1:node-peer:person', sourceRequestId: 'bridge_req_ordered', contextPolicy: 'recent-window', status: 'complete', error: null, createdAtMs: 13_900, updatedAtMs: 14_100 },
    ],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversation = readModel?.applyConversation({ id: sessionId, canonicalSessionId: sessionId, messages: [] } as never, (messages, fallback) => messages.at(-1)?.text ?? fallback ?? '');

  assert.deepEqual(conversation?.messages.map((message) => message.id), [
    'msg:previous',
    'msg:request',
    'msg:response',
  ]);
  assert.equal(conversation?.messages[2]?.replyToMessageId, 'msg:request');
  assert.equal(conversation?.messages.some((message) => message.text.includes('joined via @mention')), false);
});

test('canonical read model shows one processing item for pending inbound local agent requests', () => {
  const sessionId = 'session:bridge:single-processing-inbound-agent-request';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Kordi User 3',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Kordi User 3', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Kordi User 2', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: "Kordi User 3's Kordi", source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Kordi User 2', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 14_000, lastMessageAtMs: 14_000 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: '@KordiUser3sKordi create a task for me', content: { sender: 'Kordi User 2', timeLabel: '14:14', kind: 'mention-request' }, status: 'complete', sequenceNum: 1, createdAtMs: 14_000, updatedAtMs: 14_000, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'request' },
      { id: 'msg:raw-processing', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Processing…', content: { sender: "Kordi User 3's Kordi", timeLabel: '14:14', deliveryState: 'processing', delegatedExchangeId: 'delegation:pending' }, status: 'processing', sequenceNum: 2, createdAtMs: 14_050, updatedAtMs: 14_050, delegatedExchangeId: 'delegation:pending', contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'raw-processing' },
    ],
    delegatedExchanges: [
      { id: 'delegation:pending', sessionId, initiatorIdentityId: 'human:peer', targetIdentityId: 'agent:local', triggerMessageId: 'msg:request', requestMessageId: 'msg:request', responseMessageId: null, transport: 'bridge', sourceHostId: 'host-1', sourceConversationId: 'bridge:host-1:node-peer:person', sourceRequestId: 'bridge_req_pending', contextPolicy: 'recent-window', status: 'processing', error: null, createdAtMs: 14_000, updatedAtMs: 14_050 },
    ],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversation = readModel?.applyConversation({ id: sessionId, canonicalSessionId: sessionId, messages: [] } as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');
  const processingMessages = conversation?.messages.filter((message) => message.turn?.status === 'processing') ?? [];

  assert.deepEqual(conversation?.messages.map((message) => message.id), [
    'msg:request',
    'canonical-delegation-processing:delegation:pending',
  ]);
  assert.equal(processingMessages.length, 1);
  assert.equal(processingMessages[0]?.sender, 'My Kordi');
  assert.equal(processingMessages[0]?.replyToMessageId, 'msg:request');
});

test('canonical read model treats viewer-owned bridge agent delegations as local runtime progress', () => {
  const sessionId = 'session:bridge:viewer-owned-bridge-agent-progress';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Kordi User 3',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Kordi User 3', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-me', humanId: 'human-me', avatarKey: 'human-me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Kordi User 2', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:bridge-owned-by-me', kind: 'agent', displayName: "Kordi User 3's Kordi", source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-me', humanId: 'human-me', agentId: 'agent-me', ownerIdentityId: 'human:me', avatarKey: 'agent-me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Kordi User 2', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 15_000, lastMessageAtMs: 15_000 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:bridge-owned-by-me', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: '@KordiUser3sKordi close the task', content: { sender: 'Kordi User 2', timeLabel: '15:26', kind: 'mention-request' }, status: 'complete', sequenceNum: 1, createdAtMs: 15_000, updatedAtMs: 15_000, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'request' },
    ],
    delegatedExchanges: [
      { id: 'delegation:pending', sessionId, initiatorIdentityId: 'human:peer', targetIdentityId: 'agent:bridge-owned-by-me', triggerMessageId: 'msg:request', requestMessageId: 'msg:request', responseMessageId: null, transport: 'bridge', sourceHostId: 'host-1', sourceConversationId: 'bridge:host-1:node-peer:person', sourceRequestId: 'bridge_req_pending', contextPolicy: 'recent-window', status: 'processing', error: null, createdAtMs: 15_000, updatedAtMs: 15_100 },
    ],
    presence: [],
    contextSnapshots: [],
  };
  const localRuntimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'Kordi User 2',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'My Kordi'],
    messages: [
      {
        id: 'local-live-turn',
        role: 'owned-agent',
        sender: 'My Kordi',
        text: '',
        time: '15:26',
        turn: {
          id: 'local-live-turn',
          sessionId,
          prompt: '@KordiUser3sKordi close the task',
          status: 'thinking',
          message: 'Thinking…',
          assistantText: '',
          thinkingText: 'Closing the task',
          tools: [],
          completed: false,
          succeeded: false,
          error: null,
        },
      },
    ],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversation = readModel?.applyConversation(localRuntimeConversation as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');
  const runningAgentTurns = conversation?.messages.filter((message) => message.turn && !message.turn.completed) ?? [];

  assert.equal(runningAgentTurns.length, 1);
  assert.equal(runningAgentTurns[0]?.id, 'canonical-delegation-processing:delegation:pending');
  assert.equal(runningAgentTurns[0]?.role, 'owned-agent');
  assert.equal(runningAgentTurns[0]?.sender, 'My Kordi');
  assert.equal(runningAgentTurns[0]?.turn?.thinkingText, 'Closing the task');
  assert.deepEqual(conversation?.messages.map((message) => message.id), [
    'msg:request',
    'canonical-delegation-processing:delegation:pending',
  ]);
});
