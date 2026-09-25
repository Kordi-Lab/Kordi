import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveDefaultCloudAgentRuntimeRoute } from '../src/app/useKordiDefaultCloudAgentRuntimeRoute';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { resolveCloudAgentRuntimeRouteChange } from '../src/features/cloud/cloudAgentRuntimeRouteChange';
import { runtimeRoutesMatch } from '../src/features/cloud/cloudAgentRuntimeRoute';
import { CLOUD_AGENT_RUNTIME_SESSION_PREFIX } from '../src/features/cloud/cloudAgentMessages';
import {
  applyCloudAgentModelChangeMessages,
  applySynchronizedCloudAgentRuntimeRoutes,
  cloudAgentRuntimeRouteAfterModelChange,
  cloudAgentRuntimeRouteChangeFromBody,
  cloudAgentRuntimeSessionId,
  encodeCloudAgentRuntimeRouteChange,
  latestCloudAgentModelChangeBeforeRequest,
  latestCloudAgentRuntimeRouteChangeBeforeRequest,
  modelFromAgentModelChangeNotice,
} from '../src/features/cloud/cloudAgentRuntime';
import type { DesktopAuthState } from '../src/kordi-app/types';

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

test('configured ChatGPT auth replaces a stale Anthropic choice for an OpenAI model', () => {
  const desktopAuthState: DesktopAuthState = {
    authPath: '/redacted/auth.json',
    hasAnyAuth: true,
    providers: [{
      id: 'openai-codex',
      label: 'ChatGPT',
      statusSummary: 'Connected',
      loginHint: '',
      envVar: '',
      helpUrl: '',
      supportsOAuth: true,
      supportsApiKey: false,
      configured: true,
      authority: null,
      baseUrl: null,
      preferredModel: 'openai/gpt-6-astra',
      options: [{
        value: 'profile:chatgpt',
        profileId: 'chatgpt',
        method: 'OAuth',
        source: 'Kordi auth',
        label: 'ChatGPT account',
        active: true,
      }],
    }],
  };
  const authOptions = [{
    providerId: 'openai-codex',
    providerLabel: 'ChatGPT',
    methodLabel: 'OAuth',
    value: 'profile:chatgpt',
    label: 'ChatGPT account',
    active: true,
  }];
  const resolvedLocalRoute = resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai-codex',
    authOptions,
    chatModelOptions: [{ value: 'openai/gpt-6-astra', label: 'GPT-6 Astra' }],
    desktopAuthState,
    isNativeShell: true,
    preferredModelValueForProvider: () => 'openai/gpt-6-astra',
    resolveComposerProviderId: () => 'openai',
    selectedModel: 'openai/gpt-6-astra',
    selectedThinking: 'high',
  });

  assert.deepEqual(resolveCloudAgentRuntimeRouteChange({
    authOptions,
    input: {
      sessionId: 'session:self-agent:openai',
      model: 'openai/gpt-6-astra',
      authProvider: 'anthropic',
      authChoice: 'local-active-oauth',
      thinking: 'high',
    },
    resolvedLocalRoute,
  }), {
    model: 'openai/gpt-6-astra',
    authProvider: 'openai-codex',
    authChoice: 'profile:chatgpt',
    thinking: 'high',
  });
});

test('configured ChatGPT auth replaces a generic OpenAI OAuth alias', () => {
  assert.deepEqual(resolveCloudAgentRuntimeRouteChange({
    authOptions: [{
      providerId: 'openai-codex', providerLabel: 'ChatGPT', methodLabel: 'OAuth',
      value: 'profile:chatgpt', label: 'ChatGPT account', active: true,
    }],
    input: {
      sessionId: 'session:group:openai',
      model: 'openai/gpt-6-astra',
      authProvider: 'openai',
      authChoice: 'local-active-oauth',
      thinking: 'medium',
    },
    resolvedLocalRoute: {
      model: 'openai/gpt-6-astra',
      authProvider: 'openai-codex',
      authChoice: 'local-active-oauth',
      thinking: 'medium',
    },
  }), {
    model: 'openai/gpt-6-astra',
    authProvider: 'openai-codex',
    authChoice: 'local-active-oauth',
    thinking: 'medium',
  });
});

