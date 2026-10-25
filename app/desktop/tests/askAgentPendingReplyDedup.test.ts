import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { projectCloudSelfAgentLiveTurns } from '../src/features/cloud/cloudGroupLiveProjection';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';
import { hostedSelfAgentProgressId } from '../src/features/cloud/hostedSelfAgentRunProgress';
import { nextPendingSelfAgentDeadlineMs, PENDING_SELF_AGENT_START_TIMEOUT_MS, projectPendingSelfAgentReplies } from '../src/features/cloud/cloudSelfAgentPendingReply';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { canDisplayAgentTurn } from '../src/features/chat/agentProcessingVisibility';
import type { CanonicalSessionMessage, CanonicalSessionState, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

// A private chat with the owner's own agent on a Mac-first route: the Mac
// publishes the request, claims its run, runs the turn locally and publishes
// a processing agent-response within ~300 ms. That response can be stored
// before the local request is linked to its Cloud id, so the stored row has
// no parent yet. One processing row must still show for the request.

const account = { accountId: 'acct_owner', displayName: 'Owner', primaryEmail: 'owner@example.com', avatarUrl: null, nodeId: 'node', passwordSet: true } as unknown as CloudAccount;
const sessionId = '00000000-0000-4000-8000-0000000000dd';
const humanId = 'human:acct_owner';
const agentId = 'agent:cloud-self:acct_owner';
const route = { model: 'openai-codex/gpt-6.1-sol', authProvider: 'openai-codex', authChoice: 'cloud-login:synthetic', thinking: 'medium' };
const sentAtMs = Date.now() - 2_000;
const wireRequestId = '01a16f74-0000-7000-8000-000000000001';
const localRequest = {
  id: 'msg:ui:request', sessionId, senderIdentityId: humanId, senderRole: 'user', messageKind: 'text',
  contentText: 'I am usually free after 3pm', content: { agentRuntimeRoute: route, deliveryState: 'sent', attachments: [], mentions: [] },
  parentMessageId: null, delegatedExchangeId: null, status: 'sent', sequenceNum: 1,
  createdAtMs: sentAtMs, updatedAtMs: sentAtMs, sourceTransport: 'desktop-chat-ui', sourceEventId: `desktop-chat-ui:${sessionId}:${sentAtMs}`,
} as CanonicalSessionMessage;
const baseState = {
  storagePath: '/tmp/canonical.sqlite3',
  profile: { id: 'profile', displayName: 'Owner', humanIdentityId: humanId, storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
  identities: [
    { id: humanId, kind: 'human', displayName: 'Owner', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
    { id: agentId, kind: 'agent', displayName: 'Kordi', source: 'cloud', ownerIdentityId: humanId, avatarKey: 'agent', createdAtMs: 1, updatedAtMs: 1 },
  ],
  sessions: [{ id: sessionId, kind: 'self-agent', title: 'Chat', status: 'active', createdByIdentityId: humanId,
    primaryIdentityId: agentId, relationshipIdentityId: null, metadata: {}, createdAtMs: sentAtMs - 10, updatedAtMs: sentAtMs, lastMessageAtMs: sentAtMs }],
  participants: [
    { sessionId, identityId: humanId, role: 'self', state: 'active', addedByIdentityId: humanId, addedAtMs: 1 },
    { sessionId, identityId: agentId, role: 'owned-agent', state: 'active', addedByIdentityId: humanId, addedAtMs: 1 },
  ],
  messages: [localRequest], delegatedExchanges: [], presence: [], contextSnapshots: [],
} as unknown as CanonicalSessionState;

const cloud = (messageId: string, body: string, offsetMs: number, extra: Partial<CloudMessage> = {}): CloudMessage => ({
  messageId, fromAccountId: account.accountId, toAccountId: account.accountId, body, sessionId,
  createdAt: new Date(sentAtMs + offsetMs).toISOString(), deliveredAt: null, readAt: null, ...extra,
});
const wireRequest = cloud(wireRequestId, encodeCloudDirectMessageEnvelope({
  schemaVersion: 1, kind: 'message', text: localRequest.contentText,
  targetCloudAgentId: `cloud-agent:${account.accountId}`, targetCloudAgentName: 'Kordi', targetCloudAgentOwnerAccountId: account.accountId,
  agentRuntimeRoute: route,
}), 100, { clientMessageId: cloudSelfAgentRequestClientMessageId(sessionId, localRequest.id) });
const agentResponse = (messageId: string, text: string, deliveryState: 'processing' | 'complete', offsetMs: number) => cloud(messageId, encodeCloudAgentResponse({
  requestId: wireRequestId, text, deliveryState,
  execution: { phase: deliveryState === 'processing' ? 'running' : 'complete', summary: 'Working', steps: [],
    startedAtMs: sentAtMs + 300, updatedAtMs: sentAtMs + offsetMs, completed: deliveryState !== 'processing' },
}), offsetMs);
const placeholder = agentResponse('response-processing', '', 'processing', 400);
const reply = 'Noted: you are usually free after 15:00.';

/** Stores a sync plan's rows the way the canonical store does: upsert by id. */
function store(state: CanonicalSessionState, messages: CloudMessage[]): CanonicalSessionState {
  const plan = planCloudSelfAgentCanonicalSync({ account, messages, state });
  let rows = [...state.messages];
  for (const request of plan.messageRequests) {
    const existing = rows.find((row) => row.id === request.id);
    const row = {
      id: request.id ?? '', sessionId: request.sessionId, senderIdentityId: request.senderIdentityId,
      senderRole: request.senderRole, messageKind: request.messageKind, contentText: request.contentText,
      content: request.content, parentMessageId: request.parentMessageId ?? null, delegatedExchangeId: null,
      status: request.status ?? 'sent', sequenceNum: existing?.sequenceNum ?? rows.length + 1,
      createdAtMs: request.createdAtMs ?? Date.now(), updatedAtMs: Date.now(),
      sourceTransport: request.sourceTransport ?? null, sourceEventId: request.sourceEventId ?? null,
    } as CanonicalSessionMessage;
    rows = existing ? rows.map((candidate) => (candidate.id === row.id ? row : candidate)) : [...rows, row];
  }
  return { ...state, messages: rows };
}

const liveTurn = (completed: boolean): DesktopChatTurnSnapshot => ({
  id: 'native-turn', sessionId, prompt: localRequest.contentText, status: completed ? 'succeeded' : 'streaming',
  message: '', assistantText: completed ? reply : '', thinkingText: '', tools: [], completed, succeeded: completed,
  startedAtMs: sentAtMs + 300, ...(completed ? { completedAtMs: sentAtMs + 1_500 } : {}), replyToMessageId: wireRequestId,
});

/** The transcript rows the app builds: stored rows, the Mac's turn and the pending reply. */
function agentRows(state: CanonicalSessionState, turns: Record<string, DesktopChatTurnSnapshot>, cloudMessages: CloudMessage[]): Message[] {
  const projected = projectPendingSelfAgentReplies(projectCloudSelfAgentLiveTurns(state, turns), Date.now(), { turns, cloudMessages });
  const messages = createCanonicalSessionReadModel(projected)!.messages(sessionId);
  return messages.filter((message) => message.role === 'owned-agent' && message.turn && canDisplayAgentTurn(message.turn, messages));
}

// The processing response was stored before the request was linked to its Cloud id.
const storedEarly = store(baseState, [placeholder]);

for (const [label, cloudMessages] of [
  ['the request is indexed', [wireRequest, placeholder]],
  ['the request is not indexed yet', [placeholder]],
] as const) {
  test(`one processing row per Ask Agent request while the Mac runs it (${label})`, () => {
    const running = agentRows(storedEarly, { [wireRequestId]: liveTurn(false) }, [...cloudMessages]);
    assert.equal(running.length, 1, `processing rows: ${running.map((row) => row.id).join(', ')}`);
    assert.equal(running[0].turn?.completed, false);
    assert.ok(running[0].turn?.startedAtMs, 'the row follows the local live turn');

    const done = agentRows(storedEarly, { [wireRequestId]: liveTurn(true) }, [...cloudMessages]);
    assert.equal(done.length, 1, `rows after the turn: ${done.map((row) => row.id).join(', ')}`);
    assert.equal(done[0].turn?.completed, true);
    assert.equal(done[0].turn?.assistantText, reply, 'the reply shows as soon as the local turn completes');
  });
}

test('the synced placeholder alone still shows, and completes without a live turn', () => {
  const linked = { ...baseState, messages: [{ ...localRequest, content: { ...(localRequest.content as object), desktopEntryId: wireRequestId } }] };
  const processing = agentRows(store(linked, [wireRequest, placeholder]), {}, [wireRequest, placeholder]);
  assert.equal(processing.length, 1);
  assert.equal(processing[0].turn?.completed, false);
  const final = agentResponse('response-final', reply, 'complete', 1_600);
  const complete = agentRows(store(store(linked, [wireRequest, placeholder]), [wireRequest, placeholder, final]), {}, [wireRequest, placeholder, final]);
  assert.equal(complete.length, 1);
  assert.equal(complete[0].turn?.completed, true);
  assert.equal(complete[0].turn?.assistantText, reply);
});

// A message typed while the agent was busy is queued, then dispatched with the
// content the dispatch path writes. Its row keeps the `queued-local-chat:` id,
// and its Cloud id is linked later, so the Mac's processing reply is stored
// before the link exists.
const queuedRequestId = `queued-local-chat:${sessionId}:1`;
const queuedRequest = {
  ...localRequest,
  id: queuedRequestId,
  content: {
    agentRuntimeRoute: route, deliveryState: 'sent', attachments: [], mentions: [],
    timestampMs: sentAtMs, queuedMessage: true, queueState: 'sent', queueUpdatedAtMs: sentAtMs,
  },
  sourceEventId: `desktop-chat-ui:${queuedRequestId}`,
} as CanonicalSessionMessage;
const queuedState = { ...baseState, messages: [queuedRequest] } as CanonicalSessionState;

function pendingRows(state: CanonicalSessionState, cloudMessages: CloudMessage[]) {
  const projected = projectPendingSelfAgentReplies(state, Date.now(), { turns: {}, cloudMessages });
  return projected!.messages.filter((message) => message.senderRole === 'owned-agent');
}

/** The early reply as stored when its parent is the Cloud request id, which no local row has. */
const withCloudParent = (state: CanonicalSessionState, parentMessageId: string | null) => ({
  ...state,
  messages: state.messages.map((message) => (message.senderRole === 'owned-agent' ? { ...message, parentMessageId } : message)),
});

for (const [label, parent] of [['without a parent', null], ['with the Cloud request id as parent', wireRequestId]] as const) {
  test(`a dispatched queued request shows one processing row beside its early stored reply (${label})`, () => {
    const stored = withCloudParent(store(queuedState, [placeholder]), parent);
    const rows = pendingRows(stored, [placeholder]);
    assert.deepEqual(rows.filter((row) => row.id.startsWith('msg:cloud:self:pending:')).map((row) => row.id), [],
      `rows: ${rows.map((row) => `${row.id} parent=${row.parentMessageId}`).join(', ')}`);
    assert.equal(agentRows(stored, {}, [placeholder]).length, 1);
  });
}

test('an early reply for another local request does not answer the dispatched queued request', () => {
  // No Cloud id names the other request yet: only the parent rule tells the replies apart.
  const other = { ...localRequest, id: 'msg:ui:other', createdAtMs: sentAtMs - 500 } as CanonicalSessionMessage;
  const stored = withCloudParent(store({ ...queuedState, messages: [other, queuedRequest] }, [placeholder]), 'msg:ui:other');
  const rows = pendingRows(stored, [placeholder]);
  assert.deepEqual(rows.filter((row) => row.id.startsWith('msg:cloud:self:pending:')).map((row) => row.id), [`msg:cloud:self:pending:${queuedRequestId}`]);
});

test('a dispatched queued request shows a processing row until its reply is stored', () => {
  const rows = pendingRows(queuedState, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, `msg:cloud:self:pending:${queuedRequestId}`);
});

// The server run's progress row, as `updateHostedSelfAgentProgress` stores it.
const progressRow = {
  id: hostedSelfAgentProgressId(wireRequestId), sessionId, senderIdentityId: agentId, senderRole: 'owned-agent', messageKind: 'agent-turn',
  contentText: '', content: { cloudRequestMessageId: wireRequestId, requestId: queuedRequestId, replyToMessageId: queuedRequestId, deliveryState: 'processing', hostedRunStatus: 'running' },
  parentMessageId: queuedRequestId, delegatedExchangeId: null, status: 'processing', sequenceNum: 2,
  createdAtMs: sentAtMs + 1, updatedAtMs: sentAtMs + 1, sourceTransport: 'cloud-self-agent-progress', sourceEventId: wireRequestId,
} as CanonicalSessionMessage;

test('a dispatched queued request folds the hosted progress row beside its stored reply', () => {
  const stored = { ...store(queuedState, [placeholder]), };
  const state = { ...stored, messages: [...stored.messages, progressRow] };
  const rows = pendingRows(state, [placeholder]);
  assert.deepEqual(rows.map((row) => row.id), [`msg:cloud:self:response:${wireRequestId}`]);
  assert.equal(agentRows(state, {}, [placeholder]).length, 1);
});

test('a dispatched queued request folds the hosted progress row into its pending row', () => {
  const state = { ...queuedState, messages: [...queuedState.messages, progressRow] };
  const rows = pendingRows(state, []);
  assert.deepEqual(rows.map((row) => row.id), [`msg:cloud:self:pending:${queuedRequestId}`]);
  assert.equal(agentRows(state, {}, []).length, 1);
});

test('a message queued while the agent works does not bring back the run progress row of the request before it', () => {
  // A direct send whose stored reply and progress row exist, then a newer queued message.
  const linked = { ...localRequest, content: { ...(localRequest.content as object), desktopEntryId: wireRequestId } } as CanonicalSessionMessage;
  const stored = store({ ...baseState, messages: [linked] } as CanonicalSessionState, [placeholder]);
  const directProgress = { ...progressRow, content: { ...(progressRow.content as object), requestId: linked.id, replyToMessageId: linked.id }, parentMessageId: linked.id } as CanonicalSessionMessage;
  const newerQueued = {
    ...queuedRequest, id: `queued-local-chat:${sessionId}:2`, createdAtMs: sentAtMs + 900, status: 'queued',
    content: { ...(queuedRequest.content as object), queueState: 'queued', deliveryState: 'queued' },
  } as CanonicalSessionMessage;
  const state = { ...stored, messages: [...stored.messages, directProgress, newerQueued] };
  const projected = projectPendingSelfAgentReplies(state, sentAtMs + 1_000, { cloudMessages: [placeholder] });
  assert.equal(projected?.messages.some((message) => message.sourceTransport === 'cloud-self-agent-progress'), false);
  assert.equal(projected?.messages.filter((message) => message.senderRole === 'owned-agent').length, 1);
});

test('a request that waited in the queue is timed from when it was sent', () => {
  const queuedAtMs = sentAtMs - 60_000;
  const waited = { ...queuedRequest, createdAtMs: queuedAtMs, updatedAtMs: sentAtMs } as CanonicalSessionMessage;
  const state = { ...baseState, messages: [waited] } as CanonicalSessionState;
  const rows = projectPendingSelfAgentReplies(state, sentAtMs + 1_000, { turns: {}, cloudMessages: [] })!
    .messages.filter((message) => message.senderRole === 'owned-agent');
  assert.deepEqual(rows.map((row) => row.id), [`msg:cloud:self:pending:${queuedRequestId}`], 'still waiting, not "did not start"');
  assert.equal(nextPendingSelfAgentDeadlineMs(state, sentAtMs + 1_000), sentAtMs + PENDING_SELF_AGENT_START_TIMEOUT_MS);
});

test('a sent request keeps its processing row while another message waits in the queue', () => {
  const waiting = {
    ...queuedRequest, id: `queued-local-chat:${sessionId}:2`, createdAtMs: sentAtMs + 500, status: 'queued',
    content: { ...(queuedRequest.content as object), queueState: 'queued', queueUpdatedAtMs: sentAtMs + 500 },
  } as CanonicalSessionMessage;
  const rows = pendingRows({ ...baseState, messages: [queuedRequest, waiting] } as CanonicalSessionState, []);
  assert.deepEqual(rows.map((row) => row.id), [`msg:cloud:self:pending:${queuedRequestId}`]);
});
