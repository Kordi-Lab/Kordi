import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { planCloudSelfAgentSync, planCloudSelfAgentCanonicalSync, seedCloudSelfAgentForwardSyncLedger } from '../src/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

test('cloud self-agent canonical sync materializes scheduled run responses without a matching user request id', () => {
  const userMessage: CloudMessage = {
    messageId: 'msg_schedule_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'Schedule a cloud task to search OpenAI news at 19:43.',
    createdAt: '2026-06-09T11:42:14.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'scheduled-session',
  };
  const scheduledResponse: CloudMessage = {
    messageId: 'cloudrunmsg_openai_summary',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({ requestId: 'scheduled_run_openai_summary', text: 'Here is the latest OpenAI news summary.' }),
    createdAt: '2026-06-09T11:44:19.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'scheduled-session',
  };
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [scheduledResponse, userMessage], state });

  assert.deepEqual(plan.messageRequests.map((request) => ({
    id: request.id,
    senderRole: request.senderRole,
    messageKind: request.messageKind,
    contentText: request.contentText,
    parentMessageId: request.parentMessageId ?? null,
    sourceEventId: request.sourceEventId,
  })), [
    { id: 'msg:cloud:self:msg_schedule_request', senderRole: 'user', messageKind: 'text', contentText: 'Schedule a cloud task to search OpenAI news at 19:43.', parentMessageId: null, sourceEventId: 'msg_schedule_request' },
    { id: 'msg:cloud:self:response:scheduled_run_openai_summary', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Here is the latest OpenAI news summary.', parentMessageId: null, sourceEventId: 'cloudrunmsg_openai_summary' },
  ]);
});

test('cloud self-agent canonical sync deduplicates repeated Cloud rows within the same restore batch', () => {
  const createdAt = '2026-05-16T08:11:27.120Z';
  const duplicateRequestA: CloudMessage = {
    messageId: 'msg_self_request_a',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'same restored request',
    createdAt,
    deliveredAt: null,
    readAt: null,
    sessionId: 'restored-self-session',
  };
  const duplicateRequestB: CloudMessage = {
    ...duplicateRequestA,
    messageId: 'msg_self_request_b',
  };
  const duplicateAnswerA: CloudMessage = {
    messageId: 'msg_self_answer_a',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({ requestId: duplicateRequestA.messageId, text: 'same restored answer' }),
    createdAt: '2026-05-16T08:11:32.820Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'restored-self-session',
  };
  const duplicateAnswerB: CloudMessage = {
    ...duplicateAnswerA,
    messageId: 'msg_self_answer_b',
    body: encodeCloudAgentResponse({ requestId: duplicateRequestB.messageId, text: 'same restored answer' }),
  };
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [duplicateAnswerB, duplicateRequestB, duplicateAnswerA, duplicateRequestA],
    state,
  });

  assert.deepEqual(plan.messageRequests.map((request) => ({
    contentText: request.contentText,
    senderRole: request.senderRole,
    parentMessageId: request.parentMessageId ?? null,
  })), [
    { contentText: 'same restored request', senderRole: 'user', parentMessageId: null },
    { contentText: 'same restored answer', senderRole: 'owned-agent', parentMessageId: 'msg:cloud:self:msg_self_request_a' },
  ]);
});

test('two devices converge processing and terminal self-agent replies onto one stable response slot', () => {
  const request: CloudMessage = {
    messageId: 'msg_self_request_stable',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'hello from device A',
    createdAt: '2026-08-08T09:49:00.000Z',
    deliveredAt: '2026-08-08T09:49:00.000Z',
    readAt: '2026-08-08T09:49:00.000Z',
    sessionId: 'session:self-agent:shared',
  };
  const processing: CloudMessage = {
    ...request,
    messageId: 'msg_self_processing_stable',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'processing...',
      deliveryState: 'processing',
    }),
    createdAt: '2026-08-08T09:49:00.100Z',
  };
  const completed: CloudMessage = {
    ...request,
    messageId: 'msg_self_completed_stable',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'one shared answer',
      deliveryState: 'complete',
    }),
    createdAt: '2026-08-08T09:49:04.000Z',
  };
  const failed: CloudMessage = {
    ...request,
    messageId: 'msg_self_failed_before_recovery',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'Cloud fallback could not complete this request.',
      deliveryState: 'failed',
    }),
    createdAt: '2026-08-08T09:49:02.000Z',
  };
  const emptyDeviceState = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp/device-b', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-b/canonical.sqlite3',
  } as CanonicalSessionState;

  const processingPlan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [request, processing],
    state: emptyDeviceState,
  });
  const completedPlan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [completed, failed, processing, request],
    state: emptyDeviceState,
  });

  const processingReply = processingPlan.messageRequests.find(
    (message) => message.senderRole === 'owned-agent',
  );
  const completedReplies = completedPlan.messageRequests.filter(
    (message) => message.senderRole === 'owned-agent',
  );
  assert.equal(
    processingReply?.id,
    'msg:cloud:self:response:msg_self_request_stable',
  );
  assert.equal(processingReply?.status, 'processing');
  assert.equal(completedReplies.length, 1);
  assert.equal(completedReplies[0]?.id, processingReply?.id);
  assert.equal(completedReplies[0]?.status, 'complete');
  assert.equal(completedReplies[0]?.contentText, 'one shared answer');
  assert.equal(
    completedReplies[0]?.parentMessageId,
    'msg:cloud:self:msg_self_request_stable',
  );
});

