import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { openLocalAgentChatFromArgs } from '../src/app/openLocalAgentChat';
import { completeKordiCloudChatRequest, currentKordiCloudChatRequest } from '../src/features/chat/kordiCloudChatRoute';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudRunRuntimeRoute, routeRunsOnKordiCloud } from '../src/features/cloud/cloudAgentRuntimeRoute';
import { encodeCloudDirectMessageEnvelope, parseCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { setHostedAccountChoices, setLocalAccountChoices } from '../src/features/cloud/hostedAccountRegistry';
import { publishCloudSelfAgentOperations } from '../src/features/cloud/cloudSelfAgentForwardExecution';
import { cloudFallbackRunClaimsForMessages } from '../src/features/cloud/useCloudCollaborationState';
import { pendingCloudSelfAgentExecutionRequests } from '../src/features/cloud/cloudSelfAgentExecutionState';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { KORDI_CLOUD_RUNTIME_CAPTION, KordiCloudRuntimeCaptionView } from '../src/pages/chatsPage.kordiCloudCaption';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const hostedRoute = { model: 'custom/deepseek-chat', authProvider: 'custom', authChoice: 'cloud-api-key:bai', thinking: 'off' };
const localRoute = { model: 'openai/gpt-5.5', authProvider: 'openai', authChoice: 'local-active-api-key', thinking: 'medium' };
const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Me', primaryEmail: 'me@example.com', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};

test('a hosted-only route runs on Kordi Cloud and a local account keeps the local runtime', () => {
  assert.equal(routeRunsOnKordiCloud(hostedRoute), true);
  assert.equal(routeRunsOnKordiCloud({ ...hostedRoute, authChoice: 'cloud-login:team' }), true);
  assert.equal(routeRunsOnKordiCloud({ ...hostedRoute, model: '' }), false, 'a route needs a model to run');
  assert.equal(routeRunsOnKordiCloud(localRoute), false);
  assert.equal(routeRunsOnKordiCloud({ ...localRoute, authChoice: 'profile:key' }), false);
  assert.equal(routeRunsOnKordiCloud(null), false);
  assert.deepEqual(cloudRunRuntimeRoute(hostedRoute), {
    defaultModel: 'custom/deepseek-chat', defaultAuthProvider: 'custom', defaultAuthChoice: 'cloud-api-key:bai', thinking: 'off',
  });
});

test('a sign-in published from another Mac runs on Kordi Cloud until this Mac has it', () => {
  const copied = { ...localRoute, authChoice: 'profile:other-mac' };
  setHostedAccountChoices(['profile:other-mac', 'profile:key']);
  setLocalAccountChoices(['profile:key']);
  try {
    assert.equal(routeRunsOnKordiCloud(copied), true);
    assert.equal(routeRunsOnKordiCloud({ ...localRoute, authChoice: 'profile:key' }), false);
    setLocalAccountChoices(['profile:key', 'profile:other-mac']);
    assert.equal(routeRunsOnKordiCloud(copied), false);
  } finally {
    setHostedAccountChoices([]);
    setLocalAccountChoices([]);
  }
});

function selfRequest(messageId: string, route: typeof hostedRoute): CloudMessage {
  return {
    messageId, fromAccountId: account.accountId, toAccountId: account.accountId, direction: 'outgoing',
    body: encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: 'summarize this', agentRuntimeRoute: route }),
    sessionId: 'session:self-agent:bai', createdAt: new Date().toISOString(), deliveredAt: null, readAt: null,
  };
}

test('a Kordi Cloud request is claimed for the runner at once, with its route; a local one waits for the Mac', () => {
  const now = Date.now();
  const claims = cloudFallbackRunClaimsForMessages({
    account,
    contacts: [],
    messagesByPeer: { [account.accountId]: [selfRequest('msg_cloud', hostedRoute), selfRequest('msg_local', localRoute)] },
    selfAgentFallbackBeforeMs: now - 120_000,
  });
  assert.deepEqual(claims.map((claim) => claim.requestMessageId), ['msg_cloud']);
  assert.deepEqual(claims[0].runtimeRoute, cloudRunRuntimeRoute(hostedRoute));
  assert.equal(claims[0].prompt, 'summarize this');

  // This Mac executes only the local request; the hosted one is left to the runner.
  const pending = pendingCloudSelfAgentExecutionRequests({
    account,
    messageIndex: buildCloudMessageIndex(account.accountId, { [account.accountId]: [selfRequest('msg_cloud', hostedRoute), selfRequest('msg_local', localRoute)] }),
  });
  assert.deepEqual(pending.map((message) => message.messageId), ['msg_local']);
});

test('the cloud request carries the route, and this Mac posts no processing notice for it', async () => {
  const sent: Array<{ body: string; clientMessageId: string }> = [];
  const client = {
    async sendMessage(_token: string, accountId: string, body: string, options: { sessionId?: string | null; clientMessageId?: string | null }) {
      sent.push({ body, clientMessageId: options.clientMessageId ?? '' });
      return {
        messageId: `cloud-${sent.length}`, fromAccountId: accountId, toAccountId: accountId, body,
        sessionId: options.sessionId ?? null, createdAt: new Date().toISOString(), deliveredAt: null, readAt: null,
      } satisfies CloudMessage;
    },
  };
  await publishCloudSelfAgentOperations({
    accountId: account.accountId,
    client,
    ledger: {},
    mergeMessage: () => {},
    operations: [{
      localMessageId: 'local-request', sessionId: 'session:self-agent:bai', role: 'user', text: 'summarize this',
      parentLocalMessageId: null, createdAtMs: 1_000, deliveryState: 'sent', agentRuntimeRoute: hostedRoute,
    }],
    saveLedger: () => {},
    shouldPublishProcessing: () => true,
    token: 'test-token',
  });
  assert.equal(sent.length, 1, 'only the request; the runner reports progress');
  const envelope = parseCloudDirectMessageEnvelope(sent[0].body);
  assert.equal(envelope?.text, 'summarize this');
  assert.deepEqual(envelope?.agentRuntimeRoute, hostedRoute);
});

test('Start chat with a hosted-only account opens the chat with its route and never loads the model locally', async () => {
  const calls: string[] = [];
  const args = {
    setActiveNav: (nav: 'chats') => { calls.push(`nav:${nav}`); },
    chatConversations: [],
    handleSelectChatSession: async (sessionId: string) => { calls.push(`select:${sessionId}`); },
    handleCreateChatSession: async () => { calls.push('create'); },
  };
  await openLocalAgentChatFromArgs(args, hostedRoute.model, hostedRoute);
  assert.deepEqual(calls, ['nav:chats', 'create']);
  const request = currentKordiCloudChatRequest();
  assert.deepEqual(request, { route: hostedRoute, sessionId: null });
  if (request) completeKordiCloudChatRequest(request);
  assert.equal(currentKordiCloudChatRequest(), null);

  calls.length = 0;
  await openLocalAgentChatFromArgs(args);
  assert.deepEqual(calls, ['nav:chats', 'create'], 'a local chat opens as before');
  assert.equal(currentKordiCloudChatRequest(), null);
});

test('the composer says when the chat runs on Kordi Cloud', () => {
  assert.equal(KORDI_CLOUD_RUNTIME_CAPTION, 'Runs on Kordi Cloud');
  assert.match(renderToStaticMarkup(createElement(KordiCloudRuntimeCaptionView, { show: true })), />Runs on Kordi Cloud</);
  assert.equal(renderToStaticMarkup(createElement(KordiCloudRuntimeCaptionView, { show: false })), '');
});