test('an unavailable model provider falls back to the configured local provider and model', () => {
  assert.deepEqual(resolveCloudAgentRuntimeRouteChange({
    authOptions: [{
      providerId: 'openai-codex', providerLabel: 'ChatGPT', methodLabel: 'OAuth',
      value: 'profile:chatgpt', label: 'ChatGPT account', active: true,
    }],
    input: {
      sessionId: 'session:group:fallback',
      model: 'anthropic/claude-opus-4-1',
      authProvider: 'anthropic',
      authChoice: 'local-active-oauth',
      thinking: 'high',
    },
    resolvedLocalRoute: {
      model: 'openai/gpt-6-astra',
      authProvider: 'openai-codex',
      authChoice: 'local-active-oauth',
      thinking: 'medium',
    },
  }), {
    model: 'openai/gpt-6-astra',
    authProvider: 'openai-codex',
    authChoice: 'local-active-oauth',
    thinking: 'high',
  });
});

test('route changes preserve an explicit provider alias from the selected model family', () => {
  assert.deepEqual(resolveCloudAgentRuntimeRouteChange({
    authOptions: [{
      providerId: 'openai-codex', providerLabel: 'ChatGPT', methodLabel: 'OAuth',
      value: 'profile:chatgpt', label: 'ChatGPT account', active: true,
    }],
    input: {
      sessionId: 'session:self-agent:openai-alias',
      model: 'openai/gpt-6-astra',
      authProvider: 'openai-codex',
      authChoice: 'profile:chatgpt',
    },
    resolvedLocalRoute: {
      model: 'openai/gpt-6-astra', authProvider: 'openai',
      authChoice: 'local-active-oauth',
    },
  }), {
    model: 'openai/gpt-6-astra',
    authProvider: 'openai-codex',
    authChoice: 'profile:chatgpt',
  });
});

test('route changes preserve an explicit provider for an unqualified model', () => {
  assert.deepEqual(resolveCloudAgentRuntimeRouteChange({
    authOptions: [{
      providerId: 'anthropic', providerLabel: 'Anthropic', methodLabel: 'OAuth',
      value: 'profile:claude', label: 'Claude account', active: true,
    }],
    input: {
      sessionId: 'session:self-agent:anthropic',
      model: 'claude-opus-4-1',
      authProvider: 'anthropic',
      authChoice: 'profile:claude',
    },
    resolvedLocalRoute: {
      model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic',
      authChoice: 'local-active-oauth',
    },
  }), {
    model: 'anthropic/claude-opus-4-1',
    authProvider: 'anthropic',
    authChoice: 'profile:claude',
  });
});

test('synchronized profile choice stays bound to its selected account', () => {
  assert.deepEqual(cloudAgentRuntimeRouteAfterModelChange(
    { model: 'openai/gpt-5.6-luna', authProvider: 'openai', authChoice: 'profile:old-device', thinking: 'high' },
    { model: 'openai/gpt-5.6-sol', authProvider: 'openai-codex', authChoice: 'profile:old-device', thinking: 'max' },
    { model: 'openai/gpt-5.6-sol', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: 'max' },
  ), {
    model: 'openai/gpt-5.6-sol', authProvider: 'openai',
    authChoice: 'profile:old-device', thinking: 'max',
  });
});

test('synchronized session routes preserve profile selectors', () => {
  const encoded = encodeCloudAgentRuntimeRouteChange({
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai',
    authChoice: 'profile:local-device',
  });
  assert.equal(cloudAgentRuntimeRouteChangeFromBody(encoded)?.authChoice, 'profile:local-device');
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
  for (let replay = 0; replay < 100; replay += 1) {
    assert.equal(
      applySynchronizedCloudAgentRuntimeRoutes(next, 'acct_me', structuredClone(canonicalMessages), structuredClone(cloudMessages)),
      next,
      'equivalent recovery snapshots must not schedule another React update',
    );
  }
  const updatedMessages = [...cloudMessages, routeMessage('cloud-new-model', 'acct_me', 13, {
    model: 'openai/gpt-6-astra', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: 'high',
  })];
  const changed = applySynchronizedCloudAgentRuntimeRoutes(next, 'acct_me', canonicalMessages, updatedMessages);
  assert.notEqual(changed, next);
  assert.equal(changed[runtimeSessionId].model, 'openai/gpt-6-astra');
  assert.equal(changed[runtimeSessionId].thinking, 'high');
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
