import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';
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

test('leased native mirrors do not publish a second self-agent request or reply', () => {
  const sessionId = 'session:self-agent:leased';
  const row = (id: string, sourceTransport: string, senderRole: string, sequenceNum: number,
    content: Record<string, unknown> = {}, parentMessageId: string | null = null): CanonicalSessionMessage => ({
    id, sessionId, senderIdentityId: senderRole === 'user' ? 'human:me' : 'agent:me',
    senderRole, messageKind: senderRole === 'user' ? 'text' : 'agent-turn',
    contentText: senderRole === 'user' ? 'same words' : 'same reply', content,
    parentMessageId, delegatedExchangeId: null, status: senderRole === 'user' ? 'sent' : 'complete',
    sequenceNum, createdAtMs: 1000 + sequenceNum, updatedAtMs: 1000 + sequenceNum,
    sourceTransport, sourceEventId: `${sourceTransport}:${id}`,
  } as CanonicalSessionMessage);
  const original = row('ui-original', 'desktop-chat-ui', 'user', 1, {
    agentRuntimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
  });
  const cloudRequest = { ...row('cloud-original', 'cloud-self-agent', 'user', 2), sourceEventId: 'wire-original' };
  const leasedUserEcho = row('native-echo', 'desktop-chat', 'user', 3, { desktopEntryId: 'wire-original' });
  const leasedReplyEcho = row('native-reply', 'desktop-chat', 'owned-agent', 4, {}, leasedUserEcho.id);
  const separateUser = row('separate-user', 'desktop-chat', 'user', 5, { desktopEntryId: 'different-entry' });
  const separateReply = row('separate-reply', 'desktop-chat', 'owned-agent', 6, {}, separateUser.id);
  const state = {
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active' }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
    messages: [original, cloudRequest, leasedUserEcho, leasedReplyEcho, separateUser, separateReply],
  } as unknown as CanonicalSessionState;
  const ledger = { [original.id]: { cloudMessageId: 'wire-original', syncedAtMs: 1000 } };
  const planned = planCloudSelfAgentSync(state, ledger, { createdAfterMs: 900 });
  assert.deepEqual(planned.map((operation) => operation.localMessageId), [separateUser.id, separateReply.id]);

  // The persisted upload ledger remains enough if the Cloud mirror has not hydrated yet.
  const withoutCloudMirror = { ...state, messages: state.messages.filter((message) => message.id !== cloudRequest.id) };
  assert.deepEqual(planCloudSelfAgentSync(withoutCloudMirror, ledger, { createdAfterMs: 900 })
    .map((operation) => operation.localMessageId), [separateUser.id, separateReply.id]);
});

test('historical Cloud export does not suppress a later native turn by entry id alone', () => {
  const sessionId = 'session:self-agent:history';
  const row = (id: string, sourceTransport: string, senderRole: string,
    content: Record<string, unknown>, parentMessageId: string | null = null): CanonicalSessionMessage => ({
    id, sessionId, senderIdentityId: senderRole === 'user' ? 'human:me' : 'agent:me',
    senderRole, messageKind: senderRole === 'user' ? 'text' : 'agent-turn',
    contentText: senderRole === 'user' ? 'same words' : 'response', content,
    parentMessageId, delegatedExchangeId: null, status: senderRole === 'user' ? 'sent' : 'complete',
    sequenceNum: id === 'historical-local' ? 1 : id === 'historical-cloud' ? 2 : id === 'new-native' ? 3 : 4,
    createdAtMs: 1100, updatedAtMs: 1100, sourceTransport, sourceEventId: `${sourceTransport}:${id}`,
  } as CanonicalSessionMessage);
  const historicalLocal = row('historical-local', 'desktop-chat-ui', 'user', {});
  const historicalCloud = { ...row('historical-cloud', 'cloud-self-agent', 'user', {}), sourceEventId: 'wire-history' };
  const newNative = row('new-native', 'desktop-chat', 'user', { desktopEntryId: 'wire-history' });
  const newReply = row('new-reply', 'desktop-chat', 'owned-agent', {}, newNative.id);
  const state = {
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active' }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
    messages: [historicalLocal, historicalCloud, newNative, newReply],
  } as unknown as CanonicalSessionState;
  const ledger = { [historicalLocal.id]: { cloudMessageId: 'wire-history', syncedAtMs: 1000 } };
  assert.deepEqual(planCloudSelfAgentSync(state, ledger, { createdAfterMs: 900 })
    .map((operation) => operation.localMessageId), [newNative.id, newReply.id]);
});

