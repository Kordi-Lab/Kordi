import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
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

test('same-timestamp cloud self-agent replies attach to an existing local request before deduplication', () => {
  const createdAt = '2026-08-09T06:06:49.436Z';
  const createdAtMs = Date.parse(createdAt);
  const sessionId = 'session:self-agent:same-timestamp';
  const localRequestId = 'msg:ui:local-request';
  const cloudRequest: CloudMessage = {
    messageId: 'msg_f1e3e0561770408f9ea25db8833cd485',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'hi',
    createdAt,
    deliveredAt: null,
    readAt: null,
    sessionId,
  };
  const cloudFailure: CloudMessage = {
    ...cloudRequest,
    messageId: 'msg_45fe64ea85a24ca1998ad312ee9ddc85',
    body: encodeCloudAgentResponse({
      requestId: cloudRequest.messageId,
      text: 'No provider configured yet.',
      deliveryState: 'failed',
    }),
  };
  const state = {
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'hi',
      status: 'active',
      createdByIdentityId: 'human:acct_me',
      primaryIdentityId: 'agent:local',
      createdAtMs,
      updatedAtMs: createdAtMs,
    }],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp/device-a',
      humanIdentityId: 'human:acct_me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [{
      id: localRequestId,
      sessionId,
      senderIdentityId: 'human:acct_me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'hi',
      content: null,
      parentMessageId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs,
      updatedAtMs: createdAtMs,
      sourceTransport: 'desktop-chat-ui',
      sourceEventId: 'desktop-chat-ui:local-request',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-a/canonical.sqlite3',
  } as CanonicalSessionState;

  // The response ID sorts before the request ID lexically. Dependency ordering
  // must still materialize the request alias before planning the response.
  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [cloudFailure, cloudRequest],
    state,
  });
  const response = plan.messageRequests.find(
    (message) => message.senderRole === 'owned-agent',
  );

  assert.equal(response?.parentMessageId, localRequestId);
  assert.equal(response?.content?.requestId, localRequestId);
  assert.equal(response?.content?.replyToMessageId, localRequestId);
  assert.equal(response?.status, 'failed');
});

test('repeated prompts resolve Cloud replies to the nearest matching local request', () => {
  const firstAtMs = Date.parse('2026-08-09T07:00:00.000Z');
  const sessionId = 'session:self-agent:repeated-prompt';
  const request = (messageId: string, createdAtMs: number): CloudMessage => ({
    messageId,
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'try again',
    createdAt: new Date(createdAtMs).toISOString(),
    deliveredAt: null,
    readAt: null,
    sessionId,
  });
  const response = (
    messageId: string,
    requestMessageId: string,
    createdAtMs: number,
  ): CloudMessage => ({
    ...request(messageId, createdAtMs),
    body: encodeCloudAgentResponse({
      requestId: requestMessageId,
      text: `answer for ${requestMessageId}`,
      deliveryState: 'complete',
    }),
  });
  const firstRequest = request('cloud-request-1', firstAtMs);
  const secondRequest = request('cloud-request-2', firstAtMs + 1_000);
  const state = {
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'try again',
      status: 'active',
      createdByIdentityId: 'human:acct_me',
      primaryIdentityId: 'agent:local',
      createdAtMs: firstAtMs,
      updatedAtMs: firstAtMs + 1_000,
    }],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp/device-a',
      humanIdentityId: 'human:acct_me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [
      {
        id: 'local-request-1',
        sessionId,
        senderIdentityId: 'human:acct_me',
        senderRole: 'user',
        messageKind: 'text',
        contentText: 'try again',
        status: 'sent',
        sequenceNum: 1,
        createdAtMs: firstAtMs,
        updatedAtMs: firstAtMs,
        sourceTransport: 'desktop-chat-ui',
      },
      {
        id: 'local-request-2',
        sessionId,
        senderIdentityId: 'human:acct_me',
        senderRole: 'user',
        messageKind: 'text',
        contentText: 'try again',
        status: 'sent',
        sequenceNum: 2,
        createdAtMs: firstAtMs + 1_000,
        updatedAtMs: firstAtMs + 1_000,
        sourceTransport: 'desktop-chat-ui',
      },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-a/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [
      secondRequest,
      response('cloud-response-1', firstRequest.messageId, firstAtMs + 100),
      firstRequest,
      response(
        'cloud-response-2',
        secondRequest.messageId,
        firstAtMs + 1_100,
      ),
    ],
    state,
  });

  assert.deepEqual(
    plan.messageRequests.map((message) => message.parentMessageId),
    ['local-request-1', 'local-request-2'],
  );
});

