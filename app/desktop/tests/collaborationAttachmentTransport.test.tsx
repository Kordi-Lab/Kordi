import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalAttachments } from '../src/features/canonical/readModel/messageMapping';
import {
  appendOptimisticCollaborationMessage,
  appendOptimisticOutboundMessage,
  collaborationAttachmentTransportFields,
  failedPreparedCanonicalUserMessage,
  markOptimisticCollaborationMessageFailed,
  markOptimisticCollaborationMessageSending,
  markOptimisticCanonicalMessageFailed,
  markOptimisticCanonicalMessageSending,
  prepareCanonicalUserMessage,
  retryAttachmentItemsFromMessage,
  toOptimisticAttachments,
} from '../src/features/chat/messageActions/optimistic';
import { failedCanonicalGroupMessageRequest } from '../src/features/chat/messageActions/collaborationSendLifecycle';
import type { CanonicalSessionState, DesktopChatState } from '../src/kordi-app/types';

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
  path: '/Users/example/Desktop/notes-temp-uuid.txt',
  kind: 'file' as const,
  formatLabel: 'TXT',
};

test('collaborationAttachmentTransportFields sends current attachment paths and display names', () => {
  const fields = collaborationAttachmentTransportFields([imageAttachment, fileAttachment]);

  assert.deepEqual(fields, {
    attachmentPaths: ['/tmp/pi-clipboard-1.png', '/Users/example/Desktop/notes-temp-uuid.txt'],
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

test('failed message attachments can be rebuilt for a retry only while local files remain available', () => {
  assert.deepEqual(retryAttachmentItemsFromMessage({
    id: 'msg-1',
    role: 'user',
    text: '',
    time: '12:31',
    attachments: [{
      kind: 'image',
      name: 'Screenshot 1.png',
      localPath: '/tmp/pi-clipboard-1.png',
      mimeType: 'image/png',
    }],
  }), [{
    id: 'msg-1:0:/tmp/pi-clipboard-1.png',
    path: '/tmp/pi-clipboard-1.png',
    kind: 'image',
    name: 'Screenshot 1.png',
    localPath: '/tmp/pi-clipboard-1.png',
    mimeType: 'image/png',
  }]);
  assert.equal(retryAttachmentItemsFromMessage({
    id: 'msg-2',
    role: 'user',
    text: '',
    time: '12:32',
    attachments: [{ kind: 'image', name: 'Missing.png', localPath: null }],
  }), null);
});

test('direct video retry restarts native transfer and surfaces terminal failure', () => {
  const source = readFileSync(
    new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /retryAttachments\.filter\(isMp4VideoAttachment\)/);
  assert.match(source, /uploadNativeCloudAttachment\(\{[\s\S]*path: attachment\.path/);
  assert.match(source, /Unable to retry message[\s\S]*markOptimisticCollaborationMessageFailed/);
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
  const next = appendOptimisticCollaborationMessage({
    activeHostId: 'host-1',
    hosts: [],
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

test('optimistic bridge messages include quoted reply metadata immediately', () => {
  const next = appendOptimisticCollaborationMessage({
    activeHostId: 'host-1',
    hosts: [],
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
  }, 'bridge:host-1:peer-1:person', 'Yes, ship it', '12:31', 'pending-1', [], 'Yes, ship it', {
    action: 'quote',
    source: {
      sourceSessionId: 'session:one',
      sourceMessageId: 'msg:source',
      senderLabel: 'Alice',
      textPreview: 'Can we ship?',
      attachmentCount: 0,
      createdAtMs: null,
      timeLabel: '10:42',
    },
  });

  const optimistic = next?.conversations[0]?.messages[0];
  assert.equal(optimistic?.messageAction?.kind, 'quote');
  assert.equal(optimistic?.messageAction?.source.sourceMessageId, 'msg:source');
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

test('retry returns failed direct and canonical messages to sending without creating a duplicate', () => {
  const collaborationState = appendOptimisticCollaborationMessage({
    activeHostId: 'host-1',
    hosts: [],
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
  }, 'bridge:host-1:peer-1:person', '', '12:31', 'pending-1', [imageAttachment]);
  const failedBridgeState = markOptimisticCollaborationMessageFailed(
    collaborationState,
    'bridge:host-1:peer-1:person',
    'pending-1',
    'offline',
  );
  const retryingBridgeState = markOptimisticCollaborationMessageSending(
    failedBridgeState,
    'bridge:host-1:peer-1:person',
    'pending-1',
  );
  assert.equal(retryingBridgeState?.conversations[0]?.messages.length, 1);
  assert.equal(retryingBridgeState?.conversations[0]?.messages[0]?.deliveryState, 'sending');
  assert.equal(retryingBridgeState?.conversations[0]?.messages[0]?.detail, undefined);

  const canonicalState = {
    sessions: [{ id: 'session-1', updatedAtMs: 1, lastMessageAtMs: 1 }],
    messages: [{
      id: 'msg-1',
      sessionId: 'session-1',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '',
      content: { deliveryState: 'failed', exhaustedRecipientIds: ['acct_a'] },
      parentMessageId: null,
      delegatedExchangeId: null,
      status: 'failed',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      contentHash: null,
      sourceTransport: 'cloud-group-ui',
      sourceEventId: 'cloud-group-ui:session-1:1',
    }],
  } as unknown as CanonicalSessionState;
  const retryingCanonicalState = markOptimisticCanonicalMessageSending(
    canonicalState,
    'session-1',
    'msg-1',
    ['acct_a'],
  );
  assert.equal(retryingCanonicalState?.messages.length, 1);
  assert.equal(retryingCanonicalState?.messages[0]?.status, 'sending');
  assert.deepEqual(retryingCanonicalState?.messages[0]?.content, {
    deliveryState: 'sending',
    exhaustedRecipientIds: [],
    deliveredRecipientIds: [],
    pendingRecipientIds: ['acct_a'],
    detail: undefined,
  });
});


test('Cloud group send paths label optimistic canonical rows with Cloud UI transport', () => {
  const source = readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');

  assert.match(source, /'cloud-group-ui'/);

  const cloudMentionStart = source.indexOf('shouldRouteMentionThroughCloudGroup({');
  const cloudMentionEnd = source.indexOf('if (mentionedTarget && activeConversationUsesCollaborationRouting)', cloudMentionStart);
  const cloudMentionBranch = source.slice(cloudMentionStart, cloudMentionEnd);
  assert.match(cloudMentionBranch, /prepareCanonicalUserMessage\([\s\S]*?'cloud-group-ui'/);
  assert.doesNotMatch(cloudMentionBranch, /prepareCanonicalUserMessage\([\s\S]*?'desktop-bridge-ui'/);

  assert.match(cloudMentionBranch, /cloudAgentMentionTargetIds\.length === 0/);
  assert.match(cloudMentionBranch, /targetAccountIds: cloudAgentMentionTargetIds/);
});


test('prepared Cloud group UI messages use Cloud source transport metadata', () => {
  const cloudGroupUiTransport: Parameters<typeof prepareCanonicalUserMessage>[5] = 'cloud-group-ui';
  const prepared = prepareCanonicalUserMessage(
    'session:group:cloud',
    'human:me',
    'hello group',
    [],
    '12:31',
    cloudGroupUiTransport,
    'sent',
  );

  assert.equal(prepared?.request.sourceTransport, 'cloud-group-ui');
  assert.equal(prepared?.request.sourceEventId?.startsWith('cloud-group-ui:session:group:cloud:'), true);
});


test('optimistic outbound chat messages include quoted reply metadata immediately', () => {
  const state: DesktopChatState = {
    cwd: '/tmp/kordi',
    activeSessionId: 'session:one',
    sessions: [{
      id: 'session:one',
      title: 'Alice',
      subtitle: 'Can we ship?',
      updatedAtLabel: '10:42',
      updatedAtMs: 1,
      messageCount: 1,
      draft: false,
    }],
    projects: [],
    activeSession: {
      id: 'session:one',
      title: 'Alice',
      subtitle: 'Can we ship?',
      provider: 'openai',
      providerLabel: 'OpenAI',
      model: 'gpt-5.4',
      modelLabel: 'GPT-5.4',
      thinking: 'xhigh',
      thinkingLabel: 'xhigh',
      thinkingLevels: [],
      updatedAtLabel: '10:42',
      updatedAtMs: 1,
      messageCount: 1,
      draft: false,
      contextWindowText: '',
      contextWindowStatus: { contextWindow: 0, autoCompaction: false },
      project: null,
      messages: [],
    },
    localAgent: {
      label: 'My Kordi',
      systemPrompt: '',
      loadedSkills: [],
      loadedTools: [],
      loadedPlugins: [],
      identityFiles: [],
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.4',
      workspaceRoot: '/tmp/kordi',
      lastActivities: [],
    },
    modelOptions: [],
    slashCommands: [],
  };

  const next = appendOptimisticOutboundMessage(
    state,
    'session:one',
    'Yes, ship it',
    'Yes, ship it',
    [],
    '12:31',
    [],
    {
      action: 'quote',
      source: {
        sourceSessionId: 'session:one',
        sourceMessageId: 'msg:source',
        senderLabel: 'Alice',
        textPreview: 'Can we ship?',
        attachmentCount: 0,
        createdAtMs: null,
        timeLabel: '10:42',
      },
    },
  );

  const optimistic = next.activeSession.messages[0] as typeof next.activeSession.messages[number] & {
    replyToMessageId?: string | null;
    messageAction?: { kind?: string; source?: { senderLabel?: string } } | null;
  };
  assert.equal(optimistic.replyToMessageId, 'msg:source');
  assert.equal(optimistic.messageAction?.kind, 'quote');
  assert.equal(optimistic.messageAction?.source?.senderLabel, 'Alice');
  assert.ok(next.sessions[0].updatedAtMs > state.sessions[0].updatedAtMs);
  assert.equal(next.activeSession.updatedAtMs, next.sessions[0].updatedAtMs);
});

test('prepared canonical user messages persist quoted reply metadata', () => {
  const prepared = prepareCanonicalUserMessage(
    'session:one',
    'human:me',
    'Yes, ship it',
    [],
    '12:31',
    'desktop-chat-ui',
    'sending',
    [],
    {
      action: 'quote',
      source: {
        sourceSessionId: 'session:one',
        sourceMessageId: 'msg:source',
        senderLabel: 'Alice',
        textPreview: 'Can we ship?',
        attachmentCount: 0,
        createdAtMs: null,
        timeLabel: '10:42',
      },
    },
  );

  assert.equal(prepared?.request.parentMessageId, 'msg:source');
  assert.equal((prepared?.request.content as { replyToMessageId?: string }).replyToMessageId, 'msg:source');
  assert.equal((prepared?.request.content as { messageAction?: { kind?: string } }).messageAction?.kind, 'quote');
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

test('failed canonical group messages persist attachment recovery and exhausted recipients', () => {
  const prepared = prepareCanonicalUserMessage(
    'session-1',
    'human:me',
    '',
    [imageAttachment],
    '12:31',
    'cloud-group-ui',
    'sending',
  );

  const failed = failedCanonicalGroupMessageRequest(
    prepared,
    'Attachment upload failed.',
    [' acct_a ', 'acct_b', 'acct_a'],
  );
  const content = failed?.content as {
    attachments?: Array<{ localPath?: string }>;
    deliveryState?: string;
    detail?: string;
    pendingRecipientIds?: string[];
    exhaustedRecipientIds?: string[];
  };

  assert.equal(failed?.status, 'failed');
  assert.equal(content.deliveryState, 'failed');
  assert.equal(content.detail, 'Attachment upload failed.');
  assert.deepEqual(content.pendingRecipientIds, []);
  assert.deepEqual(content.exhaustedRecipientIds, ['acct_a', 'acct_b']);
  assert.equal(content.attachments?.[0]?.localPath, '/tmp/pi-clipboard-1.png');
});


test('bridge optimistic messages keep the send failure detail inline', () => {
  const next = markOptimisticCollaborationMessageFailed({
    activeHostId: 'host-1',
    hosts: [],
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
