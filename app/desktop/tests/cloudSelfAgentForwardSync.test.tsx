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
    { id: 'msg:cloud:self:cloudrunmsg_openai_summary', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Here is the latest OpenAI news summary.', parentMessageId: null, sourceEventId: 'cloudrunmsg_openai_summary' },
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

test('cloud self-agent forward sync seeds existing local history but uploads continued turns', () => {
  const initialState = {
    sessions: [
      { id: 'local-self-session', kind: 'self-agent', title: 'Hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'old-u1', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'old prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10 },
      { id: 'old-a1', sessionId: 'local-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'old answer', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20 },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const seeded = seedCloudSelfAgentForwardSyncLedger(initialState, {}, 1000);
  assert.equal(seeded.changed, true);
  assert.equal(seeded.ledger['old-u1']?.cloudMessageId, null);
  assert.equal(seeded.ledger['old-u1']?.skippedLocalBackfill, true);
  assert.deepEqual(planCloudSelfAgentSync(initialState, seeded.ledger), []);

  const continuedState = {
    ...initialState,
    messages: [
      ...initialState.messages,
      { id: 'new-u1', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'new prompt', status: 'sent', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30 },
      { id: 'new-a1', sessionId: 'local-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'new answer', status: 'complete', sequenceNum: 4, createdAtMs: 40, updatedAtMs: 40 },
    ] as CanonicalSessionMessage[],
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(continuedState, seeded.ledger), [
    { localMessageId: 'new-u1', sessionId: 'local-self-session', role: 'user', text: 'new prompt', parentLocalMessageId: null, createdAtMs: 30 },
    { localMessageId: 'new-a1', sessionId: 'local-self-session', role: 'agent', text: 'new answer', parentLocalMessageId: 'new-u1', createdAtMs: 40 },
  ]);
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
    { localMessageId: 'new-u1', sessionId: forkSessionId, role: 'user', text: 'new fork prompt', parentLocalMessageId: null, createdAtMs: 30 },
    { localMessageId: 'new-a1', sessionId: forkSessionId, role: 'agent', text: 'new answer', parentLocalMessageId: 'new-u1', createdAtMs: 40 },
  ]);
});

