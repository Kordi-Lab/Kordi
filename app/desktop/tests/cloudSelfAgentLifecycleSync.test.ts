import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse, isCloudAgentControlMessage } from '../src/features/cloud/cloudAgentMessages';
import { applySynchronizedCloudAgentRuntimeRoutes, cloudAgentRuntimeSessionId, encodeCloudAgentRuntimeRouteChange } from '../src/features/cloud/cloudAgentRuntime';
import {
  cloudSelfAgentRequestClientMessageId,
  cloudSelfAgentResponseClientMessageId,
} from '../src/features/cloud/cloudSelfAgentIdentity';
import { cloudSelfAgentProcessingTextWouldRegress } from '../src/features/cloud/cloudSelfAgentResponseLifecycle';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Me Cloud', primaryEmail: 'me@example.com',
  avatarUrl: null,
    avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};

test('processing placeholder variants have no visible response text', () => {
  assert.equal(cloudSelfAgentProcessingTextWouldRegress('Partial answer', 'Processing..'), true);
  assert.equal(cloudSelfAgentProcessingTextWouldRegress('processing...', 'requesting…'), false);
});

function emptyState(messages: CanonicalSessionMessage[] = []): CanonicalSessionState {
  return {
    sessions: [], identities: [], participants: [],
    profile: {
      id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me',
      createdAtMs: 1, updatedAtMs: 1,
    },
    messages, delegatedExchanges: [], presence: [], contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  };
}

function requestMessage(
  messageId: string,
  body: string,
  createdAt: string,
  sessionId = 'session:self-agent:lifecycle',
): CloudMessage {
  return {
    messageId, fromAccountId: account.accountId, toAccountId: account.accountId,
    body, createdAt, deliveredAt: null, readAt: null, direction: 'outgoing', sessionId,
  };
}

test('cloud self-agent canonical identity uses the editable runtime name', () => {
  const plan = planCloudSelfAgentCanonicalSync({
    account,
    agentDisplayName: 'BabyTREE',
    messages: [],
    state: emptyState(),
  });
  assert.equal(plan.agentIdentityRequest.displayName, 'BabyTREE');
});

test('initial model synchronization restores the route without adding a transcript notice', () => {
  const route = { model: 'openai/gpt-6-astra', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: 'medium' };
  const initial: CloudMessage = {
    ...requestMessage('initial-model', '', '2026-09-05T10:00:00.000Z'),
    body: encodeCloudAgentRuntimeRouteChange(route, null, true),
    messageKind: 'agent-model-change',
  };
  assert.equal(isCloudAgentControlMessage(initial.body), true);
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [initial], state: emptyState() });
  assert.equal(plan.messageRequests.length, 0);
  const restored = applySynchronizedCloudAgentRuntimeRoutes({}, account.accountId, [], [initial]);
  assert.deepEqual(restored[cloudAgentRuntimeSessionId(account.accountId, initial.sessionId)!], route);
  assert.equal(isCloudAgentControlMessage(encodeCloudAgentRuntimeRouteChange(route)), false);
});

test('cloud self-agent canonical sync preserves model changes as system events', () => {
  const modelChange: CloudMessage = {
    ...requestMessage('model-change-1', '', '2026-08-16T11:00:00.000Z', 'session:self-agent:model-sync'),
    body: encodeCloudAgentRuntimeRouteChange({
      model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic', thinking: 'xhigh',
    }),
    messageKind: 'agent-model-change',
  };
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [modelChange], state: emptyState() });
  assert.deepEqual(plan.messageRequests.map(({ senderRole, messageKind, contentText }) => ({
    senderRole, messageKind, contentText,
  })), [{
    senderRole: 'system', messageKind: 'agent-model-change',
    contentText: 'Model: anthropic/claude-opus-4-1 · Thinking effort: Extra High',
  }]);
  assert.deepEqual(plan.messageRequests[0]?.content, { agentRuntimeRoute: {
    model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic', thinking: 'xhigh',
  } });
  assert.equal(plan.sessionRequests[0]?.title.includes('Switched model'), false);
});

test('cloud self-agent canonical sync never materializes a local draft session', () => {
  const modelChange: CloudMessage = {
    ...requestMessage('model-change-draft', '', '2026-08-16T11:00:00.000Z', 'draft:local-chat'),
    body: encodeCloudAgentRuntimeRouteChange({
      model: 'openai/gpt-5.6-luna', authProvider: 'openai', thinking: 'high',
    }),
    messageKind: 'agent-model-change',
  };
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [modelChange], state: emptyState() });
  assert.deepEqual(plan.sessionRequests, []);
  assert.deepEqual(plan.messageRequests, []);
});

