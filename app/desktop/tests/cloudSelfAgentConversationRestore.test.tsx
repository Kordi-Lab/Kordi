import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { localOwnedAgentSenderLabel } from '../src/app/viewModels/helpers';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudDesktopCollaborationState, cloudCollaborationConversationId } from '../src/features/cloud/cloudCollaborationState';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import {
  CLOUD_AGENT_SESSION_IDENTITY_MESSAGE_KIND,
  encodeCloudDirectMessageEnvelope,
} from '../src/features/cloud/cloudDirectMessages';
import { planCloudSelfAgentSync } from '../src/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

test('cloud self-agent bridge state preserves one Cloud conversation per local session id', () => {
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_s1_u1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'session one prompt',
      sessionId: 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e',
      createdAt: '2026-05-11T10:00:00Z',
    },
    {
      ...message,
      messageId: 'msg_s2_u1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'session two prompt',
      sessionId: 'fed8e7f6-fe4a-4598-b83e-3d21a20f978a',
      createdAt: '2026-05-11T10:01:00Z',
    },
    {
      ...message,
      messageId: 'msg_legacy_collapsed',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'old collapsed prompt',
      sessionId: null,
      createdAt: '2026-05-11T10:02:00Z',
    },
  ] as CloudMessage[];

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
  });

  assert.deepEqual(
    state.conversations.map((conversation) => conversation.canonicalSessionId).sort(),
    ['f51f7d19-8c8f-4228-9cdd-074ae9b2146e', 'fed8e7f6-fe4a-4598-b83e-3d21a20f978a'].sort(),
  );
  const first = state.conversations.find((conversation) => conversation.canonicalSessionId === 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e');
  assert.ok(first);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].text, 'session one prompt');
});

test('cloud self-agent bridge state restores session titles instead of naming every thread My Kordi', () => {
  const sessionId = 'e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83';
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_prompt',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'what is open claw',
      sessionId,
      createdAt: '2026-05-11T10:00:00Z',
    },
  ] as CloudMessage[];

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
    cloudSessionTitlesById: { [sessionId]: 'OpenClaw notes' },
  });

  assert.equal(state.conversations[0]?.title, 'OpenClaw notes');
  assert.equal(state.conversations[0]?.peerDisplayName, 'OpenClaw notes');
});

test('cloud self-agent bridge state keeps a custom agent identity on plain follow-up requests', () => {
  const sessionId = 'session:direct-agent:stock';
  const createdAt = new Date().toISOString();
  const marker = {
    ...message,
    messageId: 'msg_stock_identity',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    direction: 'outgoing',
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1,
      kind: 'message',
      text: '',
      targetCloudAgentId: 'cloud_agent_stock',
      targetCloudAgentName: 'US Stock Paper Trader',
      targetCloudAgentOwnerAccountId: account.accountId,
    }),
    messageKind: CLOUD_AGENT_SESSION_IDENTITY_MESSAGE_KIND,
    sessionId,
    conversationSequence: 1,
    createdAt,
  } as CloudMessage;
  const request = {
    ...marker,
    messageId: 'msg_stock_request',
    body: 'hello',
    messageKind: 'text',
    conversationSequence: 2,
  } as CloudMessage;
  const processing = {
    ...request,
    messageId: 'msg_stock_processing',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'processing...',
      deliveryState: 'processing',
    }),
    conversationSequence: 3,
  } as CloudMessage;

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { [account.accountId]: [marker, request, processing] },
  });

  assert.equal(state.conversations[0]?.identity?.localAgentId, 'cloud_agent_stock');
  assert.equal(state.conversations[0]?.identity?.localAgentName, 'US Stock Paper Trader');
  const viewModel = mapCollaborationConversationToViewModel(
    state.conversations[0],
    undefined,
    'My Kordi',
  );
  assert.equal(viewModel.collaborationTarget?.displayName, 'US Stock Paper Trader');
  assert.equal(localOwnedAgentSenderLabel(viewModel), 'US Stock Paper Trader');
});

test('cloud self-agent bridge state ignores draft sessions and model changes in list previews', () => {
  const sessionId = 'session:self-agent:preview';
  const modelChange = {
    ...message,
    messageId: 'msg_model_change',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    direction: 'outgoing',
    body: 'Switched model to openai/gpt-5.6-luna',
    sessionId,
    messageKind: 'agent-model-change',
    createdAt: '2026-05-11T10:01:00Z',
  } as CloudMessage;
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: {
      [account.accountId]: [
        {
          ...message,
          messageId: 'msg_prompt',
          fromAccountId: account.accountId,
          toAccountId: account.accountId,
          direction: 'outgoing',
          body: 'Check my disk usage',
          sessionId,
          createdAt: '2026-05-11T10:00:00Z',
        },
        modelChange,
        {
          ...modelChange,
          messageId: 'msg_draft_model_change',
          sessionId: 'draft:local-chat',
        },
      ],
    },
  });

  assert.deepEqual(
    state.conversations.map((conversation) => conversation.canonicalSessionId),
    [sessionId],
  );
  assert.equal(state.conversations[0]?.title, 'Check my disk usage');
  assert.equal(state.conversations[0]?.subtitle, 'Check my disk usage');
});

test('cloud self-agent bridge state falls back to the first prompt as restored title', () => {
  const sessionId = 'e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83';
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_prompt',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'waht is open claw',
      sessionId,
      createdAt: '2026-05-11T10:00:00Z',
    },
  ] as CloudMessage[];

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
  });

  assert.equal(state.conversations[0]?.title, 'waht is open claw');
  assert.equal(state.conversations[0]?.peerDisplayName, 'waht is open claw');
});

