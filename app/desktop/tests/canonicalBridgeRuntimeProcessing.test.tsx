// These fixtures cover Local Edition desktop Bridge read-model compatibility.
// Hosted collaboration must not use these legacy source transports.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: now, lastMessageAtMs: now },
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
      { id: exchangeId, sessionId, initiatorIdentityId: 'human:peer', targetIdentityId: 'agent:local', triggerMessageId: 'msg:request', requestMessageId: 'msg:request', responseMessageId: null, transport: 'bridge', sourceHostId: 'host-1', sourceConversationId: 'bridge:host-1:node-peer:person', sourceRequestId: requestId, contextPolicy: 'recent-window', status: 'processing', error: null, createdAtMs: now - 2_000, updatedAtMs: now - 1_000 },
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', sourceIdentityId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
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
