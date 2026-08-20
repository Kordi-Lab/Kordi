import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage, CloudSessionTitle } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

test('fork snapshot repair preserves a newer manual Cloud title', () => {
  const parentUser: CloudMessage = {
    messageId: 'msg_parent_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'original prompt',
    createdAt: '2026-05-16T08:40:00.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:parent',
  };
  const forkCopiedUser: CloudMessage = {
    ...parentUser,
    messageId: 'msg_fork_copied_request',
    sessionId: 'session:fork:child',
  };
  const state = {
    sessions: [{
      id: 'session:fork:child',
      kind: 'self-agent',
      title: 'original prompt',
      status: 'active',
      createdByIdentityId: 'human:acct_me',
      primaryIdentityId: 'agent:cloud-self:acct_me',
      projectId: null,
      projectName: null,
      relationshipIdentityId: null,
      metadata: {
        cloudSelfAgentSession: true,
        sessionTitleSource: 'auto',
        titleSource: 'auto',
        sessionTitleRevision: 1,
        sessionTitleGeneratedFromMessageId: 'msg_fork_copied_request',
        sessionTitleUpdatedAtMs: 100,
      },
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 1,
    }],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [{ id: 'msg:cloud:self:msg_fork_copied_request', sessionId: 'session:fork:child', sequenceNum: 1, senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text', contentText: 'original prompt', content: null, parentMessageId: null, status: 'sent', createdAtMs: Date.parse(parentUser.createdAt), updatedAtMs: Date.parse(parentUser.createdAt), sourceTransport: 'cloud-self-agent', sourceEventId: 'msg_fork_copied_request' }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [parentUser, forkCopiedUser],
    state,
    forksBySessionId: {
      'session:fork:child': {
        forkSessionId: 'session:fork:child',
        parentSessionId: 'session:parent',
        parentMessageId: null,
        createdByAccountId: account.accountId,
        createdAt: '2026-05-16T08:40:06.000Z',
      },
    },
    cloudTitlesBySessionId: {
      'session:fork:child': {
        sessionId: 'session:fork:child',
        title: 'Manual fork investigation',
        titleSource: 'manual',
        titleRevision: 2,
        titlePolicyVersion: 1,
        titleGeneratedFromMessageId: null,
        updatedAtMs: 200,
        updatedByAccountId: account.accountId,
        updatedAt: '2026-05-16T08:42:00.000Z',
      },
    },
  });

  const forkSessionRequest = plan.sessionRequests.find((request) => request.id === 'session:fork:child');
  assert.equal(forkSessionRequest?.title, 'Manual fork investigation');
  assert.equal(
    (forkSessionRequest?.metadata as Record<string, unknown>)?.sessionTitleSource,
    'manual',
  );
});

test('cloud self-agent canonical sync patches fork lineage onto existing restored sessions', () => {
  const userMessage: CloudMessage = {
    messageId: 'msg_child_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'child prompt',
    createdAt: '2026-05-16T08:41:27.120Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:fork:child',
  };
  const state = {
    sessions: [{
      id: 'session:fork:child',
      kind: 'self-agent',
      title: 'child prompt',
      status: 'active',
      createdByIdentityId: 'human:acct_me',
      primaryIdentityId: 'agent:cloud-self:acct_me',
      projectId: null,
      projectName: null,
      relationshipIdentityId: null,
      metadata: {
        cloudSelfAgentSession: true,
        fork: {
          forkedFromSessionId: 'parent-session',
          forkedFromMessageId: 'msg:cloud:self:parent-agent',
        },
      },
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 1,
    }],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [{ id: 'msg:cloud:self:msg_child_request', sessionId: 'session:fork:child', sequenceNum: 1, senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text', contentText: 'child prompt', content: null, parentMessageId: null, status: 'sent', createdAtMs: Date.parse('2026-05-16T08:41:27.120Z'), updatedAtMs: Date.parse('2026-05-16T08:41:27.120Z'), sourceTransport: 'cloud-self-agent', sourceEventId: 'msg_child_request' }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [userMessage],
    state,
    forksBySessionId: {
      'session:fork:child': {
        forkSessionId: 'session:fork:child',
        parentSessionId: 'parent-session',
        parentMessageId: 'msg:cloud:self:parent-agent',
        createdByAccountId: account.accountId,
        createdAt: '2026-05-16T08:40:00Z',
      },
    },
  });

  assert.equal(plan.messageRequests.length, 0);
  const metadata = plan.sessionRequests[0]?.metadata as Record<string, unknown>;
  assert.equal(metadata.cloudSelfAgentSession, true);
  assert.deepEqual(metadata.fork, {
    forkedFromSessionId: 'parent-session',
    forkedFromMessageId: 'msg:cloud:self:parent-agent',
    forkedFromMessageAliases: ['msg:cloud:self:parent-agent'],
    forkMode: 'private-local',
    contextPolicy: 'prefix-through-message',
    boundary: 'inherited-history-reference-only',
  });
});

test('cloud self-agent canonical sync materializes restored Cloud private agent sessions', () => {
  const userMessage: CloudMessage = {
    messageId: 'msg_self_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'sync this question',
    createdAt: '2026-05-16T08:11:27.120Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'restored-self-session',
  };
  const agentMessage: CloudMessage = {
    messageId: 'msg_self_answer',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({ requestId: userMessage.messageId, text: 'synced answer' }),
    createdAt: '2026-05-16T08:11:32.820Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'restored-self-session',
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

  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [agentMessage, userMessage], state });

  assert.equal(plan.agentIdentityRequest.id, 'agent:cloud-self:acct_me');
  assert.deepEqual(plan.sessionRequests.map((request) => ({ id: request.id, title: request.title, createdByIdentityId: request.createdByIdentityId, primaryIdentityId: request.primaryIdentityId })), [
    { id: 'restored-self-session', title: 'Sync this question', createdByIdentityId: 'human:acct_me', primaryIdentityId: 'agent:cloud-self:acct_me' },
  ]);
  assert.deepEqual(plan.messageRequests.map((request) => ({
    id: request.id,
    senderRole: request.senderRole,
    messageKind: request.messageKind,
    contentText: request.contentText,
    parentMessageId: request.parentMessageId ?? null,
    sourceEventId: request.sourceEventId,
  })), [
    { id: 'msg:cloud:self:msg_self_request', senderRole: 'user', messageKind: 'text', contentText: 'sync this question', parentMessageId: null, sourceEventId: 'msg_self_request' },
    { id: 'msg:cloud:self:response:msg_self_request', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'synced answer', parentMessageId: 'msg:cloud:self:msg_self_request', sourceEventId: 'msg_self_answer' },
  ]);
});

test('cloud self-agent title restore applies manual-over-auto precedence in both directions', () => {
  const sessionId = 'session:self-agent:title-precedence';
  const userMessage: CloudMessage = {
    messageId: 'msg_title_seed',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'diagnose high Node CPU usage',
    createdAt: '2026-07-16T02:00:00.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId,
  };
  const baseState = {
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  };
  const cloudManualTitle: CloudSessionTitle = {
    sessionId,
    title: 'Node process investigation',
    titleSource: 'manual',
    titleRevision: 3,
    titlePolicyVersion: 1,
    titleGeneratedFromMessageId: null,
    updatedAtMs: 300,
    updatedByAccountId: account.accountId,
    updatedAt: '2026-07-16T02:01:00.000Z',
  };

  const remoteManualPlan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [userMessage],
    state: {
      ...baseState,
      sessions: [{
        id: sessionId,
        kind: 'self-agent',
        title: 'Diagnose high Node CPU',
        status: 'active',
        createdByIdentityId: 'human:acct_me',
        primaryIdentityId: 'agent:cloud-self:acct_me',
        metadata: { sessionTitleSource: 'auto', sessionTitleRevision: 1, sessionTitleUpdatedAtMs: 100 },
        createdAtMs: 1,
        updatedAtMs: 100,
      }],
    } as CanonicalSessionState,
    cloudTitlesBySessionId: { [sessionId]: cloudManualTitle },
  });
  assert.equal(remoteManualPlan.sessionRequests[0]?.title, cloudManualTitle.title);
  const remoteManualMetadata = remoteManualPlan.sessionRequests[0]?.metadata as Record<string, unknown>;
  assert.equal(remoteManualMetadata.sessionTitleSource, 'manual');
  assert.equal(remoteManualMetadata.sessionTitleUpdatedByAccountId, account.accountId);

  const equalVersionServerWinnerPlan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [userMessage],
    state: {
      ...baseState,
      sessions: [{
        id: sessionId,
        kind: 'self-agent',
        title: 'Unsynchronized equal-time edit',
        status: 'active',
        createdByIdentityId: 'human:acct_me',
        primaryIdentityId: 'agent:cloud-self:acct_me',
        metadata: { sessionTitleSource: 'manual', sessionTitleRevision: 3, sessionTitleUpdatedAtMs: 300 },
        createdAtMs: 1,
        updatedAtMs: 300,
      }],
    } as CanonicalSessionState,
    cloudTitlesBySessionId: { [sessionId]: cloudManualTitle },
  });
  assert.equal(equalVersionServerWinnerPlan.sessionRequests[0]?.title, cloudManualTitle.title);
  assert.equal(
    (equalVersionServerWinnerPlan.sessionRequests[0]?.metadata as Record<string, unknown>)
      .sessionTitleUpdatedByAccountId,
    account.accountId,
  );

  const localManualPlan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [userMessage],
    state: {
      ...baseState,
      sessions: [{
        id: sessionId,
        kind: 'self-agent',
        title: 'Keep my local title',
        status: 'active',
        createdByIdentityId: 'human:acct_me',
        primaryIdentityId: 'agent:cloud-self:acct_me',
        metadata: { sessionTitleSource: 'manual', sessionTitleRevision: 4, sessionTitleUpdatedAtMs: 400 },
        createdAtMs: 1,
        updatedAtMs: 400,
      }],
    } as CanonicalSessionState,
    cloudTitlesBySessionId: {
      [sessionId]: {
        ...cloudManualTitle,
        title: 'Cloud auto title',
        titleSource: 'auto',
        titleRevision: 2,
        updatedAtMs: 500,
      },
    },
  });
  assert.equal(localManualPlan.sessionRequests.length, 0);
});