test('delayed self-agent failures and heartbeats cannot downgrade an existing completed reply', () => {
  const request: CloudMessage = {
    messageId: 'msg_self_request_terminal',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'keep the completed answer',
    createdAt: '2026-08-08T09:49:00.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:self-agent:terminal',
  };
  const delayedHeartbeat: CloudMessage = {
    ...request,
    messageId: 'msg_self_processing_late',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'processing...',
      deliveryState: 'processing',
    }),
    createdAt: '2026-08-08T09:50:00.000Z',
  };
  const delayedFailure: CloudMessage = {
    ...request,
    messageId: 'msg_self_failed_late',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'Cloud fallback could not complete this request.',
      deliveryState: 'failed',
    }),
    createdAt: '2026-08-08T09:51:00.000Z',
  };
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp/device-a', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'msg:cloud:self:msg_self_request_terminal', sessionId: request.sessionId, senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text', contentText: request.body, content: null, parentMessageId: null, status: 'sent', sequenceNum: 1, createdAtMs: Date.parse(request.createdAt), updatedAtMs: Date.parse(request.createdAt), sourceTransport: 'cloud-self-agent', sourceEventId: request.messageId },
      { id: 'msg:cloud:self:response:msg_self_request_terminal', sessionId: request.sessionId, senderIdentityId: 'agent:cloud-self:acct_me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'finished', content: { requestId: 'msg:cloud:self:msg_self_request_terminal', deliveryState: 'complete' }, parentMessageId: 'msg:cloud:self:msg_self_request_terminal', status: 'complete', sequenceNum: 2, createdAtMs: Date.parse(request.createdAt) + 1_000, updatedAtMs: Date.parse(request.createdAt) + 1_000, sourceTransport: 'cloud-self-agent', sourceEventId: 'msg_self_terminal' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-a/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [request, delayedHeartbeat, delayedFailure],
    state,
  });

  assert.deepEqual(plan.messageRequests, []);
});

