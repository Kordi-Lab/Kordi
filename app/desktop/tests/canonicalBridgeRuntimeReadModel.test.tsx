import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

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
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shared', humanId: 'human-bob', avatarKey: 'human-bob', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'stale later reply', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
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
    bridges: ['Local'],
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

  assert.equal(conversations[0]?.name, 'hi bob');
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
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
          bridgeHostId: 'host-1',
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

  assert.deepEqual(continuation?.bridgeTarget, {
    hostId: 'host-1',
    nodeId: 'node-peer',
    displayName: 'Peer',
    ownerName: 'Peer',
    runtime: 'person',
    humanId: 'human-peer',
    agentId: null,
  });
  assert.deepEqual(continuation?.bridges, ['Bridge']);
});

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
      { id: 'human:shenzhe', kind: 'human', displayName: 'Shenzhe', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shenzhe', humanId: 'human-shenzhe', avatarKey: 'human-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'relationship', title: 'check the core agent loop', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
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
      { id: 'msg:translate:2', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '当然，翻译如下。', content: { sender: 'My Kordi', timeLabel: '20:16' }, status: 'complete', sequenceNum: 4, createdAtMs: 4, updatedAtMs: 4, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'translate-2' },
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
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'Kordi'],
    bridgeTarget: { hostId: 'host-1', nodeId: 'node-shenzhe', displayName: 'Shenzhe', ownerName: 'Shenzhe', runtime: 'person', humanId: 'human-shenzhe', agentId: null },
    messages: [{
      role: 'owned-agent',
      sender: 'My Kordi',
      text: '当然，翻译如下。',
      time: '20:16',
      turn: {
        id: 'local-turn-translate',
        sessionId,
        prompt: 'translate it',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: '当然，翻译如下。',
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
      '当然，翻译如下。',
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
      { id: 'human:shenzhe', kind: 'human', displayName: 'Shenzhe', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shenzhe', humanId: 'human-shenzhe', avatarKey: 'human-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'inspect repo', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
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
      { id: 'human:peer', kind: 'human', displayName: 'Testuser4', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: "Testuser5's Kordi", source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Testuser4', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2_000, lastMessageAtMs: 2_000 },
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
      { id: 'delegation:pending', sessionId, initiatorIdentityId: 'human:peer', targetIdentityId: 'agent:local', triggerMessageId: 'msg:request', requestMessageId: 'msg:request', responseMessageId: null, transport: 'bridge', bridgeHostId: 'host-1', bridgeConversationId: 'bridge:host-1:node-peer:person', bridgeRequestId: 'bridge_req_pending', contextPolicy: 'recent-window', status: 'processing', error: null, createdAtMs: 2_000, updatedAtMs: 2_100 },
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
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Testuser4'],
    messages: [
      {
        id: 'bridge-live-turn:bridge:host-1:node-peer:person:processing',
        role: 'owned-agent',
        sender: 'My Kordi',
        text: '',
        time: '14:02',
        turn: {
          id: 'bridge-live-turn:processing',
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
  assert.equal(processingMessages[0]?.id?.startsWith('bridge-live-turn:'), false);
});

test('canonical read model replaces bridge relay copy with active local owned-agent group turn', () => {
  const sessionId = 'session:group:local-owner-duplicate';
  const localText = 'I’ll quickly check current public info/reviews for Al-Marsa Restaurant pricing before answering.\n\nAl-Marsa Restaurant in KAUST is probably **medium to expensive**.';
  const relayText = 'I’ll quickly check current public info/reviews for Al-Marsa Restaurant pricing before answering.Al-Marsa Restaurant in KAUST is probably **medium to expensive**.';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Testuser4',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Testuser4', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Testuser6', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'KAUST weekend', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@Kordi is Al-Marsa Restaurant expensive?', content: { sender: 'You', timeLabel: '12:51' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'request' },
      { id: 'msg:bridge-relay', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: relayText, content: { sender: "Testuser4's Kordi", timeLabel: '12:52', kind: 'session-relay', deliveryState: 'responded', requestId: 'bridge_req_local_group' }, status: 'complete', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'relay' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const localRuntimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'KAUST weekend',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Group chat',
    participants: ['Me', 'My Kordi', 'Testuser6'],
    messages: [{
      role: 'owned-agent',
      sender: 'My Kordi',
      text: '',
      time: '12:52',
      turn: {
        id: 'local-turn-al-marsa',
        sessionId,
        prompt: '@Kordi is Al-Marsa Restaurant expensive?',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: localText,
        thinkingText: 'Considering web search options',
        tools: [{ id: 'tool-search', name: 'web_search', status: 'done', arguments: '', liveOutput: '', resultText: 'Al Marsa listing', detail: null, isError: false }],
        completed: true,
        succeeded: true,
        error: null,
      },
    }],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([localRuntimeConversation as never], (messages, fallback) => messages.at(-1)?.turn?.assistantText ?? fallback ?? '') ?? [];
  const messages = conversations[0]?.messages ?? [];

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    '@Kordi is Al-Marsa Restaurant expensive?',
    localText,
  ]);
  assert.equal(messages[1]?.turn?.id, 'local-turn-al-marsa');
  assert.deepEqual(messages[1]?.turn?.tools.map((tool: { name: string }) => tool.name), ['web_search']);
});

test('canonical read model dedupes owned-agent runtime and bridge relay when only whitespace differs', () => {
  const sessionId = 'session:bridge:humans:whitespace-duplicate-runtime';
  const localText = 'I’ll check current web weather info for Thuwal today and summarize it.\n\nToday in **Thuwal, Saudi Arabia**:\n\n- **Current temperature:** about **29°C**';
  const relayText = 'I’ll check current web weather info for Thuwal today and summarize it.Today in **Thuwal, Saudi Arabia**:\n\n- **Current temperature:** about **29°C**';
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi can you check thuwal weather today?', content: { sender: 'Me', timeLabel: '13:36' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'request' },
      { id: 'msg:local-rich', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: localText, content: { sender: 'My Kordi', timeLabel: '13:37', thinkingText: 'local chain', tools: [{ id: 'tool-1', name: 'web_fetch', status: 'complete', arguments: '', liveOutput: '', resultText: 'weather', detail: null, isError: false }] }, status: 'complete', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'local-rich' },
      { id: 'msg:relay-plain', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: relayText, content: { sender: 'My Kordi', timeLabel: '13:37', kind: 'session-relay' }, status: 'complete', sequenceNum: 3, createdAtMs: 2_100, updatedAtMs: 2_100, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'relay-plain' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    '@MyKordi can you check thuwal weather today?',
    localText,
  ]);
  assert.deepEqual(messages[1]?.turn?.tools.map((tool: { name: string }) => tool.name), ['web_fetch']);
});

test('canonical read model dedupes plain local owned-agent runtime and bridge relay duplicates', () => {
  const sessionId = 'session:bridge:humans:plain-duplicate-runtime';
  const responseText = 'The page is a Google Scholar profile for Shu Yang.';
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi check scholar', content: { sender: 'Me', timeLabel: '19:28' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'request' },
      { id: 'msg:local-plain', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'My Kordi', timeLabel: '19:29', thinkingText: '', tools: [] }, status: 'complete', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'local-plain' },
      { id: 'msg:relay-plain', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'My Kordi', timeLabel: '19:29', kind: 'session-relay' }, status: 'complete', sequenceNum: 3, createdAtMs: 2_100, updatedAtMs: 2_100, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'relay-plain' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    '@MyKordi check scholar',
    responseText,
  ]);
  assert.equal(messages[1]?.turn?.id, 'canonical-turn:msg:local-plain');
});

test('canonical read model hides stale bridge processing placeholders after later agent response', () => {
  const sessionId = 'session:bridge:humans:stale-processing';
  const finalText = 'I checked the Scholar page and summarized the visible profile.';
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi check scholar', content: { sender: 'Me', timeLabel: '19:28' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'request' },
      { id: 'msg:processing', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: 'My Kordi', timeLabel: '19:28', kind: 'session-relay', deliveryState: 'read', requestId: 'bridge_req_final' }, status: 'read', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'processing' },
      { id: 'msg:final', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: finalText, content: { sender: 'My Kordi', timeLabel: '19:29', kind: 'session-relay', deliveryState: 'responded', requestId: 'bridge_req_final' }, status: 'complete', sequenceNum: 3, createdAtMs: 10_000, updatedAtMs: 10_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'final' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    '@MyKordi check scholar',
    finalText,
  ]);
});

