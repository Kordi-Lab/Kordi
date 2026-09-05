import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { runtimeRoutesMatch } from '../src/features/cloud/cloudAgentRuntimeRoute';
import { CLOUD_AGENT_RUNTIME_SESSION_PREFIX } from '../src/features/cloud/cloudAgentMessages';
import {
  applyCloudAgentModelChangeMessages,
  applySynchronizedCloudAgentRuntimeRoutes,
  cloudAgentRuntimeRouteAfterModelChange,
  cloudAgentRuntimeSessionId,
  encodeCloudAgentRuntimeRouteChange,
  latestCloudAgentModelChangeBeforeRequest,
  latestCloudAgentRuntimeRouteChangeBeforeRequest,
  modelFromAgentModelChangeNotice,
} from '../src/features/cloud/cloudAgentRuntime';

test('explicit cloud sessions keep independent runtime route identities for the same peer', () => {
  for (const suffix of ['one', 'two']) {
    assert.equal(
      cloudAgentRuntimeSessionId(
        'acct_me',
        `cloud:conversation:acct_me:agent:session:session%3Aself-agent%3A${suffix}`,
      ),
      `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}acct_me:session:self-agent:${suffix}`,
    );
  }
});

test('unchanged runtime routes ignore provider and effort spelling aliases', () => {
  const route = { model: 'gpt-6-astra', authProvider: 'openai-codex', authChoice: 'local-active-oauth', thinking: 'xhigh' };
  const qualified = { ...route, model: 'openai/gpt-6-astra', authProvider: 'openai', thinking: 'Extra High' };
  assert.equal(runtimeRoutesMatch(route, qualified), true);
  assert.equal(runtimeRoutesMatch({ ...route, model: 'openai-codex/gpt-6-astra' }, qualified), true);
  assert.equal(runtimeRoutesMatch(route, { ...qualified, thinking: 'medium' }), false);
  assert.equal(runtimeRoutesMatch(route, { ...qualified, model: 'openai/gpt-5.6-sol' }), false);
});

test('model-change notices update the matching cloud runtime route once', () => {
  const sessionId = 'session:group:cloud-room';
  const runtimeSessionId = cloudAgentRuntimeSessionId('acct_me', sessionId) ?? '';
  const current = { [runtimeSessionId]: {
    model: 'openai/gpt-5.6-sol', authProvider: 'openai',
    authChoice: 'local-openai-account', thinking: 'high',
  } };
  const messages = [{
    id: 'model-change-old', sessionId, senderIdentityId: 'identity_me', senderRole: 'system',
    messageKind: 'agent-model-change', contentText: 'Switched model to anthropic/claude-sonnet-4-6',
    status: 'complete', sequenceNum: 4, createdAtMs: 4, updatedAtMs: 4,
  }, {
    id: 'model-change-latest', sessionId, senderIdentityId: 'identity_me', senderRole: 'system',
    messageKind: 'agent-model-change', contentText: 'Switched model to anthropic/claude-opus-4-1',
    content: { agentRuntimeRoute: {
      model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic',
      authChoice: 'claude-work', thinking: 'max',
    } },
    status: 'complete', sequenceNum: 5, createdAtMs: 5, updatedAtMs: 5,
  }];
  const next = applyCloudAgentModelChangeMessages(current, 'acct_me', messages);
  assert.equal(modelFromAgentModelChangeNotice(messages[1]?.contentText), 'anthropic/claude-opus-4-1');
  assert.deepEqual(next[runtimeSessionId], {
    model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic',
    authChoice: 'claude-work', thinking: 'max',
  });
  assert.equal(applyCloudAgentModelChangeMessages(next, 'acct_me', messages), next);
});

test('OpenAI provider aliases preserve the executing auth profile across route updates', () => {
  assert.deepEqual(cloudAgentRuntimeRouteAfterModelChange(
    { model: 'openai/gpt-5.6-luna', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: 'high' },
    { model: 'openai/gpt-5.6-sol', authProvider: 'openai-codex', thinking: 'max' },
  ), {
    model: 'openai/gpt-5.6-sol', authProvider: 'openai',
    authChoice: 'local-active-oauth', thinking: 'max',
  });
});

