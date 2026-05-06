import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAttachments } from '../src/features/canonical/readModel/messageMapping';
import {
  appendOptimisticBridgeMessage,
  bridgeAttachmentTransportFields,
  failedPreparedCanonicalUserMessage,
  markOptimisticBridgeMessageFailed,
  markOptimisticCanonicalMessageFailed,
  prepareCanonicalUserMessage,
  toOptimisticAttachments,
} from '../src/features/chat/messageActions/optimistic';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const imageAttachment = {
  id: 'first',
  name: 'Screenshot 1.png',
  path: '/tmp/pi-clipboard-1.png',
  kind: 'image' as const,
  formatLabel: 'PNG',
  sizeBytes: 4096,
};
const fileAttachment = {
  id: 'second',
  name: 'notes.txt',
  path: '/Users/shuyang/Desktop/notes-temp-uuid.txt',
  kind: 'file' as const,
  formatLabel: 'TXT',
};

test('bridgeAttachmentTransportFields sends current attachment paths and display names', () => {
  const fields = bridgeAttachmentTransportFields([imageAttachment, fileAttachment]);

  assert.deepEqual(fields, {
    attachmentPaths: ['/tmp/pi-clipboard-1.png', '/Users/shuyang/Desktop/notes-temp-uuid.txt'],
    attachmentNames: ['Screenshot 1.png', 'notes.txt'],
  });
});

test('optimistic attachments keep local paths so the sender sees image previews before sync returns', () => {
  assert.deepEqual(toOptimisticAttachments([imageAttachment]), [{
    kind: 'image',
    name: 'Screenshot 1.png',
    formatLabel: 'PNG',
    previewUrl: undefined,
    mimeType: undefined,
    localPath: '/tmp/pi-clipboard-1.png',
    sizeBytes: 4096,
  }]);
});

test('canonical attachment mapping preserves local paths for image previews', () => {
  assert.deepEqual(canonicalAttachments([{
    kind: 'image',
    name: 'Screenshot 1.png',
    formatLabel: 'PNG',
    mimeType: 'image/png',
    localPath: '/tmp/pi-clipboard-1.png',
    sizeBytes: 4096,
  }]), [{
    kind: 'image',
    name: 'Screenshot 1.png',
    formatLabel: 'PNG',
    previewUrl: null,
    mimeType: 'image/png',
    localPath: '/tmp/pi-clipboard-1.png',
    sizeBytes: 4096,
  }]);
});

test('attachment-only bridge optimistic messages render as attachment cards without summary text', () => {
  const next = appendOptimisticBridgeMessage({
    configPath: '/tmp/config.json',
    legacyConfigPath: '/tmp/legacy.json',
    conversationsPath: '/tmp/conversations.sqlite3',
    activeHostId: 'host-1',
    hosts: [],
    localServer: { running: false },
    conversations: [{
      id: 'bridge:host-1:peer-1:person',
      hostId: 'host-1',
      peerNodeId: 'peer-1',
      peerRuntime: 'person',
      title: 'Peer',
      subtitle: 'Peer',
      unreadCount: 0,
      updatedAtMs: 1,
      updatedAtLabel: '12:00',
      awaitingReply: false,
      peerTyping: false,
      messages: [],
    }],
  }, 'bridge:host-1:peer-1:person', '', '12:31', 'pending-1', [imageAttachment], 'Attached Screenshot 1.png');

  const conversation = next?.conversations[0];
  assert.equal(conversation?.subtitle, 'Attached Screenshot 1.png');
  assert.equal(conversation?.messages[0]?.text, '');
  assert.equal(conversation?.messages[0]?.attachments?.[0]?.localPath, '/tmp/pi-clipboard-1.png');
});

test('canonical optimistic bridge messages can be marked failed for visible send errors', () => {
  const state = {
    sessions: [{ id: 'session-1', updatedAtMs: 1, lastMessageAtMs: 1 }],
    messages: [{
      id: 'msg-1',
      sessionId: 'session-1',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'hello',
      content: { sender: 'Me', timeLabel: '12:31' },
      parentMessageId: null,
      delegatedExchangeId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      contentHash: null,
      sourceTransport: 'desktop-bridge-ui',
      sourceEventId: 'desktop-bridge-ui:session-1:1',
    }],
  } as unknown as CanonicalSessionState;

  const next = markOptimisticCanonicalMessageFailed(
    state,
    'session-1',
    'msg-1',
    'Contact request was rejected, so messages are blocked.',
  );
  const [message] = next?.messages ?? [];

  assert.equal(message?.status, 'failed');
  assert.equal((message?.content as { deliveryState?: string }).deliveryState, 'failed');
  assert.equal((message?.content as { detail?: string }).detail, 'Contact request was rejected, so messages are blocked.');
});


test('failed prepared canonical bridge messages preserve attachment-only sends for persistence', () => {
  const prepared = prepareCanonicalUserMessage(
    'session-1',
    'human:me',
    '',
    [imageAttachment],
    '12:31',
    'desktop-bridge-ui',
    'sending',
  );

  const failed = failedPreparedCanonicalUserMessage(prepared, 'Contact request was rejected, so messages are blocked.');

  assert.equal(failed?.request.status, 'failed');
  assert.equal(failed?.request.contentText, '');
  assert.equal((failed?.request.content as { deliveryState?: string }).deliveryState, 'failed');
  assert.equal((failed?.request.content as { detail?: string }).detail, 'Contact request was rejected, so messages are blocked.');
  assert.equal(((failed?.request.content as { attachments?: Array<{ localPath?: string }> }).attachments ?? [])[0]?.localPath, '/tmp/pi-clipboard-1.png');
});


test('bridge optimistic messages keep the send failure detail inline', () => {
  const next = markOptimisticBridgeMessageFailed({
    configPath: '/tmp/config.json',
    legacyConfigPath: '/tmp/legacy.json',
    conversationsPath: '/tmp/conversations.sqlite3',
    activeHostId: 'host-1',
    hosts: [],
    localServer: { running: false },
    conversations: [{
      id: 'bridge:host-1:peer-1:person',
      hostId: 'host-1',
      peerNodeId: 'peer-1',
      peerRuntime: 'person',
      title: 'Peer',
      subtitle: 'Peer',
      unreadCount: 0,
      updatedAtMs: 1,
      updatedAtLabel: '12:00',
      awaitingReply: true,
      peerTyping: false,
      messages: [{
        id: 'pending-1',
        direction: 'outbound',
        sender: 'Me',
        text: 'hello',
        timeLabel: '12:31',
        timestampMs: 1,
        deliveryState: 'sending',
      }],
    }],
  }, 'bridge:host-1:peer-1:person', 'pending-1', 'Contact request was rejected, so messages are blocked.');

  const message = next?.conversations[0]?.messages[0];

  assert.equal(message?.deliveryState, 'failed');
  assert.equal(message?.detail, 'Contact request was rejected, so messages are blocked.');
});
