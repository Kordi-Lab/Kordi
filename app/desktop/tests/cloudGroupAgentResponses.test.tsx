import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudGroupAgentResponseTargetAccountIds, cloudGroupControlMessagesForAccount, cloudGroupMessageReadPeerIds, cloudGroupMessageReadTargets, encodeCloudGroupControl, parseCloudGroupControl, cloudGroupAgentMentionHasResponse, cloudGroupAgentMentionResponseState, cloudGroupAgentOfflineNoticeRequest, cloudGroupAgentRequestingNoticeMessage } from '../src/features/cloud/cloudGroupMessages';
import { cloudGroupLocalAgentRequestAlreadyHandled } from '../src/features/cloud/cloudGroupLocalAgentRequestState';
import {
  upsertCanonicalRequestIntoLocalState,
} from '../src/features/cloud/cloudAgentRequestState';
import type {
  CanonicalSessionState,
} from '../src/kordi-app/types';

test('cloud group detects whether an offline candidate already sent an agent response', () => {
  assert.equal(cloudGroupAgentMentionHasResponse({
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_target',
    messages: [
      { id: 'msg_processing', sessionId: 'session:group:one', senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { requestId: 'msg_request', deliveryState: 'processing' }, parentMessageId: 'msg_request', status: 'processing', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group-agent' },
    ],
  }), true);
  assert.equal(cloudGroupAgentMentionResponseState({
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_target',
    messages: [
      { id: 'msg_processing', sessionId: 'session:group:one', senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { requestId: 'msg_request', deliveryState: 'processing' }, parentMessageId: 'msg_request', status: 'processing', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group-agent' },
    ],
  }), 'processing');
  assert.equal(cloudGroupAgentMentionResponseState({
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_target',
    messages: [
      { id: 'msg_final', sessionId: 'session:group:one', senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'done', content: { requestId: 'msg_request', deliveryState: 'complete' }, parentMessageId: 'msg_request', status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, sourceTransport: 'cloud-group-agent' },
    ],
  }), 'terminal');

  assert.equal(cloudGroupAgentMentionHasResponse({
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_target',
    messages: [
      { id: 'msg_other', sessionId: 'session:group:one', senderIdentityId: 'agent:cloud:acct_other', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { requestId: 'msg_request', deliveryState: 'processing' }, parentMessageId: 'msg_request', status: 'processing', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group-agent' },
    ],
  }), false);
});

test('cloud group requesting notice uses the final response slot for smooth in-place updates', () => {
  const message = cloudGroupAgentRequestingNoticeMessage({
    sessionId: 'session:group:one',
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_yang',
    targetAgentId: 'cloud_agent_scout',
    targetAgentDisplayName: 'Scout',
    createdAtMs: 123,
    sequenceNum: 9,
  });

  assert.equal(message.id, 'msg:cloud-agent-processing:msg_request:acct_yang');
  assert.equal(message.senderIdentityId, 'agent:cloud-agent:cloud_agent_scout');
  assert.equal(message.contentText, 'processing...');
  assert.equal(message.status, 'processing');
  assert.equal(message.sourceTransport, 'cloud-group-agent-offline');
  assert.deepEqual(message.content, {
    sender: 'Scout',
    senderOwnerAccountId: 'acct_yang',
    timestampMs: 123,
    deliveryState: 'processing',
    requestId: 'msg_request',
    replyToMessageId: 'msg_request',
  });
});

test('a delayed local processing fallback cannot replace a completed group-agent reply', () => {
  const stableId = 'msg:cloud-agent-processing:msg_request:acct_target';
  const terminalMessage = {
    id: stableId,
    sessionId: 'session:group:one',
    senderIdentityId: 'agent:cloud:acct_target',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'finished',
    content: {
      requestId: 'msg_request',
      replyToMessageId: 'msg_request',
      deliveryState: 'complete',
    },
    parentMessageId: 'msg_request',
    status: 'received',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    contentHash: null,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:wire_response',
  } as const;
  const state = {
    messages: [terminalMessage],
  } as unknown as CanonicalSessionState;
  const fallback = cloudGroupAgentRequestingNoticeMessage({
    sessionId: terminalMessage.sessionId,
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_target',
    createdAtMs: 3,
  });

  const next = upsertCanonicalRequestIntoLocalState(state, {
    id: fallback.id,
    sessionId: fallback.sessionId,
    senderIdentityId: fallback.senderIdentityId,
    senderRole: fallback.senderRole,
    messageKind: fallback.messageKind,
    contentText: fallback.contentText,
    content: fallback.content,
    parentMessageId: fallback.parentMessageId,
    status: fallback.status,
    createdAtMs: fallback.createdAtMs,
    sourceTransport: fallback.sourceTransport,
    sourceEventId: fallback.sourceEventId,
  });

  assert.equal(next, state);
  assert.equal(next?.messages[0]?.contentText, 'finished');
});

test('cloud group offline notice replies as the mentioned agent and marks the turn failed', () => {
  const request = cloudGroupAgentOfflineNoticeRequest({
    sessionId: 'session:group:one',
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_yang',
    targetHumanDisplayName: 'Márta',
    createdAtMs: 123,
  });

  assert.equal(request.id, 'msg:cloud-agent-offline:msg_request:acct_yang');
  assert.equal(request.senderIdentityId, 'agent:cloud-agent:cloud-agent:acct_yang');
  assert.equal(request.senderRole, 'external-agent');
  assert.equal(request.messageKind, 'agent-turn');
  assert.equal(request.contentText, '');
  assert.equal(request.parentMessageId, 'msg_request');
  assert.equal(request.status, 'failed');
  assert.deepEqual(request.content, {
    sender: 'Kordi',
    senderOwnerAccountId: 'acct_yang',
    timestampMs: 123,
    deliveryState: 'failed',
    requestId: 'msg_request',
    replyToMessageId: 'msg_request',
    error: 'Márta and Kordi are offline.',
  });
});

test('cloud group agent response state prefers terminal rows over older processing placeholders', () => {
  const groupId = 'session:group:one';
  const requestId = 'msg_request';
  const targetAccountId = 'acct_target';
  assert.equal(cloudGroupAgentMentionResponseState({
    requestMessageId: requestId,
    targetAccountId,
    messages: [
      { id: 'msg_processing', sessionId: groupId, senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { requestId, deliveryState: 'processing' }, parentMessageId: requestId, status: 'processing', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group-agent' },
      { id: 'msg_final', sessionId: groupId, senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'final answer', content: { requestId, deliveryState: 'complete' }, parentMessageId: requestId, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, sourceTransport: 'cloud-group-agent' },
    ],
  }), 'terminal');
});

test('cloud group local agent requests are considered handled after a synced processing or final response', () => {
  const requestId = 'msg_request';
  const responseBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_response',
      senderAccountId: 'acct_a',
      text: 'done',
      createdAtMs: 200,
      senderKind: 'agent',
      deliveryState: 'complete',
      requestId,
      replyToMessageId: requestId,
    },
  });

  assert.equal(cloudGroupLocalAgentRequestAlreadyHandled({
    localAccountId: 'acct_a',
    requestMessageId: requestId,
    messages: [{
      messageId: 'cloud_response',
      fromAccountId: 'acct_a',
      toAccountId: 'acct_b',
      body: responseBody,
      createdAt: new Date(200).toISOString(),
      deliveredAt: null,
      readAt: null,
      direction: 'outgoing',
    }],
  }), true);
});

test('cloud group local agent may repair a failed hosted fallback response', () => {
  const requestId = 'msg_request_repair';
  const responseBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:repair',
    groupTitle: 'Team',
    createdByAccountId: 'acct_b',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'admin' },
    ],
    message: {
      id: 'cloudrunmsg_failed',
      senderAccountId: 'acct_a',
      text: 'No provider configured yet.',
      createdAtMs: 200,
      senderKind: 'agent',
      deliveryState: 'failed',
      requestId,
      replyToMessageId: requestId,
    },
  });
  const messages = [{
    messageId: 'cloudrunmsg_failed_wire',
    fromAccountId: 'acct_a',
    toAccountId: 'acct_b',
    body: responseBody,
    createdAt: new Date(200).toISOString(),
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing' as const,
  }];

  assert.equal(cloudGroupLocalAgentRequestAlreadyHandled({
    localAccountId: 'acct_a',
    requestMessageId: requestId,
    messages,
  }), true);
  assert.equal(cloudGroupLocalAgentRequestAlreadyHandled({
    localAccountId: 'acct_a',
    requestMessageId: requestId,
    messages,
    ignoreFailedCloudFallback: true,
  }), false);
});

