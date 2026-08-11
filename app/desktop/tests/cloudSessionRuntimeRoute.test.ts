import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudDirectMessageAgentRuntimeRoute,
  encodeCloudDirectMessageEnvelope,
} from '../src/features/cloud/cloudDirectMessages';
import {
  encodeCloudGroupControl,
  parseCloudGroupControl,
} from '../src/features/cloud/cloudGroupMessages';
import { cloudAgentRuntimeRouteForTargetCloudAgent } from '../src/features/cloud/cloudAgentRuntime';
import type { DesktopChatMessageRoute } from '../src/lib/desktop';

const iosRoute = {
  defaultModel: 'openai-codex/gpt-5.6-sol',
  defaultAuthProvider: 'openai-codex',
  defaultAuthChoice: 'oauth',
  thinking: 'high',
} as unknown as DesktopChatMessageRoute;

test('Mac decodes an iOS session runtime route from a direct agent request', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: '@MyKordi check this',
    targetCloudAgentOwnerAccountId: 'acct_me',
    agentRuntimeRoute: iosRoute,
  });

  assert.deepEqual(cloudDirectMessageAgentRuntimeRoute(body), {
    model: 'openai-codex/gpt-5.6-sol',
    authProvider: 'openai-codex',
    authChoice: 'oauth',
    thinking: 'high',
  });
});

test('Mac preserves an iOS session runtime route inside group requests', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:runtime-route',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null },
    ],
    message: {
      id: 'msg_route',
      senderAccountId: 'acct_me',
      text: '@MyKordi check this',
      createdAtMs: 1,
      agentRuntimeRoute: iosRoute,
    },
  });

  assert.deepEqual(parseCloudGroupControl(body)?.message?.agentRuntimeRoute, {
    model: 'openai-codex/gpt-5.6-sol',
    authProvider: 'openai-codex',
    authChoice: 'oauth',
    thinking: 'high',
  });
});

test('an explicit owner session route wins over the Mac fallback route', () => {
  assert.deepEqual(cloudAgentRuntimeRouteForTargetCloudAgent({
    requestRoute: { model: 'openai/gpt-5.6-terra', thinking: 'medium' },
    fallbackRoute: { model: 'openai/gpt-5.4', thinking: 'low' },
  }), {
    model: 'openai/gpt-5.6-terra',
    thinking: 'medium',
  });
});
