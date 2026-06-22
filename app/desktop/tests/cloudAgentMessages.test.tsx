import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount } from '../src/features/cloud/authClient';
import {
  CLOUD_AGENT_RUNTIME_SESSION_PREFIX,
  cloudAgentFallbackErrorNotice,
  cloudAgentFallbackStatusLabel,
  cloudAgentNativeContextMessagesFromDirectCloudSession,
  cloudMessageIsSelfAgentRequest,
  cloudMessageMentionsFirstPersonAgent,
  cloudMessageMentionsLocalAgent,
  cloudMessageMentionsNamedAgent,
  encodeCloudAgentCancel,
  encodeCloudAgentResponse,
  isCloudAgentNoProviderConfiguredError,
  isCloudAgentControlMessage,
  isCloudAgentRuntimeSessionId,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
  promptTextForCloudAgentMention,
} from '../src/features/cloud/cloudAgentMessages';
import {
  cloudAgentRuntimeRouteForSession,
  cloudAgentRuntimeRouteForTargetCloudAgent,
  cloudAgentRuntimeSessionId,
} from '../src/features/cloud/cloudAgentRuntime';
import { buildCloudBridgeHost, cloudMessageToBridgeMessage } from '../src/features/cloud/cloudBridgeState';
import type { CloudMessage } from '../src/features/cloud/authClient';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Shuyheres',
  primaryEmail: 'shu@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

test('cloud fallback status labels stay visually close to normal online turns', () => {
  assert.equal(cloudAgentFallbackStatusLabel('queued'), 'Requesting…');
  assert.equal(cloudAgentFallbackStatusLabel('leased'), 'Requesting…');
  assert.equal(cloudAgentFallbackStatusLabel('running'), 'Replying…');
  assert.equal(cloudAgentFallbackStatusLabel('completed'), null);
});

test('cloud fallback errors map backend codes to concise user-facing copy', () => {
  assert.equal(
    cloudAgentFallbackErrorNotice({ code: 'missing_provider_auth' }),
    'Provider auth is not synced for Cloud fallback yet. Open this device once to sync provider access.',
  );
  assert.equal(
    cloudAgentFallbackErrorNotice({ code: 'owner_online' }),
    'The owner device is online, so Kordi will answer from the device.',
  );
  assert.equal(
    cloudAgentFallbackErrorNotice({ code: 'model_provider_error' }),
    'The provider failed while Kordi was replying. Try again in a moment.',
  );
  assert.equal(
    cloudAgentFallbackErrorNotice({ message: 'Cloud fallback cannot access localhost or private-network resources from the owner environment.' }),
    "Kordi Cloud can't access that local/private resource while the device is offline.",
  );
});

test('cloud agent no-provider detector recognizes Cloud fallback provider-auth failures', () => {
  assert.equal(isCloudAgentNoProviderConfiguredError('missing_provider_auth'), true);
  assert.equal(isCloudAgentNoProviderConfiguredError('Cloud fallback cannot run because the owner has not enabled a provider-auth snapshot.'), true);
});

test('cloud agent runtime session ids are isolated from visible local chat sessions', () => {
  assert.equal(isCloudAgentRuntimeSessionId(`${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}acct_me:acct_peer`), true);
  assert.equal(isCloudAgentRuntimeSessionId('session-local'), false);
});

test('cloud agent runtime ids map current cloud conversations to local runtime sessions', () => {
  assert.equal(
    cloudAgentRuntimeSessionId('acct_me', 'bridge:cloud:acct_peer:person'),
    `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}acct_me:acct_peer`,
  );
  assert.equal(
    cloudAgentRuntimeSessionId('acct_me', 'session:bridge:bridge:cloud:acct_peer:person'),
    `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}acct_me:acct_peer`,
  );
  assert.equal(
    cloudAgentRuntimeSessionId('acct_me', 'session:direct-person:acct_me:acct_peer'),
    `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}acct_me:acct_peer`,
  );
  assert.equal(
    cloudAgentRuntimeSessionId('acct_me', 'session:group:cloud-room'),
    `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}acct_me:session:group:cloud-room`,
  );
});

test('cloud agent runtime route is reflected on the synthetic local cloud agent only for this session', () => {
  const runtimeSessionId = cloudAgentRuntimeSessionId('acct_me', 'session:group:cloud-room');
  const route = cloudAgentRuntimeRouteForSession({
    [runtimeSessionId ?? '']: {
      model: 'anthropic/claude-opus-4-7',
      authProvider: 'anthropic',
      authChoice: 'work',
      thinking: 'high',
    },
  }, runtimeSessionId);
  const host = buildCloudBridgeHost(account, [], route);
  const agent = host.agents[0];

  assert.equal(agent?.defaultModel, 'anthropic/claude-opus-4-7');
  assert.equal(agent?.defaultAuthProvider, 'anthropic');
  assert.equal(agent?.defaultAuthChoice, 'work');
  assert.equal(agent?.thinking, 'high');
  assert.equal(buildCloudBridgeHost(account, []).agents[0]?.defaultModel, null);
});