test('self-agent forward planning preserves explicit request identity and terminal failures', () => {
  const state = {
    sessions: [
      { id: 'session:self-agent:shared', kind: 'self-agent', title: 'Shared', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp/device-a', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'local-request-a', sessionId: 'session:self-agent:shared', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'first', content: {}, parentMessageId: null, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10 },
      { id: 'local-request-b', sessionId: 'session:self-agent:shared', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'second', content: {}, parentMessageId: null, status: 'sent', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20 },
      { id: 'local-response-a', sessionId: 'session:self-agent:shared', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '', content: { error: 'Provider stopped', replyToMessageId: 'local-request-a', deliveryState: 'failed' }, parentMessageId: 'local-request-a', status: 'failed', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30 },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-a/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), [
    { localMessageId: 'local-request-a', sessionId: 'session:self-agent:shared', role: 'user', text: 'first', parentLocalMessageId: null, createdAtMs: 10, deliveryState: 'sent' },
    { localMessageId: 'local-request-b', sessionId: 'session:self-agent:shared', role: 'user', text: 'second', parentLocalMessageId: null, createdAtMs: 20, deliveryState: 'sent' },
    { localMessageId: 'local-response-a', sessionId: 'session:self-agent:shared', role: 'agent', text: 'Provider stopped', parentLocalMessageId: 'local-request-a', createdAtMs: 30, deliveryState: 'failed' },
  ]);
});

test('custom owned direct-agent sync preserves the selected agent identity', () => {
  const state = {
    sessions: [{
      id: 'session:direct-agent:stock',
      kind: 'direct-agent',
      title: 'hi',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'agent:stock',
      metadata: { createdFrom: 'chat-create-flow', cloudAgentId: 'cloud_agent_stock', cloudAgentName: 'US Stock Paper Trader' },
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    identities: [{
      id: 'agent:stock',
      kind: 'agent',
      displayName: 'US Stock Paper Trader',
      source: 'local',
      agentId: 'cloud_agent_stock',
      avatarKey: 'cloud_agent_stock',
      metadata: { isOwned: true },
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    participants: [],
    profile: { id: 'profile', activeAgentIdentityId: 'agent:default', storageRoot: '/tmp/device-a', createdAtMs: 1, updatedAtMs: 1 },
    messages: [{
      id: 'local-request',
      sessionId: 'session:direct-agent:stock',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'who are you',
      content: {},
      parentMessageId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: 10,
      updatedAtMs: 10,
    }] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-a/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), [{
    localMessageId: 'local-request',
    sessionId: 'session:direct-agent:stock',
    role: 'user',
    text: 'who are you',
    parentLocalMessageId: null,
    createdAtMs: 10,
    deliveryState: 'sent',
    targetAgentId: 'cloud_agent_stock',
    targetAgentName: 'US Stock Paper Trader',
  }]);
});

test('cloud self-agent forward sync does not re-upload restored Cloud canonical rows', () => {
  const state = {
    sessions: [
      { id: 'restored-self-session', kind: 'self-agent', title: 'Restored', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'msg:cloud:self:request', sessionId: 'restored-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'restored prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, sourceTransport: 'cloud-self-agent', sourceEventId: 'msg_request' },
      { id: 'msg:cloud:self:answer', sessionId: 'restored-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'restored answer', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, sourceTransport: 'cloud-self-agent', sourceEventId: 'msg_answer' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), []);
  assert.deepEqual(seedCloudSelfAgentForwardSyncLedger(state, {}, 1000), { ledger: {}, changed: false });
});

test('stable reply identities do not duplicate responses restored by an older app version', () => {
  const request: CloudMessage = {
    messageId: 'msg_request_legacy',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'legacy prompt',
    createdAt: '2026-08-08T10:00:00.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'restored-self-session',
  };
  const response: CloudMessage = {
    ...request,
    messageId: 'msg_response_legacy',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'legacy answer',
      deliveryState: 'complete',
    }),
    createdAt: '2026-08-08T10:00:01.000Z',
  };
  const processing: CloudMessage = {
    ...response,
    messageId: 'msg_processing_legacy',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'processing...',
      deliveryState: 'processing',
    }),
    createdAt: '2026-08-08T10:00:00.500Z',
  };
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'msg:cloud:self:msg_request_legacy', sessionId: request.sessionId, senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text', contentText: request.body, status: 'sent', sequenceNum: 1, createdAtMs: Date.parse(request.createdAt), updatedAtMs: Date.parse(request.createdAt), sourceTransport: 'cloud-self-agent', sourceEventId: request.messageId },
      { id: 'msg:cloud:self:msg_response_legacy', sessionId: request.sessionId, senderIdentityId: 'agent:cloud-self:acct_me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'legacy answer', status: 'complete', sequenceNum: 2, createdAtMs: Date.parse(response.createdAt), updatedAtMs: Date.parse(response.createdAt), sourceTransport: 'cloud-self-agent', sourceEventId: response.messageId },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [request, processing, response],
    state,
  });

  assert.equal(plan.messageRequests.length, 1);
  assert.equal(plan.messageRequests[0]?.id, 'msg:cloud:self:msg_response_legacy');
});

test('cloud self-agent canonical sync does not duplicate existing local turns on the sending device', () => {
  const userMessage: CloudMessage = {
    messageId: 'msg_self_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'already local',
    createdAt: '2026-05-16T08:11:27.120Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'local-self-session',
  };
  const state = {
    sessions: [
      { id: 'local-self-session', kind: 'self-agent', title: 'already local', status: 'active', createdByIdentityId: 'human:acct_me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'local-u1', sessionId: 'local-self-session', senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text', contentText: 'already local', status: 'sent', sequenceNum: 1, createdAtMs: Date.parse(userMessage.createdAt), updatedAtMs: Date.parse(userMessage.createdAt), sourceTransport: 'desktop-chat' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [userMessage], state });

  assert.equal(plan.messageRequests.length, 0);
});

test('planCloudSelfAgentSync skips inherited fork snapshot rows but keeps new fork turns', () => {
  const forkSessionId = 'session:fork:abc123';
  const state = {
    sessions: [
      { id: forkSessionId, kind: 'self-agent', title: 'Fork', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', metadata: { fork: { forkedFromSessionId: 'session:group:1' } }, createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'snap-u1', sessionId: forkSessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi old prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, sourceTransport: 'canonical-fork-snapshot' },
      { id: 'snap-a1', sessionId: forkSessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'old answer', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, sourceTransport: 'canonical-fork-snapshot' },
      { id: 'new-u1', sessionId: forkSessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'new fork prompt', status: 'sent', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30, sourceTransport: 'desktop-chat' },
      { id: 'new-a1', sessionId: forkSessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'new answer', status: 'complete', sequenceNum: 4, createdAtMs: 40, updatedAtMs: 40, sourceTransport: 'desktop-chat' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), [
    { localMessageId: 'new-u1', sessionId: forkSessionId, role: 'user', text: 'new fork prompt', parentLocalMessageId: null, createdAtMs: 30, deliveryState: 'sent' },
    { localMessageId: 'new-a1', sessionId: forkSessionId, role: 'agent', text: 'new answer', parentLocalMessageId: 'new-u1', createdAtMs: 40, deliveryState: 'complete' },
  ]);
});
