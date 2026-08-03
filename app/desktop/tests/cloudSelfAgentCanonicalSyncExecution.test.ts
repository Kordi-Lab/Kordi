import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
  OpenCanonicalSessionFastResult,
} from '../src/kordi-app/types';
import {
  mergeCloudSelfAgentCanonicalSyncBatch,
} from '../src/features/cloud/cloudCanonicalStateMerge';
import {
  cloudSelfAgentCanonicalSyncPlanSignature,
  persistCloudSelfAgentCanonicalSyncPlan,
} from '../src/features/cloud/cloudSelfAgentCanonicalSyncExecution';
import type {
  CloudSelfAgentCanonicalSyncPlan,
} from '../src/features/cloud/cloudSelfAgentCanonicalSync';

const identity: CanonicalIdentity = {
  id: 'agent:cloud-self:acct_me',
  kind: 'agent',
  displayName: 'My Kordi',
  ownerIdentityId: 'human:acct_me',
  source: 'local',
  avatarKey: 'cloud-self:acct_me',
  createdAtMs: 1,
  updatedAtMs: 1,
};

const sessionResult: OpenCanonicalSessionFastResult = {
  session: {
    id: 'session:self-agent:one',
    kind: 'self-agent',
    title: 'Hello',
    status: 'active',
    createdByIdentityId: 'human:acct_me',
    primaryIdentityId: identity.id,
    createdAtMs: 1,
    updatedAtMs: 2,
    lastMessageAtMs: 2,
  },
  participants: [],
};

const restoredMessage: CanonicalSessionMessage = {
  id: 'msg:cloud:self:request',
  sessionId: sessionResult.session.id,
  senderIdentityId: 'human:acct_me',
  senderRole: 'user',
  messageKind: 'text',
  contentText: 'Hello',
  status: 'sent',
  sequenceNum: 1,
  createdAtMs: 2,
  updatedAtMs: 2,
  sourceTransport: 'cloud-self-agent',
  sourceEventId: 'request',
};

const plan: CloudSelfAgentCanonicalSyncPlan = {
  agentIdentityRequest: {
    id: identity.id,
    kind: 'agent',
    displayName: identity.displayName,
  },
  sessionRequests: [{
    id: sessionResult.session.id,
    kind: 'self-agent',
    title: sessionResult.session.title,
    createdByIdentityId: sessionResult.session.createdByIdentityId,
    primaryIdentityId: identity.id,
    participantIdentityIds: [],
  }],
  messageRequests: [{
    id: restoredMessage.id,
    sessionId: restoredMessage.sessionId,
    senderIdentityId: restoredMessage.senderIdentityId,
    senderRole: restoredMessage.senderRole,
    messageKind: restoredMessage.messageKind,
    contentText: restoredMessage.contentText,
    status: restoredMessage.status,
    createdAtMs: restoredMessage.createdAtMs,
    sourceTransport: restoredMessage.sourceTransport,
    sourceEventId: restoredMessage.sourceEventId,
  }],
};

function stateWithNewerHistory(): CanonicalSessionState {
  return {
    storagePath: '/tmp/kordi-test',
    profile: {
      id: 'profile',
      displayName: 'Me',
      humanIdentityId: 'human:acct_me',
      storageRoot: '/tmp/kordi-test',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [],
    participants: [],
    messages: [{
      id: 'msg:newer-local-page',
      sessionId: sessionResult.session.id,
      senderIdentityId: 'human:acct_me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'Loaded while sync was running',
      status: 'sent',
      sequenceNum: 2,
      createdAtMs: 3,
      updatedAtMs: 3,
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

test('self-agent canonical persistence returns one batch after ordered writes', async () => {
  const calls: string[] = [];
  const batch = await persistCloudSelfAgentCanonicalSyncPlan(plan, {
    persistence: {
      upsertIdentity: async () => {
        calls.push('identity');
        return identity;
      },
      openSession: async () => {
        calls.push('session');
        return sessionResult;
      },
      upsertMessage: async () => {
        calls.push('message');
        return restoredMessage;
      },
    },
  });

  assert.deepEqual(calls, ['identity', 'session', 'message']);
  assert.deepEqual(batch, {
    identity,
    sessions: [sessionResult],
    messages: [restoredMessage],
  });
});

test('self-agent canonical batch merges into the latest state without replacing newer history', () => {
  const latest = stateWithNewerHistory();
  const merged = mergeCloudSelfAgentCanonicalSyncBatch(latest, {
    identity,
    sessions: [sessionResult],
    messages: [restoredMessage],
  });

  assert.ok(merged);
  assert.deepEqual(
    merged.messages.map((message) => message.id),
    ['msg:newer-local-page', restoredMessage.id],
  );
  assert.equal(merged.identities.some((row) => row.id === identity.id), true);
  assert.equal(merged.sessions.some((row) => row.id === sessionResult.session.id), true);
});

test('equivalent self-agent canonical batch replay preserves the state reference', () => {
  const initial = mergeCloudSelfAgentCanonicalSyncBatch(stateWithNewerHistory(), {
    identity,
    sessions: [sessionResult],
    messages: [restoredMessage],
  });
  assert.ok(initial);

  const replayed = mergeCloudSelfAgentCanonicalSyncBatch(initial, {
    identity: structuredClone(identity),
    sessions: [structuredClone(sessionResult)],
    messages: [structuredClone(restoredMessage)],
  });

  assert.equal(replayed, initial);
});

test('self-agent canonical plan signatures change with persisted content', () => {
  const signature = cloudSelfAgentCanonicalSyncPlanSignature(plan);
  const changed = cloudSelfAgentCanonicalSyncPlanSignature({
    ...plan,
    messageRequests: [{
      ...plan.messageRequests[0],
      contentText: 'Changed',
    }],
  });
  assert.notEqual(signature, changed);
});