test('canonical read model hides stale bridge processing placeholders after later no-mention human activity', () => {
  const sessionId = 'session:group:no-mention-after-processing';
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: 20 * 60_000, lastMessageAtMs: 20 * 60_000 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:before', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'plain chat before', content: { sender: 'Me', timeLabel: '12:00' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'before' },
      { id: 'msg:processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '12:01', kind: 'session-relay', deliveryState: 'processing', requestId: 'bridge_req_stale' }, status: 'processing', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'processing' },
      { id: 'msg:image', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '', content: { sender: 'Me', timeLabel: '12:20', attachments: [{ kind: 'image', name: 'Screenshot.png', formatLabel: 'PNG', localPath: '/tmp/Screenshot.png' }] }, status: 'sent', sequenceNum: 3, createdAtMs: 20 * 60_000, updatedAtMs: 20 * 60_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'image-no-mention' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.equal(messages.some((message) => message.turn?.status === 'processing'), false);
  assert.deepEqual(messages.map((message) => message.text || message.attachments?.[0]?.name || message.turn?.assistantText), [
    'plain chat before',
    'Screenshot.png',
  ]);
});

test('canonical read model does not duplicate raw bridge processing when a delegated exchange is already pending', () => {
  const sessionId = 'session:bridge:humans:pending-delegation-processing';
  const now = Date.now();
  const requestId = 'bridge_req_active_pending';
  const exchangeId = `delegation:bridge:${requestId}`;
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: now, lastMessageAtMs: now },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: '@MyKordi how are you', content: { sender: 'Peer', timeLabel: '15:05', direction: 'inbound', requestId }, status: 'sent', sequenceNum: 1, createdAtMs: now - 2_000, updatedAtMs: now - 2_000, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'request' },
      { id: 'msg:raw-processing', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '15:05', kind: 'mention-request', direction: 'outbound-response', deliveryState: 'processing', requestId }, status: 'processing', sequenceNum: 2, createdAtMs: now - 1_000, updatedAtMs: now - 1_000, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'processing' },
    ],
    delegatedExchanges: [
      { id: exchangeId, sessionId, initiatorIdentityId: 'human:peer', targetIdentityId: 'agent:local', triggerMessageId: 'msg:request', requestMessageId: 'msg:request', responseMessageId: null, transport: 'bridge', bridgeHostId: 'host-1', bridgeConversationId: 'bridge:host-1:node-peer:person', bridgeRequestId: requestId, contextPolicy: 'recent-window', status: 'processing', error: null, createdAtMs: now - 2_000, updatedAtMs: now - 1_000 },
    ],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);
  const processingTurns = messages.filter((message) => message.turn?.status === 'processing');

  assert.equal(processingTurns.length, 1);
  assert.equal(processingTurns[0]?.id, `canonical-delegation-processing:${exchangeId}`);
});