test('durable self-agent sources skip replay but still anchor a new terminal reply', () => {
  const request = requestMessage(
    'msg_durable_request',
    'prepare the release',
    '2026-08-16T11:00:00.000Z',
  );
  const processing: CloudMessage = {
    ...request,
    messageId: 'msg_durable_processing',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'processing...',
      deliveryState: 'processing',
    }),
  };
  const terminal: CloudMessage = {
    ...request,
    messageId: 'msg_new_terminal',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'The release is ready.',
      deliveryState: 'complete',
    }),
  };
  const durable = new Set([
    request.messageId,
    processing.messageId,
  ]);
  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [request, processing, terminal],
    state: emptyState(),
    durableSourceEventIds: durable,
  });

  assert.equal(plan.messageRequests.length, 1);
  assert.equal(plan.messageRequests[0]?.contentText, 'The release is ready.');
  assert.equal(
    plan.messageRequests[0]?.parentMessageId,
    'msg:cloud:self:msg_durable_request',
  );

  durable.add(terminal.messageId);
  assert.equal(planCloudSelfAgentCanonicalSync({
    account,
    messages: [request, processing, terminal],
    state: emptyState(),
    durableSourceEventIds: durable,
  }).messageRequests.length, 0);
});

test('a delayed reply stays anchored beside its request instead of jumping below newer turns', () => {
  const first = requestMessage('msg_first_request', 'first request', '2026-08-16T16:58:00.000Z');
  const second = requestMessage('msg_second_request', 'second request', '2026-08-16T16:58:01.000Z');
  const response = (request: CloudMessage, id: string, text: string, at: string): CloudMessage => ({
    ...request, messageId: id, createdAt: at,
    body: encodeCloudAgentResponse({ requestId: request.messageId, text, deliveryState: 'complete' }),
  });
  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [
      response(first, 'msg_delayed_first_response', 'first answer', '2026-08-16T16:59:00.000Z'),
      response(second, 'msg_second_response', 'second answer', '2026-08-16T16:58:02.000Z'),
      second,
      first,
    ],
    state: emptyState(),
  });
  const byText = new Map(plan.messageRequests.map((message) => [message.contentText, message]));
  assert.equal(byText.get('first answer')?.createdAtMs, Date.parse(first.createdAt) + 1);
  assert.equal(byText.get('second answer')?.createdAtMs, Date.parse(second.createdAt) + 1);
  assert.ok((byText.get('first answer')?.createdAtMs ?? 0) < Date.parse(second.createdAt));
});

test('new owner execution snapshots replace older processing content in the stable response slot', () => {
  const request = requestMessage('msg_self_request_stream', 'check the current status', '2026-08-08T09:49:00.000Z');
  const snapshot = (
    id: string, at: string, phase: 'analyzing' | 'using-tool', summary: string, updatedAtMs: number,
  ): CloudMessage => ({
    ...request, messageId: id, createdAt: at,
    body: encodeCloudAgentResponse({
      requestId: request.messageId, text: 'processing...', deliveryState: 'processing',
      execution: {
        phase, summary,
        thinkingText: phase === 'using-tool' ? 'I need to check the current status.' : undefined,
        tools: phase === 'using-tool' ? [{
          id: 'web-search', name: 'Web Search', status: 'running',
          arguments: '{"query":"current status"}', liveOutput: 'Searching the index', isError: false,
        }] : undefined,
        steps: [{ id: phase, label: summary, state: 'running' }], updatedAtMs, completed: false,
      },
    }),
  });
  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [
      snapshot('msg_self_execution_2', '2026-08-08T09:49:02.000Z', 'using-tool', 'Using Web Search', 2_000),
      request,
      snapshot('msg_self_execution_1', '2026-08-08T09:49:01.000Z', 'analyzing', 'Analyzing the request', 1_000),
    ],
    state: emptyState(),
  });
  const response = plan.messageRequests.find((message) => message.senderRole === 'owned-agent');
  const content = response?.content as {
    executionSummary?: string;
    thinkingText?: string;
    tools?: Array<{ name: string; arguments: string; liveOutput: string }>;
  };
  assert.equal(response?.id, 'msg:cloud:self:response:msg_self_request_stream');
  assert.equal(response?.status, 'processing');
  assert.equal(content.executionSummary, 'Using Web Search');
  assert.equal(content.thinkingText, 'I need to check the current status.');
  assert.equal(content.tools?.[0]?.name, 'Web Search');
});