test('cloud self-agent bridge state hides sessions already restored into canonical local chat', () => {
  const cloudSessionId = 'restored-self-session';
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: {
      [account.accountId]: [{
        messageId: 'msg_self_request',
        fromAccountId: account.accountId,
        toAccountId: account.accountId,
        body: 'restored question',
        createdAt: '2026-05-16T08:00:00.000Z',
        deliveredAt: null,
        readAt: null,
        sessionId: cloudSessionId,
      }],
    },
    hiddenCloudSessionIds: new Set([cloudSessionId]),
  });

  assert.deepEqual(state.conversations.map((conversation) => conversation.id), []);
});

test('cloud self-agent bridge state suppresses local canonical fork sessions', () => {
  const forkSessionId = 'session:fork:abc123';
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_fork_prompt',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'historical fork prompt',
      sessionId: forkSessionId,
      createdAt: '2026-05-11T10:00:00Z',
    },
  ] as CloudMessage[];

  const visibleState = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
  });
  assert.equal(visibleState.conversations.some((conversation) => conversation.canonicalSessionId === forkSessionId), true);

  const suppressedState = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
    hiddenCloudSessionIds: new Set([forkSessionId]),
  });
  assert.equal(suppressedState.conversations.some((conversation) => conversation.canonicalSessionId === forkSessionId), false);
});

test('cloud self-agent plain messages show local processing and match session-scoped replies', () => {
  const sessionId = 'e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83';
  const request = {
    ...message,
    messageId: 'msg_plain_self_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    direction: 'outgoing',
    body: 'are you here',
    sessionId,
    createdAt: new Date().toISOString(),
  } as CloudMessage;
  const pendingState = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [request] },
    activeConversationId: cloudCollaborationConversationId('acct_me', 'kordi-desktop', sessionId),
  });

  assert.equal(pendingState.conversations[0]?.awaitingReply, true);
  assert.equal(pendingState.conversations[0]?.outreach?.sourceRequestId, 'msg_plain_self_request');

  const answeredState = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [request, {
      ...message,
      messageId: 'msg_plain_self_response',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: encodeCloudAgentResponse({ requestId: 'msg_plain_self_request', text: 'Yes, I can see it.' }),
      sessionId,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    }] },
    activeConversationId: cloudCollaborationConversationId('acct_me', 'kordi-desktop', sessionId),
  });

  assert.equal(answeredState.conversations[0]?.awaitingReply, false);
  assert.equal(answeredState.conversations[0]?.outreach, null);
  assert.equal(answeredState.conversations[0]?.messages.at(-1)?.text, 'Yes, I can see it.');
});

test('cloud self-agent bridge state ignores stale cached processing during startup hydration', () => {
  const sessionId = 'session:self-agent:stale-processing';
  const nowMs = Date.now();
  const request = {
    ...message,
    messageId: 'msg_stale_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    direction: 'outgoing',
    body: 'old request',
    sessionId,
    createdAt: new Date(nowMs - 20 * 60_000).toISOString(),
  } as CloudMessage;
  const processing = {
    ...request,
    messageId: 'msg_stale_processing',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'processing...',
      deliveryState: 'processing',
      execution: {
        phase: 'writing',
        summary: 'Writing the response',
        steps: [],
        updatedAtMs: nowMs - 2 * 60_000,
        completed: false,
      },
    }),
    createdAt: new Date(nowMs - 2 * 60_000).toISOString(),
  } as CloudMessage;

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { [account.accountId]: [request, processing] },
  });

  assert.equal(state.conversations[0]?.awaitingReply, false);
  assert.equal(
    state.conversations[0]?.messages.some((entry) => (
      entry.deliveryState === 'processing' || entry.localTurn?.completed === false
    )),
    false,
  );
});

test('planCloudSelfAgentSync backfills terminal local self-agent turns without runtime internals', () => {
  const state = {
    sessions: [
      { id: 'local-self-session', kind: 'self-agent', title: 'Hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'cloud-agent:acct_me:runtime', kind: 'self-agent', title: 'Runtime', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'u1', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10 },
      { id: 'a1', sessionId: 'local-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hi there', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20 },
      { id: 'u2', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'pending', status: 'sending', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30 },
      { id: 'runtime-u1', sessionId: 'cloud-agent:acct_me:runtime', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'internal', status: 'sent', sequenceNum: 1, createdAtMs: 40, updatedAtMs: 40 },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), [
    { localMessageId: 'u1', sessionId: 'local-self-session', role: 'user', text: 'hello', parentLocalMessageId: null, createdAtMs: 10, deliveryState: 'sent' },
    { localMessageId: 'a1', sessionId: 'local-self-session', role: 'agent', text: 'Hi there', parentLocalMessageId: 'u1', createdAtMs: 20, deliveryState: 'complete' },
  ]);

  assert.deepEqual(planCloudSelfAgentSync(state, { u1: { cloudMessageId: 'msg_remote', syncedAtMs: 123 } }), [
    { localMessageId: 'a1', sessionId: 'local-self-session', role: 'agent', text: 'Hi there', parentLocalMessageId: 'u1', createdAtMs: 20, deliveryState: 'complete' },
  ]);

  assert.deepEqual(planCloudSelfAgentSync(state, {}, { allowLocalBackfill: false }), []);
});
