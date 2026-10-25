import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  nextPendingSelfAgentDeadlineMs, pendingSelfAgentNoticeRowId, pendingSelfAgentReplyId, projectPendingSelfAgentReplies,
  PENDING_SELF_AGENT_ATTACHMENT_START_TIMEOUT_MS, PENDING_SELF_AGENT_NOT_STARTED_TEXT, PENDING_SELF_AGENT_START_TIMEOUT_MS,
} from '../src/features/cloud/cloudSelfAgentPendingReply';
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
  .find((message) => [pendingSelfAgentReplyId(request.id), pendingSelfAgentNoticeRowId(request.id)].includes(message.id));

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

test('the server run\'s progress row is folded into the pending row', () => {
  const hosted = {
    ...request, id: 'msg:cloud:self:progress:wire', senderIdentityId: 'agent:me', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: '', content: { cloudRequestMessageId: 'wire', deliveryState: 'queued', hostedRunStatus: 'queued' },
    parentMessageId: request.id, status: 'queued', sourceTransport: 'cloud-self-agent-progress', sourceEventId: 'wire',
  } as CanonicalSessionMessage;
  const projected = projectPendingSelfAgentReplies(state([request, hosted]), 10_050)!;
  const row = pendingRow(projected);
  assert.equal(row?.status, 'processing', 'the pending row stays and keeps processing');
  assert.equal(projected.messages.some((message) => message.id === hosted.id), false, 'the run row does not show as a second reply');
  // A run that exists on the server did start: the row never says it did not.
  const late = pendingRow(projectPendingSelfAgentReplies(state([request, hosted]), 10_000 + 60_000)!);
  assert.equal(late?.status, 'processing');
  assert.equal(nextPendingSelfAgentDeadlineMs(state([request, hosted]), 10_050), null, 'no not-started deadline while the run exists');
});

test('no pending row for failed, queued, local or older requests', () => {
  const cases: CanonicalSessionMessage[][] = [
    [{ ...request, status: 'failed' }],
    [{ ...request, content: { ...request.content as object, queuedMessage: true, queueState: 'queued' } }],
    [{ ...request, content: { deliveryState: 'sent' } }],
  ];
  for (const messages of cases) {
    assert.equal(pendingRow(projectPendingSelfAgentReplies(state(messages), 10_050)), undefined);
  }
  const newer = { ...request, id: 'msg:ui:newer', createdAtMs: 20_000, content: { deliveryState: 'sent' } };
  assert.equal(pendingRow(projectPendingSelfAgentReplies(state([request, newer]), 20_050)), undefined);
  const answered = state([request, { ...request, id: 'reply', senderRole: 'owned-agent', parentMessageId: request.id }]);
  assert.equal(projectPendingSelfAgentReplies(answered, 99_999_999), answered, 'state is unchanged without a pending row');
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

test('a request that no run answers in time becomes an actionable failed reply', async () => {
  const late = pendingRow(projectPendingSelfAgentReplies(state([request]), request.createdAtMs + PENDING_SELF_AGENT_START_TIMEOUT_MS + 1));
  assert.equal(late?.status, 'failed');
  assert.equal((late?.content as Record<string, unknown>).error, PENDING_SELF_AGENT_NOT_STARTED_TEXT);
  assert.equal(late?.id, pendingSelfAgentNoticeRowId(request.id), 'the notice never takes the id a live reply will use');
  const { mapCanonicalMessage } = await import('../src/features/canonical/readModel/messageMapping');
  const { agentRequestStopTarget } = await import('../src/features/chat/agentRequestStop');
  const identities = new Map([['agent:me', { id: 'agent:me', kind: 'agent', displayName: 'Agent', ownerIdentityId: 'human:me' }]]);
  const mapped = mapCanonicalMessage(late!, identities as never, 'human:me');
  assert.equal(mapped?.turn?.completed, true);
  assert.equal(agentRequestStopTarget(mapped?.turn, mapped!), null, 'a request that never started offers no stop');
  assert.equal(nextPendingSelfAgentDeadlineMs(state([request]), request.createdAtMs), request.createdAtMs + PENDING_SELF_AGENT_START_TIMEOUT_MS);
  const withImage = { ...request, content: { ...request.content as object, attachments: [{ kind: 'image', name: 'Screenshot.png' }] } };
  assert.equal(pendingRow(projectPendingSelfAgentReplies(state([withImage]), request.createdAtMs + PENDING_SELF_AGENT_START_TIMEOUT_MS + 1))?.status, 'processing', 'an upload gets longer');
  assert.equal(pendingRow(projectPendingSelfAgentReplies(state([withImage]), request.createdAtMs + PENDING_SELF_AGENT_ATTACHMENT_START_TIMEOUT_MS + 1))?.status, 'failed');
});
