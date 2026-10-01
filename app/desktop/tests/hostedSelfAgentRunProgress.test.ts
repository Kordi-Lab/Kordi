import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { canDisplayAgentTurn } from '../src/features/chat/agentProcessingVisibility';
import {
  hostedSelfAgentProgressId,
  removeHostedSelfAgentProgress,
  updateHostedSelfAgentProgress,
} from '../src/features/cloud/hostedSelfAgentRunProgress';

const sessionId = 'session:self-agent:hosted';
const requestId = 'cloud-request-1';
const localId = 'local-request-1';
const request: CloudMessage = {
  messageId: requestId, fromAccountId: 'acct', toAccountId: 'acct',
  sessionId, body: 'Hi', createdAt: '2026-09-29T10:00:00Z',
  deliveredAt: null, readAt: null, direction: 'outgoing',
  clientMessageId: cloudSelfAgentRequestClientMessageId(sessionId, localId),
};

function state(): CanonicalSessionState {
  return {
    storagePath: '/tmp/test',
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct', createdAtMs: 1, updatedAtMs: 1 },
    identities: [], participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    sessions: [{ id: sessionId, kind: 'self-agent', title: 'Chat', status: 'active', createdAtMs: 1,
      primaryIdentityId: 'agent:acct', participantIdentityIds: ['agent:acct'], createdByIdentityId: 'human:acct' }],
    messages: [{ id: localId, sessionId, senderIdentityId: 'human:acct', senderRole: 'user',
      messageKind: 'text', contentText: 'Hi', content: {}, parentMessageId: null,
      status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10,
      sourceTransport: 'desktop-chat-ui', sourceEventId: null }],
  } as CanonicalSessionState;
}

test('confirmed hosted run shows a single request-linked queued then running turn', () => {
  const queued = updateHostedSelfAgentProgress(state(), { request, runStatus: 'queued', cloudMessages: [request] })!;
  const row = queued.messages.find((message) => message.id === hostedSelfAgentProgressId(requestId))!;
  assert.equal(row.status, 'queued');
  assert.equal((row.content as Record<string, unknown>).hostedRunStatus, 'queued');
  assert.equal(row.parentMessageId, localId);
  assert.equal(row.senderIdentityId, 'agent:acct');
  const transcript = createCanonicalSessionReadModel(queued)!.messages(sessionId);
  const queuedTurn = transcript.find((message) => message.id === row.id)?.turn;
  assert.equal(queuedTurn?.hostedRunStatus, 'queued');
  assert.equal(canDisplayAgentTurn(queuedTurn!, transcript), true);
  const running = updateHostedSelfAgentProgress(queued, { request, runStatus: 'running', cloudMessages: [request] })!;
  assert.equal(running.messages.length, 2);
  assert.equal(running.messages[1].status, 'processing');
  assert.equal((running.messages[1].content as Record<string, unknown>).hostedRunStatus, 'running');
  assert.equal(updateHostedSelfAgentProgress(running, { request, runStatus: 'running', cloudMessages: [request] }), running);
  assert.equal(removeHostedSelfAgentProgress(running, requestId)?.messages.length, 1);
});

test('response or terminal run clears progress and a stale poll cannot resurrect it', () => {
  const running = updateHostedSelfAgentProgress(state(), { request, runStatus: 'running', cloudMessages: [request] })!;
  const response: CloudMessage = { ...request, messageId: 'response-1', body: encodeCloudAgentResponse({
    requestId, text: 'Hello', deliveryState: 'complete',
  }) };
  const cleared = updateHostedSelfAgentProgress(running, { request, runStatus: 'running', cloudMessages: [request, response] })!;
  assert.equal(cleared.messages.length, 1);
  assert.equal(updateHostedSelfAgentProgress(cleared, { request, runStatus: 'running', cloudMessages: [request, response] }), cleared);
  assert.equal(updateHostedSelfAgentProgress(running, { request, runStatus: 'failed', cloudMessages: [request] })?.messages.length, 1);
});

test('real response progress replaces the local indicator for the same request only', () => {
  const running = updateHostedSelfAgentProgress(state(), { request, runStatus: 'running', cloudMessages: [request] })!;
  const withOtherResponse = { ...running, messages: [...running.messages, {
    ...running.messages[1], id: 'real-other', sourceTransport: 'cloud-self-agent',
    content: { cloudRequestMessageId: 'other-request' },
  }] };
  assert.equal(updateHostedSelfAgentProgress(withOtherResponse, { request, runStatus: 'running', cloudMessages: [request] }), withOtherResponse);
  const withRealResponse = { ...withOtherResponse, messages: [...withOtherResponse.messages, {
    ...running.messages[1], id: 'real-this', sourceTransport: 'cloud-self-agent',
  }] };
  const cleared = updateHostedSelfAgentProgress(withRealResponse, { request, runStatus: 'running', cloudMessages: [request] })!;
  assert.equal(cleared.messages.some((message) => message.id === hostedSelfAgentProgressId(requestId)), false);
  assert.equal(cleared.messages.some((message) => message.id === 'real-other'), true);
  assert.equal(cleared.messages.some((message) => message.id === 'real-this'), true);
});

test('no local request identity means no speculative processing row', () => {
  const mismatched = { ...request, clientMessageId: 'different' };
  const current = state();
  assert.equal(updateHostedSelfAgentProgress(current, { request: mismatched, runStatus: 'running', cloudMessages: [mismatched] }), current);
});
