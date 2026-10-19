import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { projectCloudSelfAgentLiveTurns } from '../src/features/cloud/cloudGroupLiveProjection';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';
import { projectPendingSelfAgentReplies } from '../src/features/cloud/cloudSelfAgentPendingReply';
import { removeHostedSelfAgentProgress, updateHostedSelfAgentProgress } from '../src/features/cloud/hostedSelfAgentRunProgress';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudCollaborationState';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { agentRequestStopTarget } from '../src/features/chat/agentRequestStop';
import type { CanonicalSessionMessage, CanonicalSessionState, DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Owner', primaryEmail: 'owner@example.com', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};
const sessionId = '00000000-0000-4000-8000-0000000000cc';
const agentId = 'agent:cloud-self:acct_me';
const route = { model: 'openai-codex/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic', thinking: 'high' };
const sentAtMs = Date.now() - 5_000;
const localRequest: CanonicalSessionMessage = {
  id: 'msg:ui:request', sessionId, senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text',
  contentText: 'Three steps to make tea', content: { agentRuntimeRoute: route, deliveryState: 'sent', attachments: [], mentions: [] },
  parentMessageId: null, delegatedExchangeId: null, status: 'sent', sequenceNum: 1,
  createdAtMs: sentAtMs, updatedAtMs: sentAtMs, sourceTransport: 'desktop-chat-ui', sourceEventId: `desktop-chat-ui:${sessionId}:1`,
};
const baseState = {
  storagePath: '/tmp/canonical.sqlite3',
  profile: { id: 'profile', displayName: 'Owner', humanIdentityId: 'human:acct_me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
  identities: [
    { id: 'human:acct_me', kind: 'human', displayName: 'Owner', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
    { id: agentId, kind: 'agent', displayName: 'Agent', source: 'cloud', ownerIdentityId: 'human:acct_me', avatarKey: 'agent', createdAtMs: 1, updatedAtMs: 1 },
  ],
  sessions: [{ id: sessionId, kind: 'self-agent', title: 'Tea', status: 'active', createdByIdentityId: 'human:acct_me',
    primaryIdentityId: agentId, relationshipIdentityId: null, metadata: {}, createdAtMs: sentAtMs - 10, updatedAtMs: sentAtMs, lastMessageAtMs: sentAtMs }],
  participants: [
    { sessionId, identityId: 'human:acct_me', role: 'self', state: 'active', addedByIdentityId: 'human:acct_me', addedAtMs: 1 },
    { sessionId, identityId: agentId, role: 'owned-agent', state: 'active', addedByIdentityId: 'human:acct_me', addedAtMs: 1 },
  ],
  messages: [localRequest], delegatedExchanges: [], presence: [], contextSnapshots: [],
} as unknown as CanonicalSessionState;

const wireRequestId = '01a1566c-da8d-78e3-bd15-000000000001';
const cloud = (messageId: string, body: string, offsetMs: number, extra: Partial<CloudMessage> = {}): CloudMessage => ({
  messageId, fromAccountId: account.accountId, toAccountId: account.accountId, body, sessionId,
  createdAt: new Date(sentAtMs + offsetMs).toISOString(), deliveredAt: null, readAt: null, ...extra,
});
const serverRequest = cloud(wireRequestId, encodeCloudDirectMessageEnvelope({
  schemaVersion: 1, kind: 'message', text: 'Three steps to make tea', agentRuntimeRoute: route,
}), 1_000, { clientMessageId: cloudSelfAgentRequestClientMessageId(sessionId, localRequest.id) });
const progress = (messageId: string, text: string, offsetMs: number, deliveryState: 'processing' | 'complete' = 'processing') => cloud(
  messageId,
  encodeCloudAgentResponse({
    requestId: wireRequestId, text, deliveryState,
    execution: {
      phase: deliveryState === 'complete' ? 'complete' : text ? 'writing' : 'preparing',
      summary: 'Working', steps: [], startedAtMs: sentAtMs + 2_000, updatedAtMs: sentAtMs + offsetMs,
      completed: deliveryState === 'complete',
    },
  }),
  offsetMs,
);

/** Applies a canonical sync plan the way the store does: rows upsert by id. */
function applyPlan(state: CanonicalSessionState, messages: CloudMessage[]): CanonicalSessionState {
  const plan = planCloudSelfAgentCanonicalSync({ account, messages, state });
  let rows = [...state.messages];
  for (const reconciliation of plan.mirrorReconciliations) {
    rows = rows.filter((row) => row.id !== reconciliation.duplicateMessageId);
  }
  for (const request of plan.messageRequests) {
    const existing = rows.find((row) => row.id === request.id);
    const row: CanonicalSessionMessage = {
      id: request.id ?? '', sessionId: request.sessionId, senderIdentityId: request.senderIdentityId,
      senderRole: request.senderRole, messageKind: request.messageKind, contentText: request.contentText,
      content: request.content, parentMessageId: request.parentMessageId ?? null, delegatedExchangeId: null,
      status: request.status ?? 'sent', sequenceNum: existing?.sequenceNum ?? rows.length + 1,
      createdAtMs: request.createdAtMs ?? Date.now(), updatedAtMs: Date.now(),
      sourceTransport: request.sourceTransport ?? null, sourceEventId: request.sourceEventId ?? null,
    };
    rows = existing ? rows.map((candidate) => (candidate.id === row.id ? row : candidate)) : [...rows, row];
  }
  return { ...state, messages: rows };
}

function visibleAgentRows(state: CanonicalSessionState, localTurns: Record<string, DesktopChatTurnSnapshot> = {}) {
  const projected = projectPendingSelfAgentReplies(projectCloudSelfAgentLiveTurns(state, localTurns))!;
  return createCanonicalSessionReadModel(projected as never).messages(sessionId)
    .filter((message) => message.role === 'owned-agent');
}

for (const server of ['inserts a row per progress tick', 'edits one reply row'] as const) test(`one agent row is visible from send to final reply when the server ${server}`, () => {
  const edit = server === 'edits one reply row';
  let version = 0;
  const tick = (wire: CloudMessage[], id: string, text: string, offsetMs: number, state?: 'complete') => {
    const message = { ...progress(edit ? 'reply-row' : id, text, offsetMs, state), version: (version += 1) };
    return edit ? [...wire.filter((candidate) => candidate.messageId !== 'reply-row'), message] : [...wire, message];
  };
  const steps: Array<[string, CanonicalSessionState]> = [];
  let state = baseState;
  steps.push(['local send', state]);
  let wire: CloudMessage[] = [serverRequest];
  state = applyPlan(state, wire);
  steps.push(['server copy of the request', state]);
  state = updateHostedSelfAgentProgress(state, { request: serverRequest, runStatus: 'queued', cloudMessages: wire })!;
  steps.push(['run created and held for the Mac', state]);
  state = updateHostedSelfAgentProgress(state, { request: serverRequest, runStatus: 'leased', cloudMessages: wire })!;
  steps.push(['run leased', state]);
  state = removeHostedSelfAgentProgress(state, wireRequestId)!;
  steps.push(['the Mac takes the run', state]);
  // The native turn starts; its user entry is mirrored before it is linked to the request.
  const nativeUserMirror: CanonicalSessionMessage = {
    ...localRequest, id: 'msg:native-user-mirror', content: { desktopEntryId: wireRequestId },
    createdAtMs: sentAtMs + 2_000, updatedAtMs: sentAtMs + 2_000, sequenceNum: 2,
    sourceTransport: 'desktop-chat', sourceEventId: `desktop-chat:${sessionId}:2`,
  };
  state = { ...state, messages: [...state.messages, nativeUserMirror] };
  steps.push(['native user entry mirrored', state]);
  wire = tick(wire, 'progress-1', '', 2_100);
  state = applyPlan(state, wire);
  steps.push(['first progress row', state]);
  state = { ...state, messages: state.messages.filter((message) => message.id !== nativeUserMirror.id) };
  steps.push(['native mirror reconciled', state]);
  wire = tick(wire, 'progress-2', '1. Boil water', 7_000);
  state = applyPlan(state, wire);
  steps.push(['second progress row', state]);
  wire = tick(wire, 'progress-3', '1. Boil water\n2. Steep', 12_000);
  state = applyPlan(state, wire);
  steps.push(['third progress row', state]);
  wire = tick(wire, 'final', '1. Boil water\n2. Steep\n3. Pour', 14_000, 'complete');
  state = applyPlan(state, wire);
  steps.push(['final reply', state]);
  for (const [label, stepState] of steps) {
    const rows = visibleAgentRows(stepState);
    assert.equal(rows.length, 1, `${label}: ${rows.length} agent rows (${rows.map((row) => row.id).join(', ')})`);
    const running = label !== 'final reply';
    assert.equal(rows[0]?.turn?.completed, !running, `${label}: running state`);
    const projected = projectPendingSelfAgentReplies(projectCloudSelfAgentLiveTurns(stepState, {}))!;
    const userRows = createCanonicalSessionReadModel(projected as never).messages(sessionId).filter((message) => message.role === 'user');
    assert.equal(userRows.length, 1, `${label}: one user bubble for the request`);
    if (!running) assert.equal(agentRequestStopTarget(rows[0]?.turn, rows[0]!), null, 'the final reply has no stop');
  }
});

test('a published request is linked to its Cloud id before the native turn starts', async () => {
  const { linkPublishedSelfAgentRequest } = await import('../src/features/cloud/cloudSelfAgentRequestEntryLink');
  const persisted: unknown[] = [];
  const linked = await linkPublishedSelfAgentRequest(baseState, localRequest.id, wireRequestId, async (request) => { persisted.push(request); });
  assert.equal((linked?.content as Record<string, unknown>).desktopEntryId, wireRequestId);
  assert.equal(persisted.length, 1);
  const again = await linkPublishedSelfAgentRequest({ ...baseState, messages: [linked!] }, localRequest.id, wireRequestId, async (request) => { persisted.push(request); });
  assert.equal(again, null, 'an already linked request is left as it is');
  assert.equal(persisted.length, 1);
});
