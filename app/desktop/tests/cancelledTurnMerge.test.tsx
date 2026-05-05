import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

test('cancelled local turn with tools but empty text dedupes against canonical desktop-chat row', () => {
  const sessionId = 'session:group:cancel-test';
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
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', metadata: { source: 'bridge-session-thread' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      // The user message that triggered the agent.
      { id: 'msg:user:1', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi search', content: { sender: 'Me', timeLabel: '16:42' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'user-1' },
      // Canonical desktop-chat row for the cancelled agent turn (empty assistant text, has tools).
      { id: 'msg:agent:desktop-chat', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '', content: { sender: 'Kordi', timeLabel: '16:43', tools: [{ id: 'call_abc', name: 'web_search', status: 'done' }] }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'agent-1' },
      // Canonical bridge-relay row representing the bridge fanout outcome (failed).
      { id: 'msg:agent:bridge-relay', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Processing failed', content: { sender: "Kordi User 3's Kordi", timeLabel: '16:43', deliveryState: 'processing_failed' }, status: 'failed', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'agent-relay-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  // The legacy desktop-chat snapshot has a local agent message for the same turn — same tool, empty text.
  const localRuntimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'Group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Group chat',
    participants: ['Me'],
    messages: [{
      role: 'owned-agent',
      sender: 'My Kordi',
      text: '',
      time: '16:43',
      turn: {
        id: 'local-turn-1',
        sessionId,
        prompt: '',
        status: 'cancelled',
        message: 'Stopped',
        assistantText: '',
        thinkingText: '',
        tools: [{ id: 'call_abc', name: 'web_search', status: 'done' }],
        completed: true,
        succeeded: false,
        error: null,
      },
    }],
  };

  const conversations = readModel?.buildChatConversations(
    [localRuntimeConversation as never],
    (messages, fallback) => messages[0]?.text ?? fallback ?? '',
  ) ?? [];

  const ownedAgentMessages = (conversations[0]?.messages ?? []).filter((message) => message.role === 'owned-agent');
  // Expectation: exactly ONE owned-agent row survives — the desktop-chat row (replaced by the local snapshot).
  // The bridge-relay status marker must be deduped, and the local snapshot must NOT be appended.
  assert.equal(ownedAgentMessages.length, 1, `expected 1 owned-agent row, got ${ownedAgentMessages.length}`);
});

test('cancelled local turn with thinking but no tools or text dedupes via thinking signature', () => {
  const sessionId = 'session:group:thinking-only';
  const thinkingText = '**Looking for answers**\n\nI realize I need to find an answer about coffee shops in Thuwal.';
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
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', metadata: { source: 'bridge-session-thread' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:user:1', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi find coffee', content: { sender: 'Me', timeLabel: '17:35' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'user-1' },
      { id: 'msg:agent:desktop-chat', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '', content: { sender: 'Kordi', timeLabel: '17:35', thinkingText, tools: [] }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'agent-1' },
      { id: 'msg:agent:bridge-relay', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Processing failed', content: { sender: "Kordi User 2's Kordi", timeLabel: '17:35', deliveryState: 'processing_failed' }, status: 'failed', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'agent-relay-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const localRuntimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'Group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Group chat',
    participants: ['Me'],
    messages: [{
      role: 'owned-agent',
      sender: 'My Kordi',
      text: '',
      time: '17:35',
      turn: {
        id: 'local-turn-1',
        sessionId,
        prompt: '',
        status: 'cancelled',
        message: 'Stopped',
        assistantText: '',
        thinkingText,
        tools: [],
        completed: true,
        succeeded: false,
        error: null,
      },
    }],
  };

  const conversations = readModel?.buildChatConversations(
    [localRuntimeConversation as never],
    (messages, fallback) => messages[0]?.text ?? fallback ?? '',
  ) ?? [];

  const ownedAgentMessages = (conversations[0]?.messages ?? []).filter((message) => message.role === 'owned-agent');
  assert.equal(ownedAgentMessages.length, 1, `expected 1 owned-agent row, got ${ownedAgentMessages.length}`);
});

test('in-flight processing bridge-relay placeholder is deduped against a paired desktop-chat sibling', () => {
  const sessionId = 'session:group:processing-test';
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
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', metadata: { source: 'bridge-session-thread' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:user:1', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi run a tool', content: { sender: 'Me', timeLabel: '22:43' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'user-1' },
      // Active local desktop-chat agent-turn (live but already persisted with thinking).
      { id: 'msg:agent:desktop-chat', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '', content: { sender: 'Kordi', timeLabel: '22:43', thinkingText: 'Looking up the directory.', deliveryState: 'processing' }, status: 'processing', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'agent-1' },
      // Pure status placeholder from the bridge fanout — same agent identity, in-flight processing.
      { id: 'msg:agent:bridge-relay', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Kordi User 4's Kordi", timeLabel: '22:43', deliveryState: 'processing' }, status: 'processing', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'agent-relay-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations(
    [{
      id: sessionId,
      canonicalSessionId: sessionId,
      name: 'Group',
      type: 'owned-agent',
      subtitle: '',
      unread: 0,
      bridges: ['Local'],
      trust: 'Owned',
      directness: 'Group chat',
      participants: ['Me'],
      messages: [],
    } as never],
    (messages, fallback) => messages[0]?.text ?? fallback ?? '',
  ) ?? [];
  const ownedAgentMessages = (conversations[0]?.messages ?? []).filter((message) => message.role === 'owned-agent');
  assert.equal(ownedAgentMessages.length, 1, `expected 1 owned-agent row, got ${ownedAgentMessages.length}`);
});