test('nearby repeated Cloud prompts remain distinct without a local sending-device row', () => {
  const firstAtMs = Date.parse('2026-08-09T07:30:00.000Z');
  const sessionId = 'session:self-agent:cloud-repeated-prompt';
  const state = {
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'try again',
      status: 'active',
      createdByIdentityId: 'human:acct_me',
      primaryIdentityId: 'agent:cloud-self:acct_me',
      createdAtMs: firstAtMs,
      updatedAtMs: firstAtMs,
    }],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp/device-b',
      humanIdentityId: 'human:acct_me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [{
      id: 'msg:cloud:self:cloud-request-1',
      sessionId,
      senderIdentityId: 'human:acct_me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'try again',
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: firstAtMs,
      updatedAtMs: firstAtMs,
      sourceTransport: 'cloud-self-agent',
      sourceEventId: 'cloud-request-1',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-b/canonical.sqlite3',
  } as CanonicalSessionState;
  const secondRequest: CloudMessage = {
    messageId: 'cloud-request-2',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'try again',
    createdAt: new Date(firstAtMs + 1_000).toISOString(),
    deliveredAt: null,
    readAt: null,
    sessionId,
  };

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [secondRequest],
    state,
  });

  assert.equal(plan.messageRequests.length, 1);
  assert.equal(
    plan.messageRequests[0]?.id,
    'msg:cloud:self:cloud-request-2',
  );
});

test('large self-agent restore matches existing local requests within the startup budget', () => {
  const sessionId = 'session:self-agent:large-restore';
  const baseAtMs = Date.parse('2026-08-09T08:00:00.000Z');
  const count = 8_000;
  const state = {
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'large restore',
      status: 'active',
      createdByIdentityId: 'human:acct_me',
      primaryIdentityId: 'agent:local',
      createdAtMs: baseAtMs,
      updatedAtMs: baseAtMs + count,
    }],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp/device-a',
      humanIdentityId: 'human:acct_me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: Array.from({ length: count }, (_, index) => ({
      id: `local-request-${index}`,
      sessionId,
      senderIdentityId: 'human:acct_me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: `prompt ${index}`,
      status: 'sent',
      sequenceNum: index + 1,
      createdAtMs: baseAtMs + index,
      updatedAtMs: baseAtMs + index,
      sourceTransport: 'desktop-chat-ui',
    })),
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-a/canonical.sqlite3',
  } as CanonicalSessionState;
  const messages: CloudMessage[] = Array.from(
    { length: count },
    (_, index) => ({
      messageId: `cloud-request-${index}`,
      fromAccountId: account.accountId,
      toAccountId: account.accountId,
      body: `prompt ${index}`,
      createdAt: new Date(baseAtMs + index).toISOString(),
      deliveredAt: null,
      readAt: null,
      sessionId,
    }),
  );

  const startedAt = performance.now();
  const plan = planCloudSelfAgentCanonicalSync({ account, messages, state });
  const durationMs = performance.now() - startedAt;

  assert.equal(plan.messageRequests.length, 0);
  assert.ok(durationMs < 1_000, `large restore took ${durationMs}ms`);
});