test('cloud group replay deduplicates fanout rows for the same canonical message', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:fanout',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_a', displayName: 'A', avatarUrl: null, role: 'person' },
      { accountId: 'acct_b', displayName: 'B', avatarUrl: null, role: 'person' },
    ],
    message: { id: 'msg:ui:fanout', senderAccountId: 'acct_me', text: 'hello both', createdAtMs: 1 },
  });

  const replay = cloudGroupControlMessagesForAccount({
    accountId: 'acct_me',
    messages: [
      { messageId: 'cloud_to_a', fromAccountId: 'acct_me', toAccountId: 'acct_a', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
      { messageId: 'cloud_to_b', fromAccountId: 'acct_me', toAccountId: 'acct_b', body, createdAt: '2026-05-11T00:00:01Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
    ],
  });

  assert.deepEqual(replay.map((message) => message.messageId), ['cloud_to_a']);
});

test('cloud group agent response targets include original sender even when participant snapshot is incomplete', () => {
  const envelope = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_requester',
    actor: { accountId: 'acct_requester', displayName: 'Requester', avatarUrl: null, role: 'person' },
    // Regression: older/incomplete controls may only carry the owner in participants.
    participants: [{ accountId: 'acct_owner', displayName: 'Owner', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_request', senderAccountId: 'acct_requester', text: '@OwnersKordi help', createdAtMs: 1 },
  }));

  assert.ok(envelope);
  assert.deepEqual(cloudGroupAgentResponseTargetAccountIds({
    localAccountId: 'acct_owner',
    envelope,
    requestCloudMessage: { fromAccountId: 'acct_requester', toAccountId: 'acct_owner' },
  }), ['acct_requester']);
});

test('cloud group read helper marks inbound controls read when their group session is open', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_group_1', senderAccountId: 'acct_peer', text: 'hello', createdAtMs: 1 },
  });

  assert.deepEqual(cloudGroupMessageReadPeerIds({
    accountId: 'acct_me',
    activeConversationId: 'session:group:child',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), ['acct_peer']);
});

test('cloud group read helper returns only the exact active session for durable Cloud read receipts', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_group_1', senderAccountId: 'acct_peer', text: 'hello', createdAtMs: 1 },
  });

  assert.deepEqual(cloudGroupMessageReadTargets({
    accountId: 'acct_me',
    activeConversationIds: ['ui-row-id', 'group:session:group:child'],
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), { peerIds: ['acct_peer'], sessionIds: ['session:group:child'] });
  assert.deepEqual(cloudGroupMessageReadTargets({
    accountId: 'acct_me',
    activeConversationIds: ['ui-row-id', 'group:session:group:space'],
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), { peerIds: [], sessionIds: [] });
});
