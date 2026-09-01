import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudGroupAgentCancelledNoticeRequest,
  cloudGroupAgentCancelRoleForRequest,
  cloudGroupAgentProcessingMessageForRequest,
  optimisticCloudAgentCancelMessage,
} from '../src/features/cloud/cloudAgentCancellation';
import { encodeCloudAgentCancel } from '../src/features/cloud/cloudAgentMessages';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '../src/kordi-app/types';

test('cloud agent optimistic cancel controls have the same shape as server cancel controls', () => {
  const cancel = optimisticCloudAgentCancelMessage({
    account: {
      accountId: 'acct_me',
      displayName: 'Me Cloud',
      primaryEmail: 'me@example.com',
      avatarUrl: null,
      nodeId: 'node_me',
      passwordSet: true,
    },
    peerAccountId: 'acct_peer',
    requestId: 'msg_cancel_request',
    now: 1_234,
  });

  assert.equal(cancel.fromAccountId, 'acct_me');
  assert.equal(cancel.toAccountId, 'acct_peer');
  assert.equal(cancel.direction, 'outgoing');
  assert.equal(
    cancel.body,
    encodeCloudAgentCancel({ requestId: 'msg_cancel_request' }),
  );
  assert.equal(cancel.createdAt, new Date(1_234).toISOString());
});

test('cloud group cancel finds requesting placeholders before processing reaches the agent', () => {
  const requesting = {
    id: 'msg:cloud-agent-offline:msg_request:acct_peer',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_peer',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'Requesting…',
    content: { requestId: 'msg_request', deliveryState: 'processing' },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId: 'cloud-group-agent-offline:msg_request:acct_peer',
  } as CanonicalSessionMessage;

  assert.equal(
    cloudGroupAgentProcessingMessageForRequest(
      [requesting],
      'session:group',
      'msg_request',
    )?.id,
    requesting.id,
  );
});

test('cloud group cancel notices record sender or agent owner role', () => {
  const processing = {
    id: 'msg:cloud-agent-offline:msg_request:acct_peer',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_peer',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: {
      sender: "Peer's Kordi",
      requestId: 'msg_request',
      deliveryState: 'processing',
      messageAction: {
        schemaVersion: 1,
        kind: 'thread',
        source: {
          sourceSessionId: 'session:group',
          sourceMessageId: 'thread:root',
          senderLabel: 'Me',
          textPreview: 'Root',
          attachmentCount: 0,
        },
      },
    },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId: 'cloud-group-agent-offline:msg_request:acct_peer',
  } as CanonicalSessionMessage;
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      {
        id: 'human:me',
        kind: 'human',
        displayName: 'Me',
        source: 'local',
        humanId: 'acct_me',
        avatarKey: 'me',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      {
        id: 'human:peer',
        kind: 'human',
        displayName: 'Peer',
        source: 'bridge',
        humanId: 'acct_peer',
        avatarKey: 'peer',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    sessions: [],
    participants: [],
    messages: [
      {
        id: 'msg_request',
        sessionId: 'session:group',
        senderIdentityId: 'human:me',
        senderRole: 'user',
        messageKind: 'text',
        contentText: '@PeerKordi hi',
        content: {},
        status: 'sent',
        sequenceNum: 0,
        createdAtMs: 1,
        updatedAtMs: 1,
        contentHash: null,
        sourceTransport: 'cloud-group',
        sourceEventId: 'request',
      },
      processing,
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as CanonicalSessionState;

  assert.equal(cloudGroupAgentCancelRoleForRequest({
    state: canonicalState,
    requestId: 'msg_request',
    processingMessage: processing,
    cancelledByAccountId: 'acct_me',
  }), 'sender');
  assert.equal(cloudGroupAgentCancelRoleForRequest({
    state: canonicalState,
    requestId: 'msg_request',
    processingMessage: processing,
    cancelledByAccountId: 'acct_peer',
  }), 'agent owner');

  const notice = cloudGroupAgentCancelledNoticeRequest({
    processingMessage: processing,
    requestId: 'msg_request',
    conversationId: 'cloud-group-agent:session:group',
    cancelledByAccountId: 'acct_me',
    cancelledByRole: 'sender',
    now: 1_234,
  });

  assert.equal(notice.contentText, 'Request canceled by sender.');
  assert.deepEqual(notice.content, {
    sender: "Peer's Kordi",
    timestampMs: 1_234,
    deliveryState: 'cancelled',
    sourceConversationId: 'cloud-group-agent:session:group',
    requestId: 'msg_request',
    replyToMessageId: 'msg_request',
    messageAction: processing.content.messageAction,
    cancelledByAccountId: 'acct_me',
    cancelledByRole: 'sender',
  });
});

test('cloud group cancel notices default to the stable processing timestamp', () => {
  const notice = cloudGroupAgentCancelledNoticeRequest({
    processingMessage: {
      id: 'msg:processing',
      sessionId: 'session:group',
      senderIdentityId: 'agent:peer',
      senderRole: 'external-agent',
      messageKind: 'agent-turn',
      contentText: 'Requesting…',
      content: {
        sender: "Peer's Kordi",
        timestampMs: 55_000,
        deliveryState: 'processing',
        requestId: 'msg_request',
      },
      status: 'processing',
      sequenceNum: 1,
      createdAtMs: 44_000,
      updatedAtMs: 44_000,
      contentHash: null,
      sourceTransport: 'cloud-group-agent-offline',
      sourceEventId: 'processing',
    } as CanonicalSessionMessage,
    requestId: 'msg_request',
    conversationId: 'cloud-group-agent:session:group',
    cancelledByAccountId: 'acct_me',
    cancelledByRole: 'sender',
  });

  assert.equal(notice.createdAtMs, 55_000);
  assert.equal(
    (notice.content as { timestampMs?: number }).timestampMs,
    55_000,
  );
});
