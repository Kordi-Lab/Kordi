import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  CLOUD_AGENT_RECONNECT_ACCOUNT_NOTICE,
  cloudAgentCouldNotAnswerText,
  cloudAgentProviderFailureNeedsAuthentication,
  cloudAgentProviderFailureNotice,
  encodeCloudAgentCancel,
  encodeCloudAgentResponse,
  isCloudAgentHostedCredentialUnavailableError,
} from '../src/features/cloud/cloudAgentMessages';
import { ownerRequestRoute } from '../src/features/cloud/cloudAgentTargetRuntimeRoute';
import { buildCloudCollaborationConversation } from '../src/features/cloud/cloudCollaborationState';
import { desktopTurnNeedsCloudHandBack } from '../src/features/cloud/cloudDesktopRunHandback';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import {
  cloudAgentRunStatusIsTerminal,
  cloudDirectRequestsAwaitingReply,
} from '../src/features/cloud/cloudDirectRequestReconcile';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture as avatar } from './helpers/cloudAccountAvatarFixture';

const UNAVAILABLE = 'Hosted provider credentials are unavailable for this desktop turn';

const owner: CloudAccount = {
  accountId: 'owner', displayName: 'Owner', primaryEmail: 'owner@example.test', avatarUrl: null, avatar,
  nodeId: 'owner', passwordSet: true,
  defaultAgent: { agentId: 'cloud-agent:owner', displayName: 'Helper', avatarUrl: null, avatar },
};
const peer: CloudAccount = {
  ...owner, accountId: 'peer', displayName: 'Peer', nodeId: 'peer',
  defaultAgent: { agentId: 'cloud-agent:peer', displayName: 'Peer Helper', avatarUrl: null, avatar },
};

function turn(overrides: Partial<DesktopChatTurnSnapshot>): DesktopChatTurnSnapshot {
  return {
    id: 'turn', sessionId: 'session', prompt: 'hi', status: 'failed', message: UNAVAILABLE,
    assistantText: '', thinkingText: '', tools: [], completed: true, succeeded: false, error: UNAVAILABLE,
    ...overrides,
  };
}

function wire(id: string, from: CloudAccount, sequence: number, body: string, createdAtMs: number, version = 1): CloudMessage {
  return {
    messageId: id, fromAccountId: from.accountId, toAccountId: from === owner ? peer.accountId : owner.accountId,
    createdAt: new Date(createdAtMs).toISOString(), deliveredAt: null, readAt: null,
    direction: from === peer ? 'outgoing' : 'incoming', sessionId: 'session:direct-person:owner:peer',
    conversationId: 'conversation', conversationSequence: sequence, version, body,
  };
}

function peerRequest(id: string, sequence: number, createdAtMs: number): CloudMessage {
  return wire(id, peer, sequence, encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: '@Helper hi',
    targetCloudAgentId: 'cloud-agent:owner', targetCloudAgentName: 'Helper',
    targetCloudAgentOwnerAccountId: owner.accountId, targetCloudAgentOwnerName: owner.displayName,
  }), createdAtMs);
}

function failedReply(id: string, requestId: string, sequence: number, createdAtMs: number): CloudMessage {
  return wire(id, owner, sequence, encodeCloudAgentResponse({
    requestId, text: cloudAgentCouldNotAnswerText('Helper'), deliveryState: 'failed',
  }), createdAtMs, 2);
}

test('a Mac turn that could not load the hosted account is handed back to the cloud', () => {
  assert.equal(desktopTurnNeedsCloudHandBack(turn({})), true);
  assert.equal(desktopTurnNeedsCloudHandBack(turn({ error: null, message: 'Hosted provider route is unavailable' })), true);
  // Output already reached the conversation, so the run stays with this Mac.
  assert.equal(desktopTurnNeedsCloudHandBack(turn({ assistantText: 'Partial answer' })), false);
  assert.equal(desktopTurnNeedsCloudHandBack(turn({
    tools: [{ id: 'tool', name: 'read', status: 'completed' } as DesktopChatTurnSnapshot['tools'][number]],
  })), false);
  assert.equal(desktopTurnNeedsCloudHandBack(turn({ error: 'The provider failed', message: 'The provider failed' })), false);
  assert.equal(desktopTurnNeedsCloudHandBack(turn({ status: 'cancelled' })), false);
});

test('the owner sees a reconnect notice with the account action; members see a neutral line', () => {
  assert.equal(isCloudAgentHostedCredentialUnavailableError(UNAVAILABLE), true);
  assert.equal(cloudAgentProviderFailureNotice(UNAVAILABLE), CLOUD_AGENT_RECONNECT_ACCOUNT_NOTICE);
  assert.equal(cloudAgentProviderFailureNeedsAuthentication(UNAVAILABLE), true);
  assert.equal(cloudAgentProviderFailureNeedsAuthentication(CLOUD_AGENT_RECONNECT_ACCOUNT_NOTICE), true);
  assert.equal(cloudAgentCouldNotAnswerText('Helper'), "Helper couldn't answer.");
  assert.equal(cloudAgentCouldNotAnswerText('  '), "The agent couldn't answer.");
  assert.equal(isCloudAgentHostedCredentialUnavailableError(cloudAgentCouldNotAnswerText('Helper')), false);
});