test('replay retains the historical reply id but enriches it from the traced leased response', () => {
  const sessionId = 'session:self-agent:alias';
  const wireRequest = 'wire-original';
  const wireEchoRequest = 'wire-echo';
  const wireEchoResponse = 'wire-echo-response';
  const wireDirectResponse = 'wire-direct-response';
  const row = (id: string, sourceTransport: string, senderRole: string,
    sourceEventId: string, parentMessageId: string | null, content: Record<string, unknown>): CanonicalSessionMessage => ({
    id, sessionId, senderIdentityId: senderRole === 'user' ? 'human:me' : 'agent:me',
    senderRole, messageKind: senderRole === 'user' ? 'text' : 'agent-turn',
    contentText: senderRole === 'user' ? 'Question' : 'Earlier answer', content,
    parentMessageId, delegatedExchangeId: null, status: senderRole === 'user' ? 'sent' : 'complete',
    sequenceNum: 1, createdAtMs: 1000, updatedAtMs: 1000, sourceTransport, sourceEventId,
  } as CanonicalSessionMessage);
  const original = row('canonical-original', 'cloud-self-agent', 'user', wireRequest, null, {});
  const nativeEcho = row('canonical-native-echo', 'desktop-chat', 'user', 'native-event', null,
    { desktopEntryId: wireRequest });
  const historicalReply = row('canonical-historical-reply', 'cloud-self-agent', 'owned-agent',
    wireEchoResponse, nativeEcho.id, { cloudRequestMessageId: wireEchoRequest });
  const directReply = row('canonical-direct-reply', 'cloud-self-agent', 'owned-agent',
    wireDirectResponse, null, { cloudRequestMessageId: wireRequest, execution: { phase: 'complete' } });
  const cloud = (messageId: string, body: string, createdAt: string, extra: Partial<CloudMessage> = {}): CloudMessage => ({
    messageId, fromAccountId: account.accountId, toAccountId: account.accountId,
    body, sessionId, createdAt, deliveredAt: null, readAt: null, ...extra,
  });
  const originalWire = cloud(wireRequest, encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: 'Question',
    agentRuntimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
  }), '2026-09-30T01:00:00.000Z', {
    clientMessageId: cloudSelfAgentRequestClientMessageId(sessionId, 'local-original'),
  });
  const echoWire = cloud(wireEchoRequest, 'Question', '2026-09-30T01:00:00.100Z',
    { messageKind: 'canonical-history-user' });
  const echoReply = cloud(wireEchoResponse, encodeCloudAgentResponse({
    requestId: wireEchoRequest, text: 'Earlier answer', deliveryState: 'complete',
  }), '2026-09-30T01:00:00.200Z', {
    messageKind: 'canonical-history-agent', canonicalHistoryLocalMessageId: historicalReply.id,
  });
  const tracedReply = cloud(wireDirectResponse, encodeCloudAgentResponse({
    requestId: wireRequest, text: 'Updated answer', deliveryState: 'complete',
    execution: { phase: 'complete', summary: 'Done', steps: [], updatedAtMs: 1000, completed: true },
  }), '2026-09-30T01:00:00.300Z');
  const state = {
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active' }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
    messages: [original, nativeEcho, historicalReply, directReply],
  } as unknown as CanonicalSessionState;
  const hydratedOnly = planCloudSelfAgentCanonicalSync({ account, messages: [], state });
  assert.deepEqual(hydratedOnly.mirrorReconciliations, [{
    preferredMessageId: historicalReply.id, duplicateMessageId: directReply.id,
  }], 'opening an already durable conversation repairs its exact leased reply alias');
  const cloudMessages = [originalWire, echoWire, echoReply, tracedReply];
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: cloudMessages, state });
  assert.deepEqual(plan.mirrorReconciliations, [{
    preferredMessageId: historicalReply.id, duplicateMessageId: directReply.id,
  }]);
  const enriched = plan.messageRequests.find((request) => request.id === historicalReply.id);
  assert.equal(enriched?.contentText, 'Updated answer');
  assert.equal(enriched?.parentMessageId, original.id);
  assert.equal((enriched?.content as Record<string, unknown>)?.cloudRequestMessageId, wireRequest);
  assert.equal(plan.messageRequests.some((request) => request.id === nativeEcho.id), false);
  assert.equal(plan.messageRequests.some((request) => request.id === directReply.id), false);

  const echoOnly = planCloudSelfAgentCanonicalSync({ account, messages: [echoReply], state });
  assert.equal(echoOnly.messageRequests.some((request) => request.sourceEventId === wireEchoResponse), false);
  const originalOnly = planCloudSelfAgentCanonicalSync({ account, messages: [tracedReply], state });
  assert.deepEqual(originalOnly.mirrorReconciliations, [{
    preferredMessageId: historicalReply.id, duplicateMessageId: directReply.id,
  }]);
  assert.equal(originalOnly.messageRequests.some((request) => request.id === historicalReply.id), true);

  const sameRequestEcho = { ...echoReply, body: encodeCloudAgentResponse({
    requestId: wireRequest, text: 'Earlier answer', deliveryState: 'complete',
  }) };
  const nativeParentOnly = { ...state, messages: [nativeEcho, historicalReply, directReply] };
  const sameRequestPlan = planCloudSelfAgentCanonicalSync({
    account, messages: [originalWire, sameRequestEcho, tracedReply], state: nativeParentOnly,
  });
  assert.deepEqual(sameRequestPlan.mirrorReconciliations, [{
    preferredMessageId: historicalReply.id, duplicateMessageId: directReply.id,
  }], 'a native history export of the original request must not duplicate its traced terminal reply');
  assert.equal(sameRequestPlan.messageRequests.some((request) => request.sourceEventId === wireEchoResponse), false);
  assert.equal(sameRequestPlan.messageRequests.find((request) => request.id === historicalReply.id)?.contentText,
    'Updated answer');

  const afterMerge = { ...state, messages: [original, {
    ...historicalReply, parentMessageId: original.id, sourceEventId: wireDirectResponse,
    contentText: 'Updated answer', content: enriched?.content ?? {},
  }] };
  const replay = planCloudSelfAgentCanonicalSync({ account, messages: cloudMessages, state: afterMerge });
  assert.deepEqual(replay.mirrorReconciliations, []);
  assert.equal(replay.messageRequests.some((request) => request.id === directReply.id), false);
  assert.equal(replay.messageRequests.some((request) => request.sourceEventId === wireEchoResponse), false);

  const localOriginal = row('local-original', 'desktop-chat-ui', 'user', 'ui-event', null, {
    agentRuntimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
  });
  const withLocalParent = { ...afterMerge, messages: [localOriginal, {
    ...afterMerge.messages[1], parentMessageId: localOriginal.id,
  }] };
  const localParentReplay = planCloudSelfAgentCanonicalSync({ account, messages: cloudMessages, state: withLocalParent });
  assert.equal(localParentReplay.messageRequests.some((request) => request.sourceEventId === wireEchoResponse), false);
  assert.equal(localParentReplay.messageRequests.some((request) => request.id === directReply.id), false);
});

