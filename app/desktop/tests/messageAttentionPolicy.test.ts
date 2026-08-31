import assert from 'node:assert/strict';
import test from 'node:test';

import type { Conversation, Message } from '../src/kordi-app/types';
import {
  messageAttentionSnapshot,
  newMessageAttentionEvents,
  notificationNumericId,
  shouldRequestDockAttention,
} from '../src/features/notifications/messageAttentionPolicy';

function conversation(messages: Message[], unread = 0): Conversation {
  return {
    id: 'conversation-1',
    canonicalSessionId: 'session-1',
    name: 'Maya',
    type: 'person',
    subtitle: '',
    unread,
    collaborationSources: [],
    trust: '',
    directness: '',
    participants: [],
    messages,
  };
}

test('new committed incoming messages create one attention event', () => {
  const first = conversation([{ id: 'm1', role: 'person', sender: 'Maya', text: 'First', time: '' }], 1);
  const previous = messageAttentionSnapshot([first]);
  const second = conversation([
    ...first.messages,
    { id: 'm2', role: 'person', sender: 'Maya', text: '  Hello\nthere ', time: '' },
  ], 2);
  assert.deepEqual(newMessageAttentionEvents({ previous, conversations: [second] }), [{
    eventId: 'm2',
    sessionId: 'session-1',
    messageId: 'm2',
    title: 'Maya',
    previewText: 'Hello there',
    unreadCount: 2,
  }]);
});

test('notification previews never expose known Blob Emoji tokens', () => {
  const incoming = conversation([{ id: 'm1', role: 'person', sender: 'Maya', text: 'Hi :blob:blobwave:', time: '' }], 1);
  assert.equal(
    newMessageAttentionEvents({ previous: {}, conversations: [incoming] })[0]?.previewText,
    'Hi Emoji',
  );
});

test('replay, own messages, and read conversations do not notify', () => {
  const incoming = conversation([{ id: 'm1', role: 'person', text: 'First', time: '' }], 1);
  const previous = messageAttentionSnapshot([incoming]);
  assert.deepEqual(newMessageAttentionEvents({ previous, conversations: [incoming] }), []);
  const own = conversation([...incoming.messages, {
    id: 'm2', role: 'user', isOwnMessage: true, text: 'Reply', time: '',
  }], 0);
  assert.deepEqual(newMessageAttentionEvents({ previous, conversations: [own] }), []);
});

test('a new unread conversation notifies after the initial snapshot is ready', () => {
  const incoming = conversation([{ id: 'm1', role: 'person', text: 'First', time: '' }], 1);
  assert.equal(newMessageAttentionEvents({ previous: {}, conversations: [incoming] }).length, 1);
});

test('an unread update still notifies when message data arrived first', () => {
  const incoming = conversation([{ id: 'm1', role: 'person', text: 'First', time: '' }], 0);
  const previous = messageAttentionSnapshot([incoming]);
  assert.equal(newMessageAttentionEvents({
    previous,
    conversations: [conversation(incoming.messages, 1)],
  }).length, 1);
});

test('native notification ids are stable signed 32-bit values', () => {
  assert.equal(notificationNumericId('message-1'), notificationNumericId('message-1'));
  assert.notEqual(notificationNumericId('message-1'), notificationNumericId('message-2'));
});

test('Dock attention requests one background bounce per burst', () => {
  assert.equal(shouldRequestDockAttention({
    enabled: true,
    windowFocused: false,
    lastRequestedAt: 0,
    now: 10_000,
    minimumIntervalMs: 2_000,
  }), true);
  assert.equal(shouldRequestDockAttention({
    enabled: true,
    windowFocused: false,
    lastRequestedAt: 9_000,
    now: 10_000,
    minimumIntervalMs: 2_000,
  }), false);
  assert.equal(shouldRequestDockAttention({
    enabled: true,
    windowFocused: true,
    lastRequestedAt: 0,
    now: 10_000,
    minimumIntervalMs: 2_000,
  }), false);
});