test('canonical read model shows fresh bridge-parent processing placeholders for active group agent asks', () => {
  const sessionId = 'session:group:fresh-bridge-parent-processing';
  const now = Date.now();
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: now, lastMessageAtMs: now },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@PeersKordi hi', content: { sender: 'Me', timeLabel: '13:01', direction: 'outbound', deliveryState: 'delivered', requestId: 'bridge_req_active' }, status: 'delivered', sequenceNum: 1, createdAtMs: now - 2_000, updatedAtMs: now - 2_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'request' },
      { id: 'msg:active-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '13:01', kind: 'session-message', direction: 'inbound-response', deliveryState: 'processing', requestId: 'bridge_req_active' }, status: 'processing', sequenceNum: 2, createdAtMs: now - 1_000, updatedAtMs: now - 1_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'active-processing' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.equal(messages.some((message) => message.turn?.status === 'processing'), true);
  assert.equal(messages.find((message) => message.turn?.status === 'processing')?.turn?.message, 'Processing…');
});

test('canonical read model keeps later active processing placeholder when an earlier same-agent request completes', () => {
  const sessionId = 'session:group:parallel-processing-same-agent';
  const now = Date.now();
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: now, lastMessageAtMs: now },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:first-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@PeersKordi check status line', content: { sender: 'Me', timeLabel: '13:12', direction: 'outbound', deliveryState: 'responded', requestId: 'bridge_req_first' }, status: 'complete', sequenceNum: 1, createdAtMs: now - 30_000, updatedAtMs: now - 30_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'first-request' },
      { id: 'msg:first-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '13:12', kind: 'session-message', direction: 'inbound-response', deliveryState: 'processing', requestId: 'bridge_req_first' }, status: 'processing', sequenceNum: 2, createdAtMs: now - 29_000, updatedAtMs: now - 29_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'first-processing' },
      { id: 'msg:second-request', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: '@PeersKordi also check context window fields', content: { sender: 'Peer', timeLabel: '13:12', direction: 'inbound', deliveryState: 'delivered', requestId: 'bridge_req_second' }, status: 'delivered', sequenceNum: 3, createdAtMs: now - 10_000, updatedAtMs: now - 10_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'second-request' },
      { id: 'msg:second-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '13:12', kind: 'session-message', direction: 'inbound-response', deliveryState: 'processing', requestId: 'bridge_req_second' }, status: 'processing', sequenceNum: 4, createdAtMs: now - 9_000, updatedAtMs: now - 9_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'second-processing' },
      { id: 'msg:first-final', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'The status line docs describe how to customize the footer.', content: { sender: "Peer's Kordi", timeLabel: '13:13', kind: 'session-message', direction: 'inbound-response', deliveryState: 'responded', requestId: 'bridge_req_first' }, status: 'complete', sequenceNum: 5, createdAtMs: now - 3_000, updatedAtMs: now - 3_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'first-final' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);
  const processingTurns = messages.filter((message) => message.turn?.status === 'processing');

  assert.equal(processingTurns.length, 1);
  assert.equal(processingTurns[0]?.turn?.id, 'canonical-turn:msg:second-processing');
});

test('canonical read model suppresses stale raw bridge-parent processing placeholders', () => {
  const sessionId = 'session:group:bridge-parent-processing';
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: 5_000, lastMessageAtMs: 5_000 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:hello', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'hello', content: { sender: 'Peer', timeLabel: '12:00' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'hello' },
      { id: 'msg:active-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'Processing...', content: { sender: "Peer's Kordi", timeLabel: '12:01', deliveryState: 'processing', requestId: 'bridge_req_parent_active' }, status: 'processing', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'active-processing' },
      { id: 'msg:cancelled-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '12:02', deliveryState: 'cancelled', requestId: 'bridge_req_parent_cancelled' }, status: 'cancelled', sequenceNum: 3, createdAtMs: 3_000, updatedAtMs: 3_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'cancelled-processing' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), ['hello']);
  assert.equal(messages.some((message) => message.turn?.message === 'Processing…'), false);
});

test('canonical read model suppresses aged bridge session-relay processing placeholders after sync timestamp refreshes', () => {
  const sessionId = 'session:group:aged-session-relay-processing';
  const now = Date.now();
  const oldProcessingTime = now - 20 * 60_000;
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: now, lastMessageAtMs: now },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:hello', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'hello', content: { sender: 'Peer', timeLabel: '12:00' }, status: 'sent', sequenceNum: 1, createdAtMs: oldProcessingTime - 1_000, updatedAtMs: oldProcessingTime - 1_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'hello' },
      { id: 'msg:stale-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '12:01', kind: 'session-relay', direction: 'inbound-response', deliveryState: 'processing', requestId: 'bridge_req_stale' }, status: 'processing', sequenceNum: 2, createdAtMs: oldProcessingTime, updatedAtMs: now, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'stale-processing' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), ['hello']);
  assert.equal(messages.some((message) => message.turn?.status === 'processing'), false);
});

test('canonical read model preserves fresh bridge session-relay processing placeholders', () => {
  const sessionId = 'session:group:fresh-session-relay-processing';
  const now = Date.now();
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: now, lastMessageAtMs: now },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:fresh-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '12:01', kind: 'session-relay', direction: 'inbound-response', deliveryState: 'processing', requestId: 'bridge_req_fresh' }, status: 'processing', sequenceNum: 1, createdAtMs: now - 1_000, updatedAtMs: now, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'fresh-processing' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.equal(messages.some((message) => message.turn?.status === 'processing'), true);
});
