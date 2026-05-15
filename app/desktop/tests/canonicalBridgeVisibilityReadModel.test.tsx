// These fixtures cover Local Edition desktop Bridge read-model compatibility.
// Cloud Edition must not use these source transports as live collaboration transport.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeChatLiveTurnForConversation, visibleLocalSessionIdForActivity } from '../src/app/useKordiDesktopActivity';
import { bridgeChatConversationIsVisible } from '../src/app/useWorkspaceViewModels';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';

test('activity marks bridge-backed chat sessions as visible local sessions for unread clearing', () => {
  assert.equal(visibleLocalSessionIdForActivity({
    activeNav: 'chats',
    activeChatSessionId: '91ecedce-0766-4d34-9b4f-feb572321b22',
    activeProjectSessionId: '',
  }), '91ecedce-0766-4d34-9b4f-feb572321b22');
  assert.equal(visibleLocalSessionIdForActivity({
    activeNav: 'chats',
    activeChatSessionId: 'session:bridge:humans:peer',
    activeProjectSessionId: '',
  }), 'session:bridge:humans:peer');
  assert.equal(visibleLocalSessionIdForActivity({
    activeNav: 'chats',
    activeChatSessionId: 'bridge:host:peer:person',
    activeChatCanonicalSessionId: 'session:bridge:humans:peer',
    activeProjectSessionId: '',
  }), 'session:bridge:humans:peer');
  assert.equal(visibleLocalSessionIdForActivity({
    activeNav: 'chats',
    activeChatSessionId: 'bridge:host:peer:person',
    activeProjectSessionId: '',
  }), null);
});

test('active bridge conversations read live turns from their canonical contact session id', () => {
  const turn = {
    id: 'turn-1',
    sessionId: 'session:bridge:humans:peer',
    prompt: '@Kordi hello',
    status: 'starting',
    message: 'Starting…',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    error: null,
  };

  assert.equal(activeChatLiveTurnForConversation({
    activeConv: {
      id: 'bridge:host:peer:person',
      canonicalSessionId: 'session:bridge:humans:peer',
    },
    desktopLiveTurnsBySession: {
      'session:bridge:humans:peer': turn,
    },
  }), turn);
});

test('canonical read model keeps bridge unread when a local runtime source shares the same session', () => {
  const sessionId = 'session:bridge:humans:shared-unread';
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
      { id: 'msg-peer', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'new unread from bridge', content: { sender: 'Peer', timeLabel: '13:11' }, status: 'sent', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'peer-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const bridgeSource = {
    id: 'bridge:host-1:node-peer:person',
    canonicalSessionId: sessionId,
    name: 'Peer',
    type: 'person',
    subtitle: 'new unread from bridge',
    unread: 1,
    bridgeUnreadByParentSessionId: { [sessionId]: 1 },
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Peer'],
    messages: [{ role: 'person', sender: 'Peer', senderType: 'human', text: 'new unread from bridge', time: '13:11' }],
  };
  const localRuntimeSource = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'Peer',
    type: 'owned-agent',
    subtitle: 'local runtime detail',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'My Kordi'],
    bridgeTarget: { hostId: 'host-1', nodeId: 'node-peer', displayName: 'Peer', ownerName: 'Peer', runtime: 'person' },
    messages: [{ role: 'owned-agent', sender: 'My Kordi', text: 'local tool-rich result', time: '13:10' }],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([bridgeSource as never, localRuntimeSource as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.unread, 1);
});