test('large duplicate Cloud history is indexed without quadratic restore work', () => {
  const sessionId = 'session:self-agent:duplicate-restore';
  const createdAt = '2026-08-09T09:00:00.000Z';
  const state = {
    sessions: [],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp/device-b',
      humanIdentityId: 'human:acct_me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-b/canonical.sqlite3',
  } as CanonicalSessionState;
  const messages: CloudMessage[] = Array.from(
    { length: 8_000 },
    (_, index) => ({
      messageId: `duplicate-cloud-request-${index}`,
      fromAccountId: account.accountId,
      toAccountId: account.accountId,
      body: 'same repeated prompt',
      createdAt,
      deliveredAt: null,
      readAt: null,
      sessionId,
    }),
  );

  const startedAt = performance.now();
  const plan = planCloudSelfAgentCanonicalSync({ account, messages, state });
  const durationMs = performance.now() - startedAt;

  assert.equal(plan.sessionRequests.length, 1);
  assert.equal(plan.messageRequests.length, 1);
  assert.ok(durationMs < 1_000, `duplicate restore took ${durationMs}ms`);
});

test('near-time alternate legacy replay ids converge onto the existing canonical keeper', () => {
  const sessionId = 'session:self-agent:legacy-keeper';
  const requestAt = '2026-08-09T10:00:00.000Z';
  const responseAt = '2026-08-09T10:00:01.000Z';
  const requestAtMs = Date.parse(requestAt);
  const responseAtMs = Date.parse(responseAt);
  const canonicalRequestId = 'msg:cloud:self:cloud-request-keeper';
  const canonicalResponseId =
    'msg:cloud:self:response:cloud-request-keeper';
  const state = {
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'same request',
      status: 'active',
      createdByIdentityId: 'human:acct_me',
      primaryIdentityId: 'agent:cloud-self:acct_me',
      createdAtMs: requestAtMs,
      updatedAtMs: responseAtMs,
    }],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp/device-c',
      humanIdentityId: 'human:acct_me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [{
      id: canonicalRequestId,
      sessionId,
      senderIdentityId: 'human:acct_me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'same request',
      content: null,
      parentMessageId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: requestAtMs,
      updatedAtMs: requestAtMs,
      sourceTransport: 'cloud-self-agent',
      sourceEventId: 'cloud-request-keeper',
    }, {
      id: canonicalResponseId,
      sessionId,
      senderIdentityId: 'agent:cloud-self:acct_me',
      senderRole: 'owned-agent',
      messageKind: 'agent-turn',
      contentText: 'done',
      content: {
        cloudRequestMessageId: 'cloud-request-keeper',
        requestId: canonicalRequestId,
        replyToMessageId: canonicalRequestId,
        deliveryState: 'complete',
      },
      parentMessageId: canonicalRequestId,
      status: 'complete',
      sequenceNum: 2,
      createdAtMs: responseAtMs,
      updatedAtMs: responseAtMs,
      sourceTransport: 'cloud-self-agent',
      sourceEventId: 'cloud-response-keeper',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-c/canonical.sqlite3',
  } as CanonicalSessionState;
  const alternateRequest: CloudMessage = {
    messageId: 'cloud-request-alternate',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'same request',
    createdAt: '2026-08-09T10:00:00.650Z',
    deliveredAt: '2026-08-09T10:00:00.650Z',
    readAt: '2026-08-09T10:00:00.650Z',
    sessionId,
  };
  const alternateResponse: CloudMessage = {
    ...alternateRequest,
    messageId: 'cloud-response-alternate',
    body: encodeCloudAgentResponse({
      requestId: alternateRequest.messageId,
      text: 'done',
      deliveryState: 'complete',
    }),
    createdAt: responseAt,
    deliveredAt: responseAt,
    readAt: responseAt,
  };

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [alternateRequest, alternateResponse],
    state,
  });

  assert.equal(plan.sessionRequests.length, 0);
  assert.equal(plan.messageRequests.length, 0);
});