test("another person's requested route never selects the owner's account", () => {
  const route = { model: 'openai-codex/gpt-test', authProvider: 'openai-codex', authChoice: 'cloud-login:peer-choice' };
  assert.deepEqual(ownerRequestRoute(route, 'owner', 'owner'), route);
  assert.equal(ownerRequestRoute(route, 'peer', 'owner'), null);
  assert.equal(ownerRequestRoute(route, '', 'owner'), null);
  assert.equal(ownerRequestRoute(null, 'owner', 'owner'), null);
});

test('direct and group Mac runs hand back before publishing a failure and ignore a peer route', () => {
  for (const file of ['useCloudDirectAgentExecution.ts', 'cloudGroupAgentExecution.ts']) {
    const source = readFileSync(new URL(`../src/features/cloud/${file}`, import.meta.url), 'utf8');
    const handBack = source.indexOf('desktopTurnNeedsCloudHandBack(finalTurn)');
    const publish = source.indexOf('cloudAgentCouldNotAnswerText(');
    assert.ok(handBack > 0, `${file} hands a hosted-credential failure back`);
    assert.ok(publish > handBack, `${file} publishes a neutral failure only after the hand-back`);
    assert.match(source, /requestRoute: ownerRequestRoute\(/);
  }
});

test('the requester sees each failed Mac run as its own terminal row in request order', () => {
  const base = Date.now() - 60_000;
  const messages = [
    peerRequest('request-1', 112, base), peerRequest('request-2', 113, base + 1_000),
    failedReply('reply-1', 'request-1', 114, base + 2_000), failedReply('reply-2', 'request-2', 115, base + 3_000),
  ];
  for (const viewer of [peer, owner]) {
    const projected = buildCloudCollaborationConversation({
      account: viewer,
      contact: cloudContactToContact({ ...(viewer === owner ? peer : owner), createdAt: new Date().toISOString() }),
      messages, runtime: 'person',
    });
    const view = mapCollaborationConversationToViewModel(projected, undefined, 'Helper');
    assert.equal(view.messages.filter((message) => message.turn && !message.turn.completed).length, 0,
      `viewer=${viewer.accountId}`);
    const failed = view.messages.filter((message) => message.turn?.status === 'failed');
    assert.deepEqual(failed.map((message) => message.id.split(':').at(-1)), ['reply-1', 'reply-2']);
  }
});

test('a request with no final reply here is reconciled against its run', () => {
  const nowMs = Date.now();
  const old = peerRequest('old', 1, nowMs - 60_000);
  const young = peerRequest('young', 2, nowMs - 1_000);
  const answered = peerRequest('answered', 3, nowMs - 60_000);
  const cancelled = peerRequest('cancelled', 4, nowMs - 60_000);
  const stale = peerRequest('stale', 5, nowMs - 30 * 60_000);
  const processing = wire('processing', owner, 6, encodeCloudAgentResponse({
    requestId: 'old', text: '', deliveryState: 'processing',
  }), nowMs - 59_000);
  const index = buildCloudMessageIndex(peer.accountId, { owner: [
    old, young, answered, cancelled, stale, processing,
    failedReply('answer', 'answered', 7, nowMs - 50_000),
    wire('cancel', peer, 8, encodeCloudAgentCancel({ requestId: 'cancelled' }), nowMs - 50_000),
  ] });
  const awaiting = cloudDirectRequestsAwaitingReply({
    account: peer, messageIndex: index, nowMs, minAgeMs: 20_000, windowMs: 10 * 60_000,
  });
  assert.deepEqual(awaiting, [{ requestMessageId: 'old', ownerAccountId: owner.accountId }]);
  // The owner never reconciles requests aimed at their own agent this way.
  assert.deepEqual(cloudDirectRequestsAwaitingReply({
    account: owner, messageIndex: buildCloudMessageIndex(owner.accountId, { peer: [old] }),
    nowMs, minAgeMs: 20_000, windowMs: 10 * 60_000,
  }), []);
  assert.equal(cloudAgentRunStatusIsTerminal('failed'), true);
  assert.equal(cloudAgentRunStatusIsTerminal('completed'), true);
  assert.equal(cloudAgentRunStatusIsTerminal('cancelled'), true);
  assert.equal(cloudAgentRunStatusIsTerminal('running'), false);
  assert.equal(cloudAgentRunStatusIsTerminal(null), false);
});
