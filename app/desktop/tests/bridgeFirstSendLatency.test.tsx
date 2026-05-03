import test from 'node:test';
import assert from 'node:assert/strict';

import { bridgeConversationSendPlan, bridgeSessionOutreachTarget, chatSendIsBusy, localAgentRelayFailureText, localAgentRelayTerminalDeliveryState, localChatSendIsInFlightForTarget } from '../src/features/chat/messageActions/chatMessages';

test('new canonical person chat does not block optimistic send on Bridge conversation materialization', () => {
  const plan = bridgeConversationSendPlan({
    activeConvId: 'session:bridge:humans:new-chat',
    hasMaterializedBridgeConversation: false,
    existingTargetConversationId: null,
    shouldStayInCanonicalSession: true,
  });

  assert.equal(plan.targetConversationId, null);
  assert.equal(plan.shouldOpenBeforeOptimisticSend, false);
  assert.equal(plan.canAppendBridgeOptimisticMessage, false);
});

test('raw Bridge conversations still materialize before bridge-message optimistic state', () => {
  const plan = bridgeConversationSendPlan({
    activeConvId: 'session:bridge:humans:new-chat',
    hasMaterializedBridgeConversation: false,
    existingTargetConversationId: null,
    shouldStayInCanonicalSession: false,
  });

  assert.equal(plan.targetConversationId, null);
  assert.equal(plan.shouldOpenBeforeOptimisticSend, true);
  assert.equal(plan.canAppendBridgeOptimisticMessage, false);
});

test('chat send guard blocks repeated local sends while session creation is in flight', () => {
  assert.equal(chatSendIsBusy({ localSendInFlight: true }), true);
  assert.equal(chatSendIsBusy({ isDesktopChatSending: true }), true);
  assert.equal(chatSendIsBusy({ desktopLiveTurn: { completed: false } }), true);
  assert.equal(chatSendIsBusy({ desktopLiveTurn: { completed: true } }), false);
  assert.equal(chatSendIsBusy({}), false);
  assert.equal(localChatSendIsInFlightForTarget({ sessionId: null }, null), true);
  assert.equal(localChatSendIsInFlightForTarget({ sessionId: 'session-a' }, 'session-a'), true);
  assert.equal(localChatSendIsInFlightForTarget({ sessionId: 'session-a' }, 'session-b'), false);
});

test('canonical external-agent sessions send session messages to the bridge agent target', () => {
  assert.deepEqual(bridgeSessionOutreachTarget({
    hostId: 'host-1',
    nodeId: 'node-shared',
    displayName: 'Bob agent',
    ownerName: 'Bob',
    runtime: 'kordi-desktop',
    humanId: null,
    agentId: 'agent-bob',
  }), {
    targetKind: 'bridge-agent',
    targetRuntime: 'kordi-desktop',
    targetDisplayName: 'Bob agent',
    targetOwnerName: 'Bob',
    targetHumanId: null,
    targetAgentId: 'agent-bob',
  });
});

test('failed local agent bridge relay turns produce a terminal failed delivery state', () => {
  assert.equal(localAgentRelayTerminalDeliveryState({ succeeded: false, assistantText: '', error: 'Provider error' }), 'processing_failed');
  assert.equal(localAgentRelayFailureText({ error: 'Provider error' }), 'Processing failed');
});

test('empty local agent bridge relay turns produce a terminal failed delivery state', () => {
  assert.equal(localAgentRelayTerminalDeliveryState({ succeeded: true, assistantText: '   ', error: null }), 'processing_failed');
  assert.equal(localAgentRelayFailureText({ error: null }), 'Processing failed');
});

test('successful local agent bridge relay turns still respond normally', () => {
  assert.equal(localAgentRelayTerminalDeliveryState({ succeeded: true, assistantText: 'done', error: null }), 'responded');
});

test('existing Bridge conversation can still receive bridge-message optimistic state', () => {
  const plan = bridgeConversationSendPlan({
    activeConvId: 'session:bridge:humans:existing-chat',
    hasMaterializedBridgeConversation: false,
    existingTargetConversationId: 'bridge:host-1:peer-1:person',
    shouldStayInCanonicalSession: true,
  });

  assert.equal(plan.targetConversationId, 'bridge:host-1:peer-1:person');
  assert.equal(plan.shouldOpenBeforeOptimisticSend, false);
  assert.equal(plan.canAppendBridgeOptimisticMessage, true);
});