test('a single traced historical response remains visible when it is the original reply', () => {
  const sessionId = 'session:self-agent:single-history';
  const request = { messageId: 'wire-single', fromAccountId: account.accountId,
    toAccountId: account.accountId, body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1, kind: 'message', text: 'Question',
      agentRuntimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
    }), sessionId, createdAt: '2026-09-30T01:00:00.000Z', deliveredAt: null, readAt: null } satisfies CloudMessage;
  const reply = { ...request, messageId: 'wire-single-reply',
    messageKind: 'canonical-history-agent', canonicalHistoryLocalMessageId: 'canonical-single-reply',
    createdAt: '2026-09-30T01:00:01.000Z', body: encodeCloudAgentResponse({
      requestId: request.messageId, text: 'Answer', deliveryState: 'complete',
      execution: { phase: 'complete', summary: 'Done', steps: [], updatedAtMs: 1000, completed: true },
    }) } satisfies CloudMessage;
  const state = { sessions: [{ id: sessionId, kind: 'self-agent', status: 'active' }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' }, messages: [
      { id: 'canonical-request', sessionId, senderRole: 'user', messageKind: 'text',
        sourceTransport: 'cloud-self-agent', sourceEventId: request.messageId, contentText: 'Question' },
      { id: 'canonical-single-reply', sessionId, senderRole: 'owned-agent', messageKind: 'agent-turn',
        sourceTransport: 'cloud-self-agent', sourceEventId: reply.messageId,
        parentMessageId: 'canonical-request', contentText: 'Answer', status: 'complete' },
    ] } as unknown as CanonicalSessionState;
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [request, reply], state });
  assert.equal(plan.mirrorReconciliations.length, 0);
  assert.equal(plan.messageRequests.some((message) => message.sourceEventId === reply.messageId), true);
});

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
      { id: forkSessionId, kind: 'self-agent', title: 'Fork', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', metadata: { fork: { forkedFromSessionId: 'session:self-agent:parent' } }, createdAtMs: 1, updatedAtMs: 1 },
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
