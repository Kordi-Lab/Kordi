import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pendingSelfAgentReplyId, projectPendingSelfAgentReplies, PENDING_SELF_AGENT_REPLY_WINDOW_MS } from '../src/features/cloud/cloudSelfAgentPendingReply';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

const sessionId = 'session:self-agent:pending';
const hostedRoute = { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' };
const request: CanonicalSessionMessage = {
  id: 'msg:ui:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text',
  contentText: 'Write a story', content: { agentRuntimeRoute: hostedRoute, deliveryState: 'sent' },
  parentMessageId: null, delegatedExchangeId: null, status: 'sent', sequenceNum: 3,
  createdAtMs: 10_000, updatedAtMs: 10_000, sourceTransport: 'desktop-chat-ui', sourceEventId: 'desktop-chat-ui:request',
};
const state = (messages: CanonicalSessionMessage[]) => ({
  storagePath: '/tmp/test', identities: [], participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
  profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 },
  sessions: [{ id: sessionId, kind: 'self-agent', title: 'Ask Agent', status: 'active', createdAtMs: 1,
    primaryIdentityId: 'agent:me', participantIdentityIds: ['agent:me'], createdByIdentityId: 'human:me' }],
  messages,
}) as unknown as CanonicalSessionState;
const pendingRow = (projected: CanonicalSessionState | null) => projected?.messages
  .find((message) => message.id === pendingSelfAgentReplyId(request.id));

test('a sent hosted request shows a processing reply right away', () => {
  const row = pendingRow(projectPendingSelfAgentReplies(state([request]), 10_050));
  assert.equal(row?.status, 'processing');
  assert.equal(row?.senderRole, 'owned-agent');
  assert.equal(row?.parentMessageId, request.id);
  assert.equal(row?.createdAtMs, request.createdAtMs + 1, 'it sits where the stored reply will');
});

test('any reply row for the request replaces the pending row', () => {
  for (const content of [
    { cloudRequestMessageId: 'wire', deliveryState: 'processing' },
    { cloudRequestMessageId: 'wire', deliveryState: 'cancelled' },
    { deliveryState: 'queued', hostedRunStatus: 'queued' },
  ]) {
    const reply = {
      ...request, id: 'msg:cloud:self:response:wire', senderIdentityId: 'agent:me', senderRole: 'owned-agent',
      messageKind: 'agent-turn', contentText: '', content, parentMessageId: request.id, status: 'processing',
      sourceTransport: 'cloud-self-agent', sourceEventId: 'wire-response',
    } as CanonicalSessionMessage;
    assert.equal(pendingRow(projectPendingSelfAgentReplies(state([request, reply]), 10_050)), undefined);
  }
});

test('no pending row for failed, queued, local, stale or older requests', () => {
  const cases: CanonicalSessionMessage[][] = [
    [{ ...request, status: 'failed' }],
    [{ ...request, content: { ...request.content as object, queuedMessage: true, queueState: 'queued' } }],
    [{ ...request, content: { deliveryState: 'sent' } }],
  ];
  for (const messages of cases) {
    assert.equal(pendingRow(projectPendingSelfAgentReplies(state(messages), 10_050)), undefined);
  }
  assert.equal(pendingRow(projectPendingSelfAgentReplies(
    state([request]), request.createdAtMs + PENDING_SELF_AGENT_REPLY_WINDOW_MS + 1,
  )), undefined);
  const newer = { ...request, id: 'msg:ui:newer', createdAtMs: 20_000, content: { deliveryState: 'sent' } };
  assert.equal(pendingRow(projectPendingSelfAgentReplies(state([request, newer]), 20_050)), undefined);
  const untouched = state([request]);
  assert.equal(projectPendingSelfAgentReplies(untouched, 99_999_999), untouched, 'state is unchanged without a pending row');
});

test('the pending row renders as a running reply with a stop', async () => {
  const { mapCanonicalMessage } = await import('../src/features/canonical/readModel/messageMapping');
  const { agentRequestStopTarget } = await import('../src/features/chat/agentRequestStop');
  const row = pendingRow(projectPendingSelfAgentReplies(state([request]), 10_050))!;
  const identities = new Map([['agent:me', { id: 'agent:me', kind: 'agent', displayName: 'Agent', ownerIdentityId: 'human:me' }]]);
  const mapped = mapCanonicalMessage(row, identities as never, 'human:me');
  assert.equal(mapped?.turn?.completed, false);
  assert.notEqual(agentRequestStopTarget(mapped?.turn, mapped!), null);
});