test('late shorter processing snapshots cannot regress canonical partial output', () => {
  const request = requestMessage(
    'msg_self_request_partial',
    'prepare the rollout',
    '2026-08-08T09:49:00.000Z',
  );
  const partial = (id: string, at: string, text: string): CloudMessage => ({
    ...request,
    messageId: id,
    createdAt: at,
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text,
      deliveryState: 'processing',
    }),
  });
  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [
      request,
      partial(
        'msg_self_partial_long',
        '2026-08-08T09:49:01.000Z',
        'The rollout is nearly ready.',
      ),
      partial(
        'msg_self_partial_late_short',
        '2026-08-08T09:49:02.000Z',
        'The rollout',
      ),
    ],
    state: emptyState(),
  });

  const response = plan.messageRequests.find(
    (message) => message.senderRole === 'owned-agent',
  );
  assert.equal(response?.contentText, 'The rollout is nearly ready.');
  assert.equal(response?.status, 'processing');
});

test('cloud self-agent canonical sync reuses the local runtime response on the executing Mac', () => {
  const sessionId = 'local-self-session';
  const localRequestId = 'local-u1';
  const localResponseId = 'local-a1';
  const cloudRequestId = 'cloud-u1';
  const cloudRequest: CloudMessage = {
    ...requestMessage(cloudRequestId, 'testtest', '2026-08-16T15:00:00.000Z', sessionId),
    clientMessageId: cloudSelfAgentRequestClientMessageId(sessionId, localRequestId),
  };
  const cloudResponse: CloudMessage = {
    ...cloudRequest, messageId: 'cloud-a1', createdAt: '2026-08-16T15:00:04.000Z',
    body: encodeCloudAgentResponse({
      requestId: cloudRequestId,
      text: 'Received “testtest” successfully — the chat connection is working.',
      deliveryState: 'complete',
    }),
    clientMessageId: cloudSelfAgentResponseClientMessageId(sessionId, localRequestId),
    canonicalHistoryLocalMessageId: localResponseId,
  };
  const cloudProcessing: CloudMessage = {
    ...cloudResponse, messageId: 'cloud-processing-a1', createdAt: '2026-08-16T15:00:02.000Z',
    body: encodeCloudAgentResponse({
      requestId: cloudRequestId, text: 'processing...', deliveryState: 'processing',
    }),
    clientMessageId: `${cloudResponse.clientMessageId}:processing`,
    canonicalHistoryLocalMessageId: null,
  };
  const localRequest: CanonicalSessionMessage = {
    id: localRequestId, sessionId, senderIdentityId: 'human:acct_me', senderRole: 'user',
    messageKind: 'text', contentText: 'testtest', status: 'sent', sequenceNum: 1,
    createdAtMs: Date.parse(cloudRequest.createdAt), updatedAtMs: Date.parse(cloudRequest.createdAt),
    sourceTransport: 'desktop-chat',
  };
  const localResponse: CanonicalSessionMessage = {
    id: localResponseId, sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: 'Received “testtest” successfully — the chat connection is working.',
    content: { requestId: localRequestId }, parentMessageId: localRequestId, status: 'complete', sequenceNum: 2,
    createdAtMs: Date.parse(cloudResponse.createdAt), updatedAtMs: Date.parse(cloudResponse.createdAt),
    sourceTransport: 'desktop-chat',
  };
  const duplicate: CanonicalSessionMessage = {
    ...localResponse, id: `msg:cloud:self:response:${cloudRequestId}`, status: 'processing',
    contentText: 'processing...', content: { requestId: localRequestId, deliveryState: 'processing' },
    sequenceNum: 3, sourceTransport: 'cloud-self-agent', sourceEventId: cloudProcessing.messageId,
  };
  const state = emptyState([localRequest, localResponse, duplicate]);
  state.sessions = [{
    id: sessionId, kind: 'self-agent', title: 'testtest', status: 'active',
    createdByIdentityId: 'human:acct_me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1,
  }];
  const plan = planCloudSelfAgentCanonicalSync({
    account, messages: [cloudRequest, cloudProcessing, cloudResponse], state,
  });
  assert.deepEqual(plan.messageRequests.map((message) => message.id), [localResponseId]);
  assert.deepEqual(plan.mirrorReconciliations, [{
    preferredMessageId: localResponseId,
    duplicateMessageId: `msg:cloud:self:response:${cloudRequestId}`,
  }]);
});
