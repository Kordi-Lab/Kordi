import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  cloudDirectMessageAgentRuntimeRoute,
  cloudDirectMessageDisplayText,
  encodeCloudDirectMessageEnvelope,
} from '../src/features/cloud/cloudDirectMessages';
import {
  encodeCloudGroupControl,
  parseCloudGroupControl,
} from '../src/features/cloud/cloudGroupMessages';
import {
  agentRuntimeRouteChangeNotice,
  cloudAgentRuntimeRouteForTargetCloudAgent,
  encodeCloudAgentRuntimeRouteChange,
} from '../src/features/cloud/cloudAgentRuntime';
import type { DesktopChatMessageRoute } from '../src/lib/desktop';

const iosRoute = {
  defaultModel: 'openai-codex/gpt-5.6-sol',
  defaultAuthProvider: 'openai-codex',
  defaultAuthChoice: 'oauth',
  thinking: 'high',
} as unknown as DesktopChatMessageRoute;

test('runtime route notices always describe the complete active route', () => {
  const previous = {
    model: 'openai/gpt-5.6-luna',
    authProvider: 'openai',
    authChoice: 'local-active-oauth',
    thinking: 'medium',
  } satisfies DesktopChatMessageRoute;
  const thinkingUpdate = {
    ...previous,
    thinking: 'xhigh',
  } satisfies DesktopChatMessageRoute;
  const modelUpdate = {
    ...thinkingUpdate,
    model: 'openai/gpt-5.6-sol',
  } satisfies DesktopChatMessageRoute;

  assert.equal(
    agentRuntimeRouteChangeNotice(thinkingUpdate, previous),
    'Model: openai/gpt-5.6-luna · Thinking effort: Extra High',
  );
  assert.equal(
    cloudDirectMessageDisplayText(
      encodeCloudAgentRuntimeRouteChange(thinkingUpdate, previous),
    ),
    'Model: openai/gpt-5.6-luna · Thinking effort: Extra High',
  );
  assert.equal(
    agentRuntimeRouteChangeNotice(modelUpdate, thinkingUpdate),
    'Model: openai/gpt-5.6-sol · Thinking effort: Extra High',
  );
});

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

test('an iOS model selection keeps the authenticated Mac execution profile', () => {
  assert.deepEqual(cloudAgentRuntimeRouteForTargetCloudAgent({
    requestRoute: {
      model: 'anthropic/claude-opus-4-1',
      authProvider: 'anthropic',
      authChoice: 'ios-cloud-snapshot',
      thinking: 'medium',
    },
    fallbackRoute: {
      model: 'anthropic/claude-haiku-4-5-20251001',
      authProvider: 'anthropic',
      authChoice: 'mac-claude-oauth',
      thinking: 'low',
    },
  }), {
    model: 'anthropic/claude-opus-4-1',
    authProvider: 'anthropic',
    authChoice: 'mac-claude-oauth',
    thinking: 'medium',
  });
});

test('a cross-device request route is authoritative before its model-change notice arrives', () => {
  assert.deepEqual(cloudAgentRuntimeRouteForTargetCloudAgent({
    requestRoute: {
      model: 'openai-codex/gpt-5.6-sol',
      authProvider: 'openai-codex',
      authChoice: 'synced-openai-oauth',
      thinking: 'high',
    },
    fallbackRoute: {
      model: 'anthropic/claude-haiku-4-5-20251001',
      authProvider: 'anthropic',
      authChoice: null,
      thinking: 'medium',
    },
  }), {
    model: 'openai-codex/gpt-5.6-sol',
    authProvider: 'openai-codex',
    authChoice: 'synced-openai-oauth',
    thinking: 'high',
  });
});

test('direct and group executors pass each immutable request route to the Mac runtime', () => {
  const directSource = readFileSync(
    new URL('../src/features/cloud/useCloudDirectAgentExecution.ts', import.meta.url),
    'utf8',
  );
  const groupSource = readFileSync(
    new URL('../src/features/cloud/cloudGroupAgentExecution.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    directSource,
    /requestRoute:\s*cloudDirectMessageAgentRuntimeRoute\(message\.body\)/,
  );
  assert.match(
    directSource,
    /cloudAgentRuntimeSessionId\(\s*account\.accountId,\s*activitySessionId \?\? peerId/,
  );
  assert.match(
    groupSource,
    /requestRoute:\s*message\.agentRuntimeRoute/,
  );
});

test('desktop agent requests carry the selected session route in direct and group envelopes', () => {
  const sendSource = readFileSync(
    new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    sendSource,
    /agentRuntimeRoute:\s*resolveChatRuntimeRoute\(cloudAgentMentionSessionId\)/,
  );
  assert.match(
    sendSource,
    /directHostedAgentTarget[\s\S]*?agentRuntimeRoute:\s*resolveChatRuntimeRoute\(\s*activeConvCanonicalSessionId \?\? activeConvId/,
  );
});

test('desktop local execution applies the selected route before reading provider readiness', () => {
  const sendSource = readFileSync(
    new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url),
    'utf8',
  );
  const executionSource = readFileSync(
    new URL('../src-tauri/src/chat/message_execution.rs', import.meta.url),
    'utf8',
  );

  assert.match(
    sendSource,
    /startDesktopChatMessage\([\s\S]*?runtimeRoute \?\? resolveChatRuntimeRoute\(canonicalSessionId\)/,
  );
  const applyRouteIndex = executionSource.indexOf(
    'apply_desktop_chat_message_route(&mut session, route.as_ref())',
  );
  const detailIndex = executionSource.indexOf('let detail = session.detail().ok()');
  const providerReadyIndex = executionSource.indexOf(
    'ensure_provider_ready_for_send(&provider, &model, &cwd)',
  );
  assert.ok(applyRouteIndex >= 0);
  assert.ok(detailIndex > applyRouteIndex);
  assert.ok(providerReadyIndex > detailIndex);
});

test('a new desktop agent session inherits its source route and publishes one titled Cloud identity', () => {
  const runtimeActionsSource = readFileSync(
    new URL('../src/app/useKordiAppRuntimeActions.ts', import.meta.url),
    'utf8',
  );
  const routeSyncSource = readFileSync(
    new URL('../src/app/useCloudAgentRuntimeRouteSync.ts', import.meta.url),
    'utf8',
  );
  const sendSource = readFileSync(
    new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    runtimeActionsSource,
    /onPrepareChatDraftSession:\s*\(\) => inheritCloudAgentRuntimeRoute\([\s\S]*?'draft:local-chat'/,
  );
  assert.match(
    routeSyncSource,
    /\[targetRuntimeSessionId\]: sourceRoute/,
  );
  assert.match(
    routeSyncSource,
    /if \(isLocalDraftChatConversationId\(sessionId\)\) return;/,
  );
  assert.match(
    sendSource,
    /publishCloudAgentRuntimeRouteChange\(\{[\s\S]*?sessionId: targetSessionId,[\s\S]*?initialSessionTitle:\s*initialCloudAgentSessionTitle/,
  );
});
