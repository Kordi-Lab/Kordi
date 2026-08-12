import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  cloudSelfAgentOperationClientMessageId,
  planCloudSelfAgentCanonicalSync,
} from '../src/features/cloud/useCloudCollaborationState';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

function stateWithMessages(
  sessionId: string,
  messages: CanonicalSessionMessage[],
): CanonicalSessionState {
  return {
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'Self agent',
      status: 'active',
      createdByIdentityId: 'human:acct_me',
      primaryIdentityId: 'agent:me',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    identities: [],
    participants: [],
    profile: {
      id: 'profile',
      storageRoot: '/tmp',
      humanIdentityId: 'human:acct_me',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages,
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  };
}

function cloudEcho({
  messageId,
  localMessageId,
  sessionId,
  text,
  createdAt,
}: {
  messageId: string;
  localMessageId: string;
  sessionId: string;
  text: string;
  createdAt: string;
}): CloudMessage {
  return {
    messageId,
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: text,
    createdAt,
    deliveredAt: null,
    readAt: null,
    sessionId,
    clientMessageId: cloudSelfAgentOperationClientMessageId({
      localMessageId,
      sessionId,
      role: 'user',
      text,
      parentLocalMessageId: null,
      createdAtMs: Date.parse(createdAt),
      deliveryState: 'sent',
    }),
  };
}

test('delayed V2 echoes reconcile to the local row by client message id', () => {
  const sessionId = 'local-self-session-delayed';
  const localMessageId = 'msg:ui:delayed-send';
  const echo = cloudEcho({
    messageId: '019ff256-c45b-7743-9707-360df1bf3283',
    localMessageId,
    sessionId,
    text: 'check my account',
    createdAt: '2026-08-11T19:40:00.000Z',
  });
  const state = stateWithMessages(sessionId, [
    {
      id: localMessageId,
      sessionId,
      senderIdentityId: 'human:acct_me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: echo.body,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: Date.parse(echo.createdAt) - 7_000,
      updatedAtMs: Date.parse(echo.createdAt) - 7_000,
      sourceTransport: 'desktop-chat-ui',
    },
    {
      id: `msg:cloud:self:${echo.messageId}`,
      sessionId,
      senderIdentityId: 'human:acct_me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: echo.body,
      status: 'sent',
      sequenceNum: 2,
      createdAtMs: Date.parse(echo.createdAt),
      updatedAtMs: Date.parse(echo.createdAt),
      sourceTransport: 'cloud-self-agent',
      sourceEventId: echo.messageId,
    },
  ]);

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [echo],
    state,
  });

  assert.equal(plan.messageRequests.length, 0);
  assert.deepEqual(plan.mirrorReconciliations, [{
    preferredMessageId: localMessageId,
    duplicateMessageId: `msg:cloud:self:${echo.messageId}`,
  }]);
});

test('distinct client IDs preserve repeated text as distinct intents', () => {
  const sessionId = 'local-self-session-repeated';
  const firstEcho = cloudEcho({
    messageId: '019ff256-c45b-7743-9707-360df1bf3284',
    localMessageId: 'msg:ui:repeat-one',
    sessionId,
    text: 'same text',
    createdAt: '2026-08-11T19:40:00.000Z',
  });
  const secondEcho = cloudEcho({
    messageId: '019ff256-c45b-7743-9707-360df1bf3285',
    localMessageId: 'msg:ui:repeat-two',
    sessionId,
    text: 'same text',
    createdAt: '2026-08-11T19:40:01.000Z',
  });
  const localMessage = (
    id: string,
    sequenceNum: number,
    createdAt: string,
  ): CanonicalSessionMessage => ({
    id,
    sessionId,
    senderIdentityId: 'human:acct_me',
    senderRole: 'user',
    messageKind: 'text',
    contentText: 'same text',
    status: 'sent',
    sequenceNum,
    createdAtMs: Date.parse(createdAt),
    updatedAtMs: Date.parse(createdAt),
    sourceTransport: 'desktop-chat-ui',
  });
  const state = stateWithMessages(sessionId, [
    localMessage('msg:ui:repeat-one', 1, firstEcho.createdAt),
    localMessage('msg:ui:repeat-two', 2, secondEcho.createdAt),
  ]);

  const plan = planCloudSelfAgentCanonicalSync({
    account,
    messages: [secondEcho, firstEcho],
    state,
  });

  assert.equal(plan.messageRequests.length, 0);
  assert.deepEqual(plan.mirrorReconciliations, []);
});
