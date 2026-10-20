import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { withoutStoredMessageRequests } from '../src/features/cloud/cloudSelfAgentCanonicalSyncExecution';
import {
  cloudSelfAgentRequestIsSettled,
  recordSentCloudSelfAgentRequests,
  selectCloudSelfAgentMessagesToPlan,
  type CloudSelfAgentSentRequestMemo,
  type CloudSelfAgentSettledSessions,
} from '../src/features/cloud/cloudSelfAgentIncrementalSync';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudCollaborationState';
import type { AppendCanonicalMessageRequest, CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Owner', primaryEmail: 'owner@example.com', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};
const sessions = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'];
const baseState = {
  storagePath: '/tmp/canonical.sqlite3',
  profile: { id: 'profile', displayName: 'Owner', humanIdentityId: 'human:acct_me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
  identities: [], sessions: [], participants: [], messages: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
} as unknown as CanonicalSessionState;
let clock = 1_000;
const cloud = (sessionId: string, messageId: string, body: string): CloudMessage => ({
  messageId, fromAccountId: account.accountId, toAccountId: account.accountId, body, sessionId,
  createdAt: new Date(1_790_000_000_000 + (clock += 1_000)).toISOString(), deliveredAt: null, readAt: null, version: 1,
});
const conversation = (sessionId: string, index: number) => {
  const requestId = `01a10000-0000-7000-8000-00000000${index}${sessionId.slice(-1)}01`;
  return [
    cloud(sessionId, requestId, encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: `Question ${index}` })),
    cloud(sessionId, `01a10000-0000-7000-8000-00000000${index}${sessionId.slice(-1)}02`, encodeCloudAgentResponse({
      requestId, text: `Answer ${index}`, deliveryState: 'complete',
    })),
  ];
};
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]))
  : value;

/** Stores requests the way the store does: content comes back with sorted keys and an agent reply keeps its place. */
function store(state: CanonicalSessionState, requests: AppendCanonicalMessageRequest[]) {
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  const stored: CanonicalSessionMessage[] = [];
  for (const request of requests) {
    const existing = byId.get(request.id ?? '');
    const row = {
      ...existing, ...request, id: request.id ?? '', content: sortKeys(request.content ?? null),
      parentMessageId: request.parentMessageId ?? null, delegatedExchangeId: null, status: request.status ?? 'sent',
      sequenceNum: existing?.sequenceNum ?? byId.size + 1,
      createdAtMs: existing && request.messageKind === 'agent-turn' ? existing.createdAtMs : request.createdAtMs ?? clock,
      updatedAtMs: (clock += 1),
    } as CanonicalSessionMessage;
    byId.set(row.id, row);
    stored.push(row);
  }
  return { state: { ...state, messages: [...byId.values()] }, stored };
}

function syncRound(state: CanonicalSessionState, messages: CloudMessage[], settled: { current: CloudSelfAgentSettledSessions | null }, memo: CloudSelfAgentSentRequestMemo) {
  const selection = selectCloudSelfAgentMessagesToPlan({ settled, accountId: account.accountId, inputs: ['Agent', {}, {}], messages, state });
  const plan = withoutStoredMessageRequests(planCloudSelfAgentCanonicalSync({ account, messages: selection.messages, state }), state.messages, memo);
  const stored = store(state, plan.messageRequests);
  recordSentCloudSelfAgentRequests(memo, plan.messageRequests, stored.stored);
  selection.markSettled();
  return { state: stored.state, planned: selection.sessionIds, written: plan.messageRequests.length };
}

test('a steady-state round plans no conversation and writes no rows', () => {
  const settled = { current: null };
  const memo: CloudSelfAgentSentRequestMemo = new Map();
  const messages = [...conversation(sessions[0], 1), ...conversation(sessions[1], 1)];
  let round = syncRound(baseState, messages, settled, memo);
  assert.equal(round.planned, null, 'the first round plans every conversation');
  assert.ok(round.written > 0);
  for (let index = 0; index < 3 && (round.planned === null || round.planned.size > 0); index += 1) {
    round = syncRound(round.state, messages, settled, memo);
    assert.equal(round.written, 0, 'a replanned conversation that is stored writes nothing');
  }
  round = syncRound(round.state, messages, settled, memo);
  assert.equal(round.planned?.size, 0);
  assert.equal(round.written, 0);
});

test('a new message replans only its conversation', () => {
  const settled = { current: null };
  const memo: CloudSelfAgentSentRequestMemo = new Map();
  let messages = [...conversation(sessions[0], 1), ...conversation(sessions[1], 1)];
  let round = syncRound(baseState, messages, settled, memo);
  while (round.planned === null || round.planned.size > 0) round = syncRound(round.state, messages, settled, memo);
  messages = [...messages, ...conversation(sessions[1], 2)];
  round = syncRound(round.state, messages, settled, memo);
  assert.deepEqual([...round.planned ?? []], [sessions[1]]);
  assert.ok(round.written > 0);
  const inputsChanged = selectCloudSelfAgentMessagesToPlan({ settled, accountId: account.accountId, inputs: ['Renamed agent', {}, {}], messages, state: round.state });
  assert.equal(inputsChanged.sessionIds, null, 'a change every conversation reads plans them all');
});

test('a fork and its parent are planned together', () => {
  const settled = { current: null };
  const messages = [...conversation(sessions[0], 1), ...conversation(sessions[1], 1)];
  const forks = { [sessions[1]]: { forkSessionId: sessions[1], parentSessionId: sessions[0] } } as never;
  const first = selectCloudSelfAgentMessagesToPlan({ settled, accountId: account.accountId, inputs: [], messages, state: baseState, forksBySessionId: forks });
  first.markSettled();
  const next = selectCloudSelfAgentMessagesToPlan({ settled, accountId: account.accountId, inputs: [], messages: [...messages, ...conversation(sessions[0], 2)], state: baseState, forksBySessionId: forks });
  assert.deepEqual([...next.sessionIds ?? []].sort(), [...sessions].sort());
});

test('a stored row matches its request regardless of key order, and a refused write is not sent again', () => {
  const row = {
    id: 'msg:cloud:self:response:wire', sessionId: sessions[0], senderIdentityId: 'agent:me', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: 'Done', content: { a: 1, b: { c: 2, d: 3 } }, parentMessageId: null,
    delegatedExchangeId: null, status: 'complete', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 20,
    sourceTransport: 'cloud-self-agent', sourceEventId: 'wire-response',
  } as CanonicalSessionMessage;
  const request = { ...row, content: { b: { d: 3, c: 2 }, a: 1 } } as AppendCanonicalMessageRequest;
  assert.equal(cloudSelfAgentRequestIsSettled(request, row), true);
  // The store keeps an agent reply's position, so a request to move it changes nothing.
  const moved = { ...request, createdAtMs: 5 } as AppendCanonicalMessageRequest;
  const memo: CloudSelfAgentSentRequestMemo = new Map();
  assert.equal(cloudSelfAgentRequestIsSettled(moved, row, memo), false);
  recordSentCloudSelfAgentRequests(memo, [moved], [row]);
  assert.equal(cloudSelfAgentRequestIsSettled(moved, row, memo), true);
  assert.equal(cloudSelfAgentRequestIsSettled(moved, { ...row, updatedAtMs: 30 }, memo), false, 'a row changed since is written again');
});
