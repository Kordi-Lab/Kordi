import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudDesktopCollaborationState, cloudMessageToCollaborationMessage } from '../src/features/cloud/cloudCollaborationState';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { cloudAgentFailedTurnSnapshot } from '../src/features/cloud/useCloudCollaborationState';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

const peer = cloudContactToContact({
  accountId: 'acct_peer',
  displayName: 'Peer Person',
  avatarUrl: null,
  nodeId: 'node_peer',
  createdAt: '2026-05-11T00:00:00Z',
});

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

test('cloud cloud-agent mention requests and responses use bridge agent directions', () => {
  const request = cloudMessageToCollaborationMessage(account, {
    ...message,
    messageId: 'msg_request',
    body: '@MeCloudKordi who are you?',
  });
  const response = cloudMessageToCollaborationMessage(account, {
    ...message,
    messageId: 'msg_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: 'msg_request', text: 'I am Kordi.' }),
    direction: 'outgoing',
  });

  assert.equal(request.direction, 'inbound');
  assert.equal(request.requestId, 'msg_request');
  assert.equal(response.direction, 'outbound-response');
  assert.equal(response.sender, null);
  assert.equal(response.requestId, 'msg_request');
  assert.equal(response.text, 'I am Kordi.');
});

test('cloud direct local-agent completed turn replaces processing while Cloud response sync catches up', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_direct_local_agent_request_done_locally',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi can you check the issue?',
    direction: 'incoming',
    createdAt: new Date().toISOString(),
  };
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn_direct_local_done',
    sessionId: 'cloud-agent:acct_me:acct_peer',
    prompt: 'can you check the issue?',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'I checked it and found the issue.',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
  };
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
    localAgentTurnsByRequestId: { [request.messageId]: completedTurn },
  });

  assert.equal(state.conversations[0].awaitingReply, false);
  const view = mapCollaborationConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'owned-agent');
  assert.notEqual(agentMessage?.turn?.status, 'processing');
  assert.equal(agentMessage?.turn?.completed, true);
  assert.equal(agentMessage?.turn?.assistantText, 'I checked it and found the issue.');
  assert.equal(view.messages.some((candidate) => candidate.turn?.status === 'processing'), false);
});

test('cloud direct local-agent provider failure replaces processing immediately with an actionable failure', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_direct_local_agent_no_provider',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi can you answer?',
    direction: 'incoming',
    createdAt: '2026-07-22T11:06:04.000Z',
  };
  const failedTurn = cloudAgentFailedTurnSnapshot({
    requestId: request.messageId,
    sessionId: 'cloud-agent:acct_me:acct_peer',
    prompt: 'can you answer?',
    error: new Error('No OpenAI credentials are available. Add OPENAI_API_KEY or sign in with ChatGPT account access.'),
    now: Date.parse('2026-07-22T11:06:04.050Z'),
  });
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
    localAgentTurnsByRequestId: { [request.messageId]: failedTurn },
  });

  assert.equal(state.conversations[0].awaitingReply, false);
  const view = mapCollaborationConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'owned-agent');
  assert.equal(agentMessage?.turn?.status, 'failed');
  assert.equal(agentMessage?.turn?.completed, true);
  assert.equal(agentMessage?.turn?.error, 'No provider configured yet.');
  assert.equal(view.messages.some((candidate) => candidate.turn?.status === 'processing'), false);
});

