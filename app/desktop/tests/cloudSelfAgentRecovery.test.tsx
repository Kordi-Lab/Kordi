import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatSyncConversation, CloudAccount } from '../src/features/cloud/authClient';
import { cloudSelfAgentOperationClientMessageId, planCloudSelfAgentSessionReconciliation, planCloudSelfAgentSync, seedCloudSelfAgentForwardSyncLedger } from '../src/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

function aiConversation(
  sessionId: string,
  options: {
    latestMessageSequence?: number;
    personalTitle?: string | null;
    sharedTitle?: string | null;
  } = {},
): ChatSyncConversation {
  const id = `conversation:${sessionId}`;
  return {
    id,
    kind: 'ai',
    shared_title: options.sharedTitle ?? null,
    version: 1,
    created_by_account_id: account.accountId,
    legacy_session_id: sessionId,
    latest_message_sequence: options.latestMessageSequence ?? 1,
    created_at: '2026-08-11T08:00:00.000Z',
    updated_at: '2026-08-11T08:00:00.000Z',
    members: [{
      account_id: account.accountId,
      role: 'owner',
      membership_state: 'active',
      version: 1,
      last_delivered_sequence: 0,
      last_read_sequence: 0,
      joined_at: '2026-08-11T08:00:00.000Z',
      left_at: null,
    }],
    preferences: {
      conversation_id: id,
      account_id: account.accountId,
      personal_title: options.personalTitle ?? null,
      version: 1,
    },
  };
}
test('agent-session reconciliation creates absent sessions and repairs empty canonical histories', () => {
  const state = {
    sessions: [
      { id: 'session:agent:missing', kind: 'self-agent', title: 'Recovered research', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 10 },
      { id: 'session:agent:empty', kind: 'self-agent', title: 'Empty plan', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 2, updatedAtMs: 11 },
      { id: 'session:agent:zero', kind: 'self-agent', title: 'Zero head', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 4, updatedAtMs: 13 },
      { id: 'cloud-agent:runtime', kind: 'self-agent', title: 'Runtime only', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 5, updatedAtMs: 14 },
      { id: 'session:agent:archived', kind: 'self-agent', title: 'Archived', status: 'archived', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 6, updatedAtMs: 15 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'missing-user', sessionId: 'session:agent:missing', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'recover me', status: 'sent', sequenceNum: 1, createdAtMs: 20, updatedAtMs: 20, sourceTransport: 'cloud-self-agent' },
      { id: 'zero-user', sessionId: 'session:agent:zero', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'repair zero', status: 'sent', sequenceNum: 1, createdAtMs: 21, updatedAtMs: 21, sourceTransport: 'desktop-chat' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentSessionReconciliation(state, [
    aiConversation('session:agent:zero', {
      latestMessageSequence: 0,
      personalTitle: 'Zero head',
    }),
  ]);

  assert.deepEqual(plan, [
    { sessionId: 'session:agent:empty', title: 'Empty plan', createConversation: true, recoverHistory: false },
    { sessionId: 'session:agent:missing', title: 'Recovered research', createConversation: true, recoverHistory: true },
    { sessionId: 'session:agent:zero', title: 'Zero head', createConversation: false, recoverHistory: true },
  ]);
});

test('agent-session reconciliation resumes an interrupted recent history repair', () => {
  const sessionId = 'session:agent:interrupted';
  const state = {
    sessions: [
      { id: sessionId, kind: 'self-agent', title: 'Interrupted', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 20 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'old-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'old prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, sourceTransport: 'cloud-self-agent' },
      { id: 'old-response', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'old answer', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, sourceTransport: 'cloud-self-agent' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;
  const remote = aiConversation(sessionId, { latestMessageSequence: 1 });

  assert.deepEqual(
    planCloudSelfAgentSessionReconciliation(state, [remote], {
      nowMs: Date.parse(remote.created_at) + 60_000,
    }),
    [{
      sessionId,
      title: 'Interrupted',
      createConversation: false,
      recoverHistory: true,
    }],
  );
  assert.deepEqual(
    planCloudSelfAgentSessionReconciliation(state, [remote], {
      nowMs: Date.parse(remote.created_at) + 48 * 60 * 60_000,
    }),
    [],
  );
});

test('missing canonical agent-session recovery overrides legacy cutoffs and cloud-source skips safely', () => {
  const sessionId = 'session:agent:legacy-cloud-only';
  const state = {
    sessions: [
      { id: sessionId, kind: 'self-agent', title: 'Recovered', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 20 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'msg:cloud:self:legacy-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'old prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, sourceTransport: 'cloud-self-agent' },
      { id: 'msg:cloud:self:legacy-response', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'old answer', parentMessageId: 'msg:cloud:self:legacy-request', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, sourceTransport: 'cloud-self-agent' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;
  const legacyLedger = {
    'msg:cloud:self:legacy-request': { cloudMessageId: 'msg_v1_request', syncedAtMs: 30 },
    'msg:cloud:self:legacy-response': { cloudMessageId: 'msg_v1_response', syncedAtMs: 30 },
  };

  assert.deepEqual(planCloudSelfAgentSync(state, legacyLedger, {
    createdAfterMs: 100,
  }), []);
  assert.deepEqual(planCloudSelfAgentSync(state, legacyLedger, {
    createdAfterMs: 100,
    recoverSessionIds: new Set([sessionId]),
  }), [
    { localMessageId: 'msg:cloud:self:legacy-request', sessionId, role: 'user', text: 'old prompt', parentLocalMessageId: null, createdAtMs: 10, deliveryState: 'sent' },
    { localMessageId: 'msg:cloud:self:legacy-response', sessionId, role: 'agent', text: 'old answer', parentLocalMessageId: 'msg:cloud:self:legacy-request', createdAtMs: 20, deliveryState: 'complete' },
  ]);

  const completePlan = planCloudSelfAgentSync(state, legacyLedger, {
    createdAfterMs: 100,
    recoverSessionIds: new Set([sessionId]),
  });
  const remoteUserClientId = cloudSelfAgentOperationClientMessageId(
    completePlan[0],
  );
  assert.deepEqual(planCloudSelfAgentSync(state, legacyLedger, {
    createdAfterMs: 100,
    recoverSessionIds: new Set([sessionId]),
    remoteClientMessageIds: new Set([remoteUserClientId]),
  }), [completePlan[1]]);
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
    { localMessageId: 'new-u1', sessionId: 'local-self-session', role: 'user', text: 'new prompt', parentLocalMessageId: null, createdAtMs: 30, deliveryState: 'sent' },
    { localMessageId: 'new-a1', sessionId: 'local-self-session', role: 'agent', text: 'new answer', parentLocalMessageId: 'new-u1', createdAtMs: 40, deliveryState: 'complete' },
  ]);
});

test('cloud self-agent forward sync ignores historical pages hydrated after the startup baseline', () => {
  const state = {
    sessions: [
      { id: 'paged-self-session', kind: 'self-agent', title: 'Paged', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'paged-old-u1', sessionId: 'paged-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'old paged prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10 },
      { id: 'paged-old-a1', sessionId: 'paged-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'old paged answer', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20 },
      { id: 'live-u1', sessionId: 'paged-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'new prompt', status: 'sent', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30 },
      { id: 'live-a1', sessionId: 'paged-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'new answer', status: 'complete', sequenceNum: 4, createdAtMs: 40, updatedAtMs: 40 },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}, {
    createdAfterMs: 25,
  }), [
    { localMessageId: 'live-u1', sessionId: 'paged-self-session', role: 'user', text: 'new prompt', parentLocalMessageId: null, createdAtMs: 30, deliveryState: 'sent' },
    { localMessageId: 'live-a1', sessionId: 'paged-self-session', role: 'agent', text: 'new answer', parentLocalMessageId: 'live-u1', createdAtMs: 40, deliveryState: 'complete' },
  ]);
});