test('canonical read model hides duplicate local-agent group response fanout copies', () => {
  const sessionId = 'session:group:fanout-agent';
  const responseText = 'same weather answer';
  const readModel = createCanonicalSessionReadModel({
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
      { id: 'human:a', kind: 'human', displayName: 'A', source: 'bridge', avatarKey: 'a', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:b', kind: 'human', displayName: 'B', source: 'bridge', avatarKey: 'b', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:a', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:b', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi weather', content: { sender: 'Me', timeLabel: '10:02' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'request' },
      { id: 'msg:copy-a', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'My Kordi', timeLabel: '10:03', kind: 'session-relay', requestId: 'bridge_req_same', bridgeConversationId: 'bridge:a' }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'copy-a' },
      { id: 'msg:copy-b', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'My Kordi', timeLabel: '10:03', kind: 'session-relay', requestId: 'bridge_req_same', bridgeConversationId: 'bridge:b' }, status: 'complete', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'copy-b' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const messages = readModel?.messages(sessionId) ?? [];
  assert.equal(messages.filter((message) => message.role === 'owned-agent' && message.turn?.assistantText === responseText).length, 1);
});

test('canonical read model keeps canonical parent transcript when bridge source misses an agent response', () => {
  const sessionId = 'session:bridge:humans:flapping-parent';
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
      { id: 'agent:shenzhe', kind: 'agent', displayName: "Shenzhe's Kordi", source: 'bridge', ownerIdentityId: 'human:shenzhe', sourceHostId: 'host-1', bridgeNodeId: 'node-shenzhe', agentId: 'agent-shenzhe', avatarKey: 'agent-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'relationship', title: 'check todays weather', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 5, lastMessageAtMs: 5 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:shenzhe', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:shenzhe', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'person', messageKind: 'text', contentText: '@MyKordi show me the diskusage', content: { sender: 'Shenzhe', timeLabel: '17:30', kind: 'session-relay' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'request' },
      { id: 'msg:response', sessionId, senderIdentityId: 'agent:shenzhe', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'I tried to check disk usage with `df -h`.', content: { sender: "Shenzhe's Kordi", timeLabel: '17:30', kind: 'session-relay' }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const bridgeSourceMissingResponse = {
    id: 'bridge:host-1:node-shenzhe:person',
    canonicalSessionId: 'session:bridge:humans:stable-direct-thread',
    name: 'Shenzhe',
    type: 'person',
    subtitle: 'latest direct person source',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Person outreach',
    participants: ['Me', 'Shenzhe'],
    outreach: { parentSessionId: sessionId },
    messages: [
      { role: 'person', sender: 'Shenzhe', senderType: 'human', text: 'older raw bridge message', time: '17:28' },
      { role: 'person', sender: 'Shenzhe', senderType: 'human', text: '@ShenzhesKordi what is the weather today?', time: '17:29' },
      { role: 'person', sender: 'Shenzhe', senderType: 'human', text: '@MyKordi show me the diskusage', time: '17:30' },
    ],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([bridgeSourceMissingResponse as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(
    conversations[0]?.messages.map((message) => message.text || message.turn?.assistantText),
    ['@ShenzhesKordi show me the diskusage', 'I tried to check disk usage with `df -h`.'],
  );
});

test('canonical read model keeps chat-created bridge agent sessions scoped to their own messages', () => {
  const sessionId = 'session:direct-agent:fresh-thread';
  const canonicalState = {
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
      { id: 'human:owner', kind: 'human', displayName: 'Owner', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-owner', humanId: 'human-owner', avatarKey: 'owner', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:remote', kind: 'agent', displayName: "Owner's Kordi", source: 'bridge', ownerIdentityId: 'human:owner', sourceHostId: 'host-1', bridgeNodeId: 'node-owner', agentId: 'agent-remote', avatarKey: 'agent-remote', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-agent', title: "Owner's Kordi", status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:remote', relationshipIdentityId: null, metadata: { createdFrom: 'chat-create-flow', bridgeHostId: 'host-1', peerNodeId: 'node-owner', peerRuntime: 'kordi-desktop', targetAgentId: 'agent-remote' }, createdAtMs: 10, updatedAtMs: 20, lastMessageAtMs: 20 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 10 },
      { sessionId, identityId: 'agent:remote', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 10 },
      { sessionId, identityId: 'human:owner', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 20 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'fresh private question', content: { sender: 'Me', timeLabel: '14:11' }, status: 'sent', sequenceNum: 1, createdAtMs: 11, updatedAtMs: 11, contentHash: null, sourceTransport: 'desktop-bridge-ui', sourceEventId: 'request' },
      { id: 'msg:response', sessionId, senderIdentityId: 'agent:remote', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'fresh private answer', content: { sender: "Owner's Kordi", timeLabel: '14:11' }, status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const staleBridgeAgentSource = {
    id: 'bridge:host-1:node-owner',
    canonicalSessionId: undefined,
    name: "Owner's Kordi",
    type: 'external-agent',
    subtitle: 'Agent outreach • previous raw bridge store',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Agent outreach',
    participants: ['Me', 'Owner', "Owner's Kordi"],
    outreach: { parentSessionId: sessionId },
    messages: [
      { role: 'external-agent', sender: "Owner's Kordi", senderType: 'agent', text: '', turn: { id: 'old-turn', sessionId: 'bridge:host-1:node-owner', prompt: '', status: 'complete', message: 'Complete', assistantText: 'stale group answer', thinkingText: '', tools: [], completed: true, succeeded: true, error: null }, time: '12:20' },
      { role: 'user', sender: 'Me', senderType: 'human', text: 'fresh private question', time: '14:11' },
      { role: 'external-agent', sender: "Owner's Kordi", senderType: 'agent', text: '', turn: { id: 'fresh-turn', sessionId: 'bridge:host-1:node-owner', prompt: '', status: 'complete', message: 'Complete', assistantText: 'fresh private answer', thinkingText: '', tools: [], completed: true, succeeded: true, error: null }, time: '14:11' },
    ],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([staleBridgeAgentSource as never], (messages, fallback) => messages[0]?.text || messages[0]?.turn?.assistantText || fallback || '') ?? [];
  const conversation = conversations.find((candidate) => candidate.id === sessionId);

  assert.deepEqual(
    conversation?.messages.map((message) => message.text || message.turn?.assistantText),
    ['fresh private question', 'fresh private answer'],
  );
  assert.deepEqual(conversation?.participants, ['Me', "Owner's Kordi"]);
  assert.equal(conversation?.directness, 'Direct chat');
});

test('canonical read model does not show processing for bridge agent outreach without a sent bridge request', () => {
  const sessionId = 'session:direct-agent:stale-outreach';
  const canonicalState = {
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
      { id: 'human:testuser2', kind: 'human', displayName: 'testuser2', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser2', humanId: 'human-testuser2', avatarKey: 'human-testuser2', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:testuser2', kind: 'agent', displayName: "testuser2's Kordi", source: 'bridge', ownerIdentityId: 'human:testuser2', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser2', agentId: 'agent-testuser2', avatarKey: 'agent-testuser2', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-agent', title: "testuser2's Kordi", status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:testuser2', relationshipIdentityId: null, metadata: { createdFrom: 'chat-create-flow', bridgeHostId: 'host-1', peerNodeId: 'node-testuser2', peerRuntime: 'kordi-desktop', targetAgentId: 'agent-testuser2' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:testuser2', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello', content: { sender: 'Me', timeLabel: '02:26' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-ui', sourceEventId: 'request' },
    ],
    delegatedExchanges: [{
      id: 'delegation:bridge:unsent',
      sessionId,
      initiatorIdentityId: 'human:me',
      targetIdentityId: 'agent:testuser2',
      triggerMessageId: 'msg:request',
      requestMessageId: 'msg:request',
      responseMessageId: null,
      transport: 'bridge',
      bridgeHostId: 'host-1',
      bridgeConversationId: 'bridge:host-1:node-testuser2:kordi-desktop',
      bridgeRequestId: null,
      contextPolicy: 'recent-window',
      status: 'processing',
      error: null,
      createdAtMs: 2,
      updatedAtMs: 2,
    }],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.messages.some((message) => message.turn?.status === 'processing'), false);
});

test('canonical read model marks bridge mention requests failed when remote agent fails without a response', () => {
  const sessionId = 'session:bridge:humans:failed-delegation';
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
      { id: 'human:testuser3', kind: 'human', displayName: 'Testuser3', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser3', humanId: 'human-testuser3', avatarKey: 'human-testuser3', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:testuser3', kind: 'agent', displayName: "Testuser3's Kordi", source: 'bridge', ownerIdentityId: 'human:testuser3', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser3-agent', agentId: 'agent-testuser3', avatarKey: 'agent-testuser3', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'relationship', title: 'can you see our chat history ?', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:testuser3', relationshipIdentityId: 'human:testuser3', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-testuser3', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 5, lastMessageAtMs: 5 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:testuser3', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:testuser3', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@Testuser3sKordi can you see our chat history ?', content: { sender: 'Me', timeLabel: '00:45', mentions: [{ label: 'Testuser3sKordi', targetKind: 'bridge-agent', nodeId: 'node-testuser3-agent' }] }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-ui', sourceEventId: 'request' },
      { id: 'msg:join', sessionId, senderIdentityId: 'human:me', senderRole: 'system', messageKind: 'status', contentText: "Testuser3's Kordi joined via @mention", content: { kind: 'delegation-join-event', targetDisplayName: "Testuser3's Kordi" }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'join' },
    ],
    delegatedExchanges: [{
      id: 'delegation:bridge:failed',
      sessionId,
      initiatorIdentityId: 'human:me',
      targetIdentityId: 'agent:testuser3',
      triggerMessageId: 'msg:request',
      requestMessageId: 'msg:request',
      responseMessageId: null,
      transport: 'bridge',
      bridgeHostId: 'host-1',
      bridgeConversationId: 'bridge:host-1:node-testuser3:kordi-desktop',
      bridgeRequestId: 'bridge_req_failed',
      contextPolicy: 'recent-window',
      status: 'failed',
      error: 'ChatGPT OAuth credentials are not usable',
      createdAtMs: 2,
      updatedAtMs: 3,
    }],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(conversations[0]?.messages[0]?.statusChips, ['failed']);
  assert.equal(conversations[0]?.messages.some((message) => message.text.includes('ChatGPT OAuth credentials')), false);
});

test('canonical read model hides bridge agent failure detail behind a generic failed turn', () => {
  const sessionId = 'session:bridge:humans:remote-agent-failure';
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
      { id: 'human:testuser2', kind: 'human', displayName: 'Testuser2', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser2', humanId: 'human-testuser2', avatarKey: 'human-testuser2', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', sourceHostId: 'host-1', bridgeNodeId: 'node-local-agent', agentId: 'agent-local', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'relationship', title: 'can you see our chat history ?', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:testuser2', relationshipIdentityId: 'human:testuser2', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-testuser2', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 5, lastMessageAtMs: 5 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:testuser2', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:testuser2', senderRole: 'person', messageKind: 'text', contentText: '@MyKordi can you see our chat history ?', content: { sender: 'Testuser2', timeLabel: '00:45', kind: 'mention-request' }, status: 'read', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'request' },
      { id: 'msg:failed-response', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Failed: ChatGPT OAuth credentials are not usable. Sign in to ChatGPT again.', content: { sender: 'My Kordi', timeLabel: '00:45', deliveryState: 'processing_failed', delegatedExchangeId: 'delegation:bridge:failed' }, status: 'failed', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'failed-response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const turn = conversations[0]?.messages[1]?.turn;

  assert.equal(turn?.status, 'failed');
  assert.equal(turn?.assistantText, '');
  assert.equal(turn?.error, 'Message failed');
  assert.equal(JSON.stringify(conversations[0]?.messages).includes('ChatGPT OAuth credentials'), false);
});

test('canonical read model rewrites remote first-person agent mention labels', () => {
  const sessionId = 'session:bridge:humans:remote-local-agent-label';
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
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'show me the diskusage', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:shenzhe', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:remote-mention', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'person', messageKind: 'text', contentText: '@MyKordi  show me the diskusage', content: { sender: 'Shenzhe', timeLabel: '17:30', kind: 'session-relay' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'remote-mention-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.messages[0]?.text, '@ShenzhesKordi show me the diskusage');
});

test('canonical read model suppresses local agent runtime user echo after bridge UI mention', () => {
  const sessionId = 'session:bridge:humans:shared-local-agent';
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
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-bob', humanId: 'human-bob', avatarKey: 'human-bob', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'show me the diskusage', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:ui', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi  show me the diskusage', content: { sender: 'Me', timeLabel: '17:30' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'desktop-chat-ui:shared-local-agent:1000' },
      { id: 'msg:runtime-user', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@Kordi  show me the diskusage', content: { sender: 'You', timeLabel: '17:30' }, status: 'sent', sequenceNum: 2, createdAtMs: 1_023, updatedAtMs: 1_023, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'desktop-chat:shared-local-agent:2:1023:user:hash' },
      { id: 'msg:agent', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'disk usage result', content: { sender: 'Kordi', timeLabel: '17:30' }, status: 'sent', sequenceNum: 3, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'desktop-chat:shared-local-agent:3:assistant:turn' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(
    conversations[0]?.messages.map((message) => message.text || message.turn?.assistantText),
    ['@MyKordi  show me the diskusage', 'disk usage result'],
  );
});

test('canonical read model strips remote external-agent tool details from canonical messages', () => {
  const sessionId = 'session:bridge:humans:remote-tools';
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
      { id: 'agent:bob', kind: 'agent', displayName: 'Bob Kordi', source: 'bridge', ownerIdentityId: 'human:bob', sourceHostId: 'host-1', bridgeNodeId: 'node-shared', agentId: 'agent-bob', avatarKey: 'agent-bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'hi bob', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:remote-agent', sessionId, senderIdentityId: 'agent:bob', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'remote answer', content: { sender: 'Bob Kordi', timeLabel: '13:30', thinkingText: 'remote private thinking', tools: [{ name: 'read', input: '{}', output: 'secret' }] }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'remote-agent-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.messages[0]?.turn?.assistantText, 'remote answer');
  assert.equal(conversations[0]?.messages[0]?.turn?.thinkingText, '');
  assert.deepEqual(conversations[0]?.messages[0]?.turn?.tools, []);
});

test('canonical read model does not override bridge agent runtime details with canonical messages', () => {
  const sessionId = 'session:bridge:agents:shared-agent';
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
      { id: 'agent:bob', kind: 'agent', displayName: 'Bob agent', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-agent', agentId: 'agent-bob', avatarKey: 'agent-bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-agent', title: 'Bob agent', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:bob', relationshipIdentityId: null, metadata: { source: 'desktop-bridge-conversation', bridgeHostId: 'host-1', peerNodeId: 'node-agent', peerRuntime: 'kordi-desktop' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:stale', sessionId, senderIdentityId: 'agent:bob', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'stale canonical answer', content: { sender: 'Bob agent', timeLabel: '13:28' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge', sourceEventId: 'agent-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const runtimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'Bob agent',
    type: 'external-agent',
    subtitle: '',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Agent thread',
    participants: ['Me', 'Bob agent'],
    messages: [{
      role: 'external-agent',
      sender: 'Bob agent',
      text: 'active runtime details',
      time: '13:29',
      turn: { thinkingText: 'thinking', tools: [{ name: 'read' }] },
    }],
  };

  const conversations = readModel?.buildChatConversations([runtimeConversation as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(conversations[0]?.messages.map((message) => message.text), ['active runtime details']);
});

test('canonical read model excludes left group participants from active conversations', () => {
  const canonicalState = {
    storagePath: '/tmp/canonical.db',
    profile: {
      id: 'profile:local',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
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
      { id: 'session:group:left', kind: 'group', title: 'Alice, Bob', status: 'active', createdByIdentityId: 'human:me', metadata: {}, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId: 'session:group:left', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:left', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:left', identityId: 'human:bob', role: 'person', state: 'left', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const group = conversations.find((conversation) => conversation.id === 'session:group:left');

  assert.deepEqual(group?.canonicalParticipants?.map((participant) => participant.name), ['Me', 'Alice']);
});

test('canonical read model preserves group space when hydrating from a bridge outreach source', () => {
  const canonicalState = {
    storagePath: '/tmp/canonical.db',
    profile: {
      id: 'profile:local',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', avatarKey: 'bob', humanId: 'kh_bob', bridgeNodeId: 'kd_bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:group:invite',
        kind: 'group',
        title: 'Group',
        status: 'active',
        createdByIdentityId: 'human:me',
        metadata: { groupSpaceId: 'session:group:invite', source: 'bridge-session-thread' },
        createdAtMs: 1,
        updatedAtMs: 2,
        lastMessageAtMs: 2,
      },
    ],
    participants: [
      { sessionId: 'session:group:invite', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:invite', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      {
        id: 'msg:group-invite',
        sessionId: 'session:group:invite',
        senderIdentityId: 'human:bob',
        senderRole: 'person',
        messageKind: 'text',
        contentText: 'hi everyone',
        content: { sender: 'Bob', timeLabel: '13:27' },
        status: 'sent',
        sequenceNum: 1,
        createdAtMs: 2,
        updatedAtMs: 2,
        contentHash: null,
        sourceTransport: 'desktop-bridge-parent',
        sourceEventId: 'bridge-group-1',
      },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const bridgeSource = {
    id: 'bridge:host:bob:person',
    canonicalSessionId: 'session:bridge:humans:bob',
    name: 'Bob',
    type: 'person',
    subtitle: 'hi everyone',
    unread: 1,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Me', 'Bob'],
    outreach: { parentSessionId: 'session:group:invite' },
    bridgeUnreadByParentSessionId: { 'session:group:invite': 1 },
    messages: [{ role: 'person', sender: 'Bob', text: 'hi everyone', time: '13:27' }],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([bridgeSource as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const group = conversations.find((conversation) => conversation.id === 'session:group:invite');
  const spaces = buildParticipantSpaces(conversations as never);

  assert.equal(group?.participantSpaceId, 'session:group:invite');
  assert.equal(spaces[0]?.kind, 'group');
  assert.equal(spaces[0]?.id, 'group:session:group:invite');
});

test('bridge chat visibility keeps empty conversations returned by backend state', () => {
  assert.equal(bridgeChatConversationIsVisible({
    outreach: null,
    messages: [],
    peerDisplayName: null,
    peerOwnerName: null,
  }), true);
});