test('cloud direct local-agent execution does not wait for remote response guards or rerun after publish failure', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudDirectAgentExecution.ts', import.meta.url), 'utf8');
  const effectStart = source.indexOf('for (const [peerId, messages] of cloudMessageIndex.byPeerId)');
  const effectEnd = source.indexOf('\n  }, [', effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart, 'expected direct Cloud agent effect');
  const effect = source.slice(effectStart, effectEnd);
  const startTurnIndex = effect.indexOf('const startedTurn = await startDesktopChatMessage');
  const awaitGuardIndex = effect.indexOf('await Promise.all([', startTurnIndex);
  const finalGuardIndex = effect.indexOf('cloudAgentResponsePublicationIsBlocked({', awaitGuardIndex);
  const activityPublishIndex = effect.indexOf('await publishDerivedCloudSessionActivity', startTurnIndex);

  assert.ok(startTurnIndex >= 0, 'expected local agent execution');
  assert.ok(awaitGuardIndex > startTurnIndex, 'remote guards must only block response publication');
  assert.ok(finalGuardIndex > awaitGuardIndex, 'expected a fresh response guard after local execution');
  assert.ok(activityPublishIndex > finalGuardIndex, 'ownership must be checked before publishing derived activity');
  assert.match(effect, /const responseGuardPromise = cloudAgentResponsePublicationIsBlocked\(/);
  assert.match(effect, /const \[initialResponseBlocked, finalResponseBlocked\]\s*=\s*await Promise\.all\(/);
  assert.doesNotMatch(effect.slice(0, startTurnIndex), /await client\.listMessages|await cloudFallbackRunAlreadyOwnsRequest/);
  assert.doesNotMatch(effect, /processedCloudAgentMentionIdsRef\.current\.delete\(message\.messageId\)/);
  assert.match(effect, /response publish failed/);
});

test('cloud direct local-agent completed fallback timestamp is stable across renders', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_direct_local_agent_stable_timestamp',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi can you check the issue?',
    direction: 'incoming',
    createdAt: '1970-01-01T00:00:00.100Z',
  };
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn_direct_local_stable_timestamp',
    sessionId: 'cloud-agent:acct_me:acct_peer',
    prompt: 'can you check the issue?',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'I checked it.',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
    error: null,
  };
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    const firstState = buildCloudDesktopCollaborationState({
      account,
      contacts: [peer],
      messagesByPeer: { acct_peer: [request] },
      activeConversationId: 'bridge:cloud:acct_peer:person',
      localAgentTurnsByRequestId: { [request.messageId]: completedTurn },
    });
    Date.now = () => 2_000;
    const secondState = buildCloudDesktopCollaborationState({
      account,
      contacts: [peer],
      messagesByPeer: { acct_peer: [request] },
      activeConversationId: 'bridge:cloud:acct_peer:person',
      localAgentTurnsByRequestId: { [request.messageId]: completedTurn },
    });
    const firstTimestamp = firstState.conversations[0].messages.find((candidate) => candidate.id === `cloud-agent-local-response:${request.messageId}`)?.timestampMs;
    const secondTimestamp = secondState.conversations[0].messages.find((candidate) => candidate.id === `cloud-agent-local-response:${request.messageId}`)?.timestampMs;

    assert.equal(firstTimestamp, 101);
    assert.equal(secondTimestamp, firstTimestamp);
  } finally {
    Date.now = originalNow;
  }
});

test('cloud self-agent responses keep local runtime tool details local to the owner', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_request_with_tools',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyMeCloud inspect the repo',
    direction: 'outgoing',
  };
  const response: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_response_with_tools',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'I inspected it.' }),
    direction: 'outgoing',
  };
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, response] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
    localAgentTurnsByRequestId: {
      [request.messageId]: {
        id: 'turn_1',
        sessionId: 'cloud-agent:acct_me:acct_peer',
        prompt: 'inspect the repo',
        status: 'complete',
        message: 'Complete',
        assistantText: 'I inspected it.',
        thinkingText: 'Looking through files.',
        tools: [{ id: 'tool_1', name: 'read', status: 'completed', arguments: '{}', detail: 'Read package.json', resultText: '', liveOutput: '', isError: false }],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
  });

  const bridgeResponse = state.conversations[0].messages.find((candidate) => candidate.id === response.messageId);
  assert.equal(bridgeResponse?.sender, null);
  assert.equal(bridgeResponse?.localTurn?.tools[0]?.name, 'read');

  const view = mapCollaborationConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'owned-agent');
  assert.equal(agentMessage?.sender, 'My Kordi');
  assert.equal(agentMessage?.turn?.tools[0]?.name, 'read');
});

test('cloud first-person self-agent requests hide accidental duplicate peer responses', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_first_person_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyKordi what is agentic?',
    direction: 'outgoing',
  };
  const validResponse: CloudMessage = {
    ...message,
    messageId: 'msg_valid_self_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Agentic means acting autonomously.' }),
    direction: 'outgoing',
  };
  const invalidDuplicateResponse: CloudMessage = {
    ...message,
    messageId: 'msg_invalid_peer_response',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Duplicate response.' }),
    direction: 'incoming',
  };
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, validResponse, invalidDuplicateResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const responses = state.conversations[0].messages.filter((candidate) => candidate.requestId === request.messageId && candidate.id !== request.messageId);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, validResponse.messageId);
});
