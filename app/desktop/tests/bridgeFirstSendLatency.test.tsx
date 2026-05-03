import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeLocalTurnShouldDelayChatSend,
  bridgeConversationSendPlan,
  bridgeSessionOutreachTarget,
  chatSendIsBusy,
  localAgentRelayFailureText,
  localAgentRelayTerminalDeliveryState,
  localChatSendDelayReason,
  localChatSendIsInFlightForTarget,
  localChatTargetHasRunningTurn,
  queuedDesktopChatMessageFromDraft,
} from '../src/features/chat/messageActions/chatMessages';
import { chatComposerSubmitMode } from '../src/pages/ChatsPage';

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

test('chat send guard only blocks transient sends and same-session local turns', () => {
  assert.equal(chatSendIsBusy({ localSendInFlight: true }), true);
  assert.equal(chatSendIsBusy({ isDesktopChatSending: true }), true);
  assert.equal(chatSendIsBusy({ desktopLiveTurn: { completed: false } }), false);
  assert.equal(chatSendIsBusy({ desktopLiveTurn: { completed: true } }), false);
  assert.equal(chatSendIsBusy({}), false);
  assert.equal(localChatSendIsInFlightForTarget({ sessionId: null }, null), true);
  assert.equal(localChatSendIsInFlightForTarget({ sessionId: 'session-a' }, null), false);
  assert.equal(localChatSendIsInFlightForTarget({ sessionId: 'session-a' }, 'session-a'), true);
  assert.equal(localChatSendIsInFlightForTarget({ sessionId: 'session-a' }, 'session-b'), false);
  assert.equal(localChatTargetHasRunningTurn({ sessionId: 'session-a', completed: false }, 'session-a'), true);
  assert.equal(localChatTargetHasRunningTurn({ sessionId: 'session-a', completed: false }, 'session-b'), false);
  assert.equal(localChatSendDelayReason({ inFlight: { sessionId: 'session-a' }, targetSessionId: null }), null);
  assert.equal(localChatSendDelayReason({ inFlight: { sessionId: 'session-a' }, targetSessionId: 'session-a' }), 'same-session-running');
  assert.equal(localChatSendDelayReason({ inFlight: { sessionId: null }, targetSessionId: null }), 'session-starting');
  assert.equal(localChatSendDelayReason({ inFlight: null, targetSessionId: 'session-a', desktopLiveTurn: { sessionId: 'session-a', completed: false } }), 'same-session-running');
});

test('queued local chat messages preserve draft text and attachments', () => {
  const queued = queuedDesktopChatMessageFromDraft({
    sessionId: 'session-a',
    text: 'follow up while running',
    time: '12:34',
    attachments: [{ id: 'att-1', path: '/tmp/report.png', kind: 'image', name: 'report.png' }],
  });

  assert.equal(queued.sessionId, 'session-a');
  assert.equal(queued.scope, 'chat');
  assert.equal(queued.text, 'follow up while running');
  assert.equal(queued.time, '12:34');
  assert.deepEqual(queued.attachments, [{ id: 'att-1', path: '/tmp/report.png', kind: 'image', name: 'report.png' }]);
});

test('chat composer sends drafts instead of showing stop while a local turn is running', () => {
  assert.equal(chatComposerSubmitMode({ isDesktopChatSending: false, activeLiveTurnIsRunning: true, hasDraft: false }), 'stop');
  assert.equal(chatComposerSubmitMode({ isDesktopChatSending: false, activeLiveTurnIsRunning: true, hasDraft: true }), 'send');
  assert.equal(chatComposerSubmitMode({ isDesktopChatSending: true, activeLiveTurnIsRunning: false, hasDraft: true }), 'send');
});

test('chat composer stays in send mode for bridge-routed sessions while an agent is streaming', () => {
  assert.equal(chatComposerSubmitMode({
    isDesktopChatSending: true,
    activeLiveTurnIsRunning: true,
    hasDraft: false,
    canSendWhileBusy: true,
  }), 'send');
});

test('active local turns only delay sends that need the local runtime route', () => {
  const runningTurn = { sessionId: 'session:group:team', completed: false };

  assert.equal(activeLocalTurnShouldDelayChatSend({
    activeConversationUsesBridgeRouting: false,
    activeConvId: 'session:group:team',
    desktopLiveTurn: runningTurn,
  }), true);
  assert.equal(activeLocalTurnShouldDelayChatSend({
    activeConversationUsesBridgeRouting: true,
    activeConvId: 'session:group:team',
    desktopLiveTurn: runningTurn,
  }), false);
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
