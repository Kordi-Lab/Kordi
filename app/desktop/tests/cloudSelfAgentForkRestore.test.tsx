import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

test('cloud self-agent canonical sync restores fork lineage metadata', () => {
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

  const metadata = plan.sessionRequests[0]?.metadata as Record<string, unknown>;
  assert.equal(metadata.cloudSelfAgentSession, true);
  assert.equal(metadata.sessionTitleSource, 'auto');
  assert.equal(metadata.sessionTitleRevision, 1);
  assert.equal(metadata.sessionTitleGeneratedFromMessageId, userMessage.messageId);
  assert.deepEqual(metadata.fork, {
    forkedFromSessionId: 'parent-session',
    forkedFromMessageId: 'msg:cloud:self:parent-agent',
    forkedFromMessageAliases: ['msg:cloud:self:parent-agent'],
    forkMode: 'private-local',
    contextPolicy: 'prefix-through-message',
    boundary: 'inherited-history-reference-only',
  });
});

test('cloud self-agent canonical sync decodes direct reply envelopes and preserves quote metadata', () => {
  const sessionId = 'session:self-agent:quoted';
  const source = {
    sourceSessionId: sessionId,
    sourceMessageId: 'msg:source-agent',
    sourceMessageKind: 'agent-turn',
    senderLabel: 'My Kordi',
    textPreview: 'Earlier answer',
    attachmentCount: 0,
    timeLabel: '06:24',
  };
  const userMessage: CloudMessage = {
    messageId: 'msg_quoted_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1,
      kind: 'message',
      text: 'follow up',
      messageAction: { schemaVersion: 1, kind: 'quote', source },
    }),
    createdAt: '2026-05-16T08:41:27.120Z',
    deliveredAt: null,
    readAt: null,
    sessionId,
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

  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [userMessage], state });
  const restored = plan.messageRequests[0];
  assert.equal(restored?.contentText, 'follow up');
  assert.equal(restored?.parentMessageId, source.sourceMessageId);
  assert.deepEqual((restored?.content as { messageAction?: unknown } | null)?.messageAction, {
    schemaVersion: 1,
    kind: 'quote',
    source,
  });
});

test('cloud self-agent canonical sync marks restored fork prefix as snapshots for the transcript divider', () => {
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
  const parentAgent: CloudMessage = {
    messageId: 'msg_parent_answer',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({ requestId: parentUser.messageId, text: 'original answer' }),
    createdAt: '2026-05-16T08:40:05.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:parent',
  };
  const forkCopiedUser: CloudMessage = {
    ...parentUser,
    messageId: 'msg_fork_copied_request',
    sessionId: 'session:fork:child',
  };
  const forkCopiedAgent: CloudMessage = {
    ...parentAgent,
    messageId: 'msg_fork_copied_answer',
    body: encodeCloudAgentResponse({ requestId: forkCopiedUser.messageId, text: 'original answer' }),
    sessionId: 'session:fork:child',
  };
  const forkNewUser: CloudMessage = {
    messageId: 'msg_fork_new_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'continued prompt',
    createdAt: '2026-05-16T08:41:00.000Z',
    deliveredAt: null,
    readAt: null,
    sessionId: 'session:fork:child',
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
    messages: [forkNewUser, forkCopiedAgent, parentAgent, forkCopiedUser, parentUser],
    state,
    forksBySessionId: {
      'session:fork:child': {
        forkSessionId: 'session:fork:child',
        parentSessionId: 'session:parent',
        parentMessageId: 'msg:cloud:self:msg_parent_answer',
        createdByAccountId: account.accountId,
        createdAt: '2026-05-16T08:40:06.000Z',
      },
    },
  });

  assert.deepEqual(plan.messageRequests
    .filter((request) => request.sessionId === 'session:fork:child')
    .map((request) => ({ text: request.contentText, sourceTransport: request.sourceTransport })), [
    { text: 'original prompt', sourceTransport: 'canonical-fork-snapshot' },
    { text: 'original answer', sourceTransport: 'canonical-fork-snapshot' },
    { text: 'continued prompt', sourceTransport: 'cloud-self-agent' },
  ]);
  assert.equal(
    plan.sessionRequests.find((request) => request.id === 'session:fork:child')?.title,
    'Continued prompt',
  );
});

test('cloud self-agent canonical sync patches existing restored fork prefix messages into snapshots', () => {
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
    sessions: [{ id: 'session:fork:child', kind: 'self-agent', title: 'original prompt', status: 'active', createdByIdentityId: 'human:acct_me', primaryIdentityId: 'agent:cloud-self:acct_me', projectId: null, projectName: null, relationshipIdentityId: null, metadata: { cloudSelfAgentSession: true, sessionTitleSource: 'auto', titleSource: 'auto', sessionTitleRevision: 1, sessionTitleGeneratedFromMessageId: 'msg_fork_copied_request' }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 }],
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
  });

  assert.deepEqual(plan.messageRequests
    .filter((request) => request.sessionId === 'session:fork:child')
    .map((request) => ({
      id: request.id,
      sourceTransport: request.sourceTransport,
    })), [
    { id: 'msg:cloud:self:msg_fork_copied_request', sourceTransport: 'canonical-fork-snapshot' },
  ]);
  const forkSessionRequest = plan.sessionRequests.find((request) => request.id === 'session:fork:child');
  assert.equal(forkSessionRequest?.title, 'New fork');
  assert.equal((forkSessionRequest?.metadata as Record<string, unknown>)?.sessionTitleSource, 'placeholder');
  assert.equal('sessionTitleGeneratedFromMessageId' in ((forkSessionRequest?.metadata as Record<string, unknown>) ?? {}), false);
});