test("legacy profile ids rebind to the executing Mac's portable auth choice", () => {
  assert.deepEqual(cloudAgentRuntimeRouteAfterModelChange(
    { model: 'openai/gpt-5.6-luna', authProvider: 'openai', authChoice: 'profile:old-device', thinking: 'high' },
    { model: 'openai/gpt-5.6-sol', authProvider: 'openai-codex', authChoice: 'profile:old-device', thinking: 'max' },
    { model: 'openai/gpt-5.6-sol', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: 'max' },
  ), {
    model: 'openai/gpt-5.6-sol', authProvider: 'openai',
    authChoice: 'local-active-oauth', thinking: 'max',
  });
});

test('synchronized session routes reject device-local profile ids', () => {
  assert.throws(() => encodeCloudAgentRuntimeRouteChange({
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai',
    authChoice: 'profile:local-device',
  }), /cannot contain a local auth profile id/);
});

test('ordered Cloud route changes win over a lagging canonical mirror atomically', () => {
  const sessionId = 'session:self-agent:route-race';
  const runtimeSessionId = cloudAgentRuntimeSessionId('acct_me', sessionId) ?? '';
  const canonicalMessages = [{
    id: 'canonical-stale', sessionId, senderIdentityId: 'identity_me', senderRole: 'system',
    messageKind: 'agent-model-change', contentText: 'Switched model to anthropic/claude-opus-4-1',
    content: { agentRuntimeRoute: {
      model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic',
      authChoice: 'claude-oauth', thinking: 'high',
    } },
    status: 'complete', sequenceNum: 10, createdAtMs: 10, updatedAtMs: 10,
  }];
  const routeMessage = (
    id: string, from: string, sequence: number, route: Parameters<typeof encodeCloudAgentRuntimeRouteChange>[0],
  ): CloudMessage => ({
    messageId: id, fromAccountId: from, toAccountId: 'acct_me',
    body: encodeCloudAgentRuntimeRouteChange(route), createdAt: `2026-08-17T00:00:0${sequence - 11}.000Z`,
    deliveredAt: null, readAt: null, direction: from === 'acct_me' ? 'outgoing' : 'incoming',
    sessionId, conversationSequence: sequence, messageKind: 'agent-model-change',
  });
  const cloudMessages = [
    routeMessage('cloud-latest', 'acct_me', 11, {
      model: 'openai/gpt-5.6-sol', authProvider: 'openai-codex', authChoice: 'local-active-oauth', thinking: 'max',
    }),
    routeMessage('another-owners-newer-route', 'acct_peer', 12, {
      model: 'anthropic/claude-opus-4-6', authProvider: 'anthropic', authChoice: 'remote-owners-auth', thinking: 'high',
    }),
  ];
  const next = applySynchronizedCloudAgentRuntimeRoutes({}, 'acct_me', canonicalMessages, cloudMessages);
  assert.deepEqual(next[runtimeSessionId], {
    model: 'openai/gpt-5.6-sol', authProvider: 'openai',
    authChoice: 'local-active-oauth', thinking: 'max',
  });
});

test('the latest preceding model-change event is authoritative for the next request', () => {
  const sessionId = 'session:self-agent:one';
  const modelChange: CloudMessage = {
    messageId: 'model-change', fromAccountId: 'acct_me', toAccountId: 'acct_me',
    body: encodeCloudAgentRuntimeRouteChange({
      model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic',
      authChoice: 'claude-shared-oauth', thinking: 'xhigh',
    }),
    createdAt: '2026-08-16T10:00:00.000Z', deliveredAt: null, readAt: null,
    direction: 'outgoing', sessionId, conversationSequence: 8, messageKind: 'agent-model-change',
  };
  const request: CloudMessage = {
    ...modelChange, messageId: 'request', body: 'Which model are you using?',
    createdAt: '2026-08-16T10:00:01.000Z', conversationSequence: 9, messageKind: 'text',
  };
  assert.equal(latestCloudAgentModelChangeBeforeRequest([request, modelChange], request), 'anthropic/claude-opus-4-1');
  const route = latestCloudAgentRuntimeRouteChangeBeforeRequest([request, modelChange], request);
  assert.deepEqual(route, {
    model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic',
    authChoice: 'claude-shared-oauth', thinking: 'xhigh',
  });
  assert.deepEqual(cloudAgentRuntimeRouteAfterModelChange(
    { model: 'openai-codex/gpt-5.6-sol', authProvider: 'openai-codex', authChoice: 'oauth', thinking: 'high' },
    route,
    { model: 'anthropic/claude-sonnet-4-6', authProvider: 'anthropic', authChoice: 'claude-oauth' },
  ), route);
});