test('group hosted Cloud Agent runtime route prefers the targeted agent definition route', () => {
  const route = cloudAgentRuntimeRouteForTargetCloudAgent({
    targetCloudAgentId: 'cloud_agent_project_driver',
    cloudAgentDefinitionsById: {
      cloud_agent_project_driver: {
        agentId: 'cloud_agent_project_driver',
        ownerAccountId: 'acct_me',
        accessScope: 'participant_conversations',
        status: 'active',
        name: 'Kordi Project Driver',
        role: 'Project driver',
        description: null,
        systemPrompt: 'Drive projects.',
        sourceSummary: null,
        boundaries: [],
        resources: [],
        skills: [],
        modelRouting: {
          defaultModel: 'openai/gpt-5.1',
          defaultAuthProvider: 'openai',
          defaultAuthChoice: 'main',
          thinking: 'medium',
        },
        createdAt: '2026-06-22T12:00:00Z',
        updatedAt: '2026-06-22T12:00:00Z',
        archivedAt: null,
      },
    },
    routesByRuntimeSessionId: {
      'cloud-agent:acct_me:session:group:cloud-room': {
        model: 'anthropic/claude-opus-4-7',
        authProvider: 'anthropic',
        authChoice: 'fallback',
      },
    },
    runtimeSessionId: 'cloud-agent:acct_me:session:group:cloud-room',
    fallbackRoute: null,
  });

  assert.deepEqual(route, {
    model: 'openai/gpt-5.1',
    authProvider: 'openai',
    authChoice: 'main',
    thinking: 'medium',
  });
});

test('cloud agent mention matching recognizes local Kordi labels', () => {
  assert.equal(cloudMessageMentionsLocalAgent('@Shuyheres who are you?', account), false);
  assert.equal(cloudMessageMentionsLocalAgent('@ShuyheresKordi who are you?', account), true);
  assert.equal(cloudMessageMentionsLocalAgent('@ShuyheressKordi who are you?', account), true);
  assert.equal(cloudMessageMentionsLocalAgent('@MyShuyheres who are you?', account), false);
  assert.equal(cloudMessageMentionsLocalAgent('@MyShuyheresKordi who are you?', account), true);
  assert.equal(cloudMessageMentionsLocalAgent('@Kordi who are you?', account), true);
  assert.equal(cloudMessageMentionsLocalAgent('@OtherKordi who are you?', account), false);
  assert.equal(cloudMessageMentionsLocalAgent('@MyKordi who are you?', account, { allowFirstPerson: false }), false);
  assert.equal(cloudMessageMentionsLocalAgent('@Kordi who are you?', account, { allowFirstPerson: false }), false);
  assert.equal(cloudMessageMentionsLocalAgent('@ShuyheresKordi who are you?', account, { allowFirstPerson: false }), true);
});

test('cloud first-person agent mentions are sender-owned, not recipient-owned', () => {
  assert.equal(cloudMessageMentionsFirstPersonAgent('@MyKordi what is agentic?'), true);
  assert.equal(cloudMessageMentionsFirstPersonAgent('@Kordi what is agentic?'), true);
  assert.equal(cloudMessageMentionsFirstPersonAgent('@ShuyheresKordi what is agentic?'), false);
});

test('cloud self-agent direct messages trigger the local agent without requiring an @ mention', () => {
  assert.equal(cloudMessageIsSelfAgentRequest({
    messageId: 'msg_self_plain',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: 'are you here',
    createdAt: '2026-05-11T10:00:00Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: 'session-self',
  }, account), true);
  assert.equal(cloudMessageIsSelfAgentRequest({
    messageId: 'msg_peer_plain',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: 'are you here',
    createdAt: '2026-05-11T10:00:00Z',
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: 'session-self',
  }, account), false);
  assert.equal(cloudMessageIsSelfAgentRequest({
    messageId: 'msg_self_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_self_plain', text: 'Yes.' }),
    createdAt: '2026-05-11T10:00:01Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: 'session-self',
  }, account), false);
});

test('cloud named agent mention matching recognizes remote Kordi labels', () => {
  assert.equal(cloudMessageMentionsNamedAgent('@PeerPerson who are you?', 'Peer Person'), false);
  assert.equal(cloudMessageMentionsNamedAgent('@PeerPersonKordi who are you?', 'Peer Person'), true);
  assert.equal(cloudMessageMentionsNamedAgent('@PeerPersonsKordi who are you?', 'Peer Person'), true);
  assert.equal(cloudMessageMentionsNamedAgent('@PeerPersonsKordi who are you?', "Peer Person's Kordi"), true);
  assert.equal(cloudMessageMentionsNamedAgent('@OtherKordi who are you?', 'Peer Person'), false);
});

