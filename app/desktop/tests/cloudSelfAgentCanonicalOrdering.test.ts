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
