// These fixtures cover Local Edition desktop Bridge read-model compatibility.
// Hosted collaboration must not use these legacy source transports.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

test('canonical read model replaces pending delegation placeholder with active local runtime progress', () => {
  const sessionId = 'session:bridge:humans:active-local-progress';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Alice',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: "Alice's Kordi", source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Bob', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2_000, lastMessageAtMs: 2_000 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:earlier-own', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hi how are you', content: { sender: 'You', timeLabel: '11:37' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'own' },
      { id: 'msg:request', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: '@AlicesKordi how are you', content: { sender: 'Bob', timeLabel: '11:38', kind: 'mention-request' }, status: 'complete', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'request' },
    ],
    delegatedExchanges: [
      { id: 'delegation:pending', sessionId, initiatorIdentityId: 'human:peer', targetIdentityId: 'agent:local', triggerMessageId: 'msg:request', requestMessageId: 'msg:request', responseMessageId: null, transport: 'bridge', sourceHostId: 'host-1', sourceConversationId: 'bridge:host-1:node-peer:person', sourceRequestId: 'bridge_req_pending', contextPolicy: 'recent-window', status: 'processing', error: null, createdAtMs: 2_000, updatedAtMs: 2_100 },
    ],
    presence: [],
    contextSnapshots: [],
  };
  const localRuntimeConversation = {
    id: 'bridge:host-1:node-peer:person',
    canonicalSessionId: sessionId,
    name: 'Bob',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [
      {
        id: 'collaboration-message:runtime-progress',
        role: 'owned-agent',
        sender: 'My Kordi',
        text: '',
        time: '11:38',
        replyToMessageId: 'collaboration-message:stale-local-id',
        turn: {
          id: 'collaboration-live-turn:runtime-progress',
          sessionId: 'bridge:host-1:node-peer:person',
          prompt: '',
          status: 'thinking',
          message: 'Thinking…',
          assistantText: '',
          thinkingText: 'Considering the greeting',
          tools: [],
          completed: false,
          succeeded: false,
          error: null,
          replyToMessageId: 'collaboration-message:stale-local-id',
        },
      },
    ],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversation = readModel?.applyConversation(localRuntimeConversation as never, (messages, fallback) => messages.at(-1)?.turn?.message ?? fallback ?? '');
  const agentTurns = conversation?.messages.filter((message) => message.turn && !message.turn.completed) ?? [];

  assert.equal(agentTurns.length, 1);
  assert.equal(agentTurns[0]?.id?.startsWith('canonical-delegation-processing:'), true);
  assert.equal(agentTurns[0]?.replyToMessageId, 'msg:request');
  assert.equal(agentTurns[0]?.turn?.replyToMessageId, 'msg:request');
  assert.equal(agentTurns[0]?.turn?.thinkingText, 'Considering the greeting');
  assert.deepEqual(conversation?.messages.map((message) => message.id), [
    'msg:earlier-own',
    'msg:request',
    agentTurns[0]?.id,
  ]);
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
      { id: 'human:peer', kind: 'human', displayName: 'Testuser6', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
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
    collaborationSources: ['Local'],
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
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
  const responseText = 'The page is a Google Scholar profile for Alex Morgan.';
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
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