test('cloud agent mention prompt strips mention token', () => {
  assert.equal(promptTextForCloudAgentMention('@ShuyheresKordi who are you?'), 'who are you?');
});

test('cloud agent response envelope round trips without exposing metadata text', () => {
  const encoded = encodeCloudAgentResponse({ requestId: 'msg_1', text: 'I am Kordi.' });
  assert.notEqual(encoded.includes('I am Kordi.'), true);
  assert.deepEqual(parseCloudAgentResponse(encoded), {
    kind: 'agent-response',
    requestId: 'msg_1',
    text: 'I am Kordi.',
  });
  assert.equal(parseCloudAgentResponse('normal text'), null);
});

test('cloud agent failed response envelope marks bridge replies failed', () => {
  const encoded = encodeCloudAgentResponse({
    requestId: 'msg_1',
    text: 'No provider configured yet.',
    deliveryState: 'failed',
  });
  const parsed = parseCloudAgentResponse(encoded);
  assert.deepEqual(parsed, {
    kind: 'agent-response',
    requestId: 'msg_1',
    text: 'No provider configured yet.',
    deliveryState: 'failed',
  });

  const mapped = cloudMessageToBridgeMessage(account, {
    messageId: 'msg_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encoded,
    createdAt: '2026-05-11T10:00:01Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
  });

  assert.equal(mapped.deliveryState, 'failed');
  assert.equal(mapped.text, 'No provider configured yet.');
});

test('cloud agent no-provider detector recognizes sidecar auth failures', () => {
  assert.equal(isCloudAgentNoProviderConfiguredError(new Error('No OpenAI credentials are available. Add OPENAI_API_KEY or sign in with ChatGPT account access.')), true);
  assert.equal(isCloudAgentNoProviderConfiguredError('No Anthropic credentials are available. Add ANTHROPIC_API_KEY.'), true);
  assert.equal(isCloudAgentNoProviderConfiguredError('LM Studio local endpoint is not reachable'), true);
  assert.equal(isCloudAgentNoProviderConfiguredError('Unknown model: openai/gpt-5.4'), true);
  assert.equal(isCloudAgentNoProviderConfiguredError(new Error('network disconnected while sending cloud message')), false);
});

test('cloud agent mentions keep the current request native and sync prior cloud messages as context entries', () => {
  const request: CloudMessage = {
    messageId: 'msg_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyKordi can you see that greeting?',
    createdAt: '2026-05-11T10:03:00Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
  };
  const contextMessages = cloudAgentNativeContextMessagesFromDirectCloudSession({
    localAccountId: 'acct_me',
    localHumanName: 'Shuyhere',
    peerHumanName: 'Shuyheretest',
    localAgentName: 'My Kordi',
    peerAgentName: "Shuyheretest's Kordi",
    requestMessage: request,
    messages: [
      {
        ...request,
        messageId: 'msg_human_peer',
        fromAccountId: 'acct_peer',
        toAccountId: 'acct_me',
        body: 'Hi! Thanks for adding me.',
        createdAt: '2026-05-11T10:01:00Z',
        direction: 'incoming',
      },
      {
        ...request,
        messageId: 'msg_agent_peer',
        fromAccountId: 'acct_peer',
        toAccountId: 'acct_me',
        body: encodeCloudAgentResponse({ requestId: 'msg_remote_request', text: 'I can help.' }),
        createdAt: '2026-05-11T10:02:00Z',
        direction: 'incoming',
      },
      request,
    ],
  });

  assert.equal(promptTextForCloudAgentMention(request.body), 'can you see that greeting?');
  assert.deepEqual(contextMessages.map(({ authorName, authorKind, text }) => ({ authorName, authorKind, text })), [
    { authorName: 'Shuyheretest', authorKind: 'human', text: 'Hi! Thanks for adding me.' },
    { authorName: "Shuyheretest's Kordi", authorKind: 'agent', text: 'I can help.' },
  ]);
});

test('cloud agent cancel envelope round trips and is treated as control metadata', () => {
  const encoded = encodeCloudAgentCancel({ requestId: 'msg_1' });
  assert.deepEqual(parseCloudAgentCancel(encoded), {
    kind: 'agent-cancel',
    requestId: 'msg_1',
  });
  assert.equal(isCloudAgentControlMessage(encoded), true);
  assert.equal(isCloudAgentControlMessage('normal text'), false);
});
