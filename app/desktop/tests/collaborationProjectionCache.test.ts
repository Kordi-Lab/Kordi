import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { createCollaborationConversationMapper } from '../src/features/collaboration/conversationProjectionCache';
import { COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS } from '../src/features/collaboration/collaborationProcessingState';
import type { DesktopCollaborationHost } from '../src/kordi-app/types';
import { buildScaleCollaborationConversation } from './fixtures/chatScale';

const start = Date.parse('2026-09-09T12:00:00Z');
const host = { id: 'fixture-host', serverUrl: 'https://example.test', ownerName: 'Owner', displayName: 'Owner',
  nodeId: 'owner', humanId: 'owner', profileImageUrl: null, agents: [], visiblePeers: [], projects: [],
} as unknown as DesktopCollaborationHost;

function conversation(id = 'chat-a') {
  const source = buildScaleCollaborationConversation();
  return { ...source, id, peerRuntime: 'person', awaitingReply: false, messages: [{
    id: 'first', direction: 'outbound', sender: 'Me', text: 'First message', timeLabel: '12:00',
    timestampMs: start, deliveryState: 'delivered',
  }] };
}

test('a send preserves other chat projections and accepts equivalent host snapshots', () => {
  const map = createCollaborationConversationMapper();
  const first = conversation();
  const other = conversation('chat-b');
  const a = map(first, host, 'Kordi', start);
  const b = map(other, host, 'Kordi', start);
  assert.strictEqual(map(first, { ...host, agents: [], visiblePeers: [] }, 'Kordi', start + 1), a);
  const sent = { ...first, messages: [...first.messages, { ...first.messages[0], id: 'second', text: 'Second message' }] };
  const next = map(sent, host, 'Kordi', start + 2);
  assert.notStrictEqual(next, a);
  assert.equal(next.messages.length, a.messages.length + 1);
  assert.strictEqual(map(other, host, 'Kordi', start + 2), b);
  const read = { ...sent, messages: sent.messages.map(message => ({ ...message, deliveryState: 'read' })) };
  assert.deepEqual(map(read, host, 'Kordi', start + 3), mapCollaborationConversationToViewModel(read, host, 'Kordi', start + 3));
});

test('host identity, avatar, and agent label updates invalidate cached projections', () => {
  const map = createCollaborationConversationMapper();
  const source = conversation();
  const a = map(source, host, 'Kordi', start);
  const changedHost = { ...host, ownerName: 'Updated owner', profileImageUrl: 'https://example.test/avatar.png' };
  const b = map(source, changedHost, 'Kordi', start);
  assert.notStrictEqual(b, a);
  assert.deepEqual(b, mapCollaborationConversationToViewModel(source, changedHost, 'Kordi', start));
  const c = map(source, changedHost, 'Updated agent', start);
  assert.notStrictEqual(c, b);
});

test('pending reply expiry and clock reversal cannot reuse stale processing state', () => {
  const map = createCollaborationConversationMapper();
  const source = { ...conversation(), awaitingReply: true, messages: [
    { ...conversation().messages[0], requestId: 'request', deliveryState: 'delivered' },
    { id: 'response', direction: 'inbound-response', sender: 'Agent', text: 'processing...', timeLabel: '12:00',
      timestampMs: start, requestId: 'request', deliveryState: 'processing' },
  ] };
  const a = map(source, host, 'Kordi', start);
  assert.strictEqual(map(source, host, 'Kordi', start + 1), a);
  const expiredAt = start + COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS;
  const expired = map(source, host, 'Kordi', expiredAt);
  assert.notStrictEqual(expired, a);
  assert.deepEqual(expired, mapCollaborationConversationToViewModel(source, host, 'Kordi', expiredAt));
  assert.deepEqual(map(source, host, 'Kordi', start), mapCollaborationConversationToViewModel(source, host, 'Kordi', start));
});
