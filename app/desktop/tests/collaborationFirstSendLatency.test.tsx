import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeLocalTurnShouldDelayChatSend,
  awaitRelayProgressBeforeTerminal,
  collaborationConversationSendPlan,
  collaborationSessionOutreachTarget,
  chatDraftSessionIdsToClearForSend,
  chatSendIsBusy,
  localAgentRelayFailureText,
  localAgentRelayTerminalDeliveryState,
  localChatTargetSessionIdForActiveConversation,
  localChatSendDelayReason,
  localChatSendIsInFlightForTarget,
  localChatTargetHasRunningTurn,
  initialCloudAgentSessionTitle,
  queuedDesktopChatMessageFromDraft,
  waitForCompletedDesktopTurn,
} from '../src/features/chat/messageActions/chatMessages';
import { chatComposerSubmitMode } from '../src/pages/ChatsPage';

test('new canonical person chat does not block optimistic send on Bridge conversation materialization', () => {
  const plan = collaborationConversationSendPlan({
    activeConvId: 'session:bridge:humans:new-chat',
    hasMaterializedCollaborationConversation: false,
    existingTargetConversationId: null,
    shouldStayInCanonicalSession: true,
  });

  assert.equal(plan.targetConversationId, null);
  assert.equal(plan.shouldOpenBeforeOptimisticSend, false);
  assert.equal(plan.canAppendCollaborationOptimisticMessage, false);
});

test('raw Bridge conversations still materialize before bridge-message optimistic state', () => {
  const plan = collaborationConversationSendPlan({
    activeConvId: 'session:bridge:humans:new-chat',
    hasMaterializedCollaborationConversation: false,
    existingTargetConversationId: null,
    shouldStayInCanonicalSession: false,
  });

  assert.equal(plan.targetConversationId, null);
  assert.equal(plan.shouldOpenBeforeOptimisticSend, true);
  assert.equal(plan.canAppendCollaborationOptimisticMessage, false);
});

test('local draft chats do not fall back to the previously loaded desktop session', () => {
  assert.equal(localChatTargetSessionIdForActiveConversation({
    activeConvId: 'draft:local-chat',
    activeConvCanonicalSessionId: null,
    desktopActiveSessionId: 'previous-real-session',
  }), null);
});

test('local sends from raw Bridge contacts clear both active and canonical composer drafts', () => {
  assert.deepEqual(chatDraftSessionIdsToClearForSend(
    'bridge:host-1:peer-1:person',
    'session:bridge:humans:stable-contact',
  ), [
    'bridge:host-1:peer-1:person',
    'session:bridge:humans:stable-contact',
  ]);
});

test('local agent mentions in raw Bridge contact conversations stay in the canonical contact session', () => {
  assert.equal(localChatTargetSessionIdForActiveConversation({
    activeConvId: 'bridge:host-1:peer-1:person',
    activeConvCanonicalSessionId: 'session:bridge:humans:stable-contact',
    desktopActiveSessionId: 'local-session-should-not-be-used',
  }), 'session:bridge:humans:stable-contact');
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
  const runtimeRoute = {
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai',
    authChoice: 'local-active-oauth',
    thinking: 'max',
  };
  const queued = queuedDesktopChatMessageFromDraft({
    sessionId: 'session-a',
    text: 'follow up while running',
    time: '12:34',
    attachments: [{ id: 'att-1', path: '/tmp/report.png', kind: 'image', name: 'report.png' }],
    runtimeRoute,
  });

  assert.equal(queued.sessionId, 'session-a');
  assert.equal(queued.scope, 'chat');
  assert.equal(queued.text, 'follow up while running');
  assert.equal(queued.time, '12:34');
  assert.deepEqual(queued.attachments, [{ id: 'att-1', path: '/tmp/report.png', kind: 'image', name: 'report.png' }]);
  assert.deepEqual(queued.runtimeRoute, runtimeRoute);
});

test('new agent sessions receive a stable first-message title across devices', () => {
  assert.equal(
    initialCloudAgentSessionTitle(
      'one two three four five six seven eight nine ten',
      0,
    ),
    'one two three four five six seven eight',
  );
  assert.equal(initialCloudAgentSessionTitle('', 1), 'File attachment');
  assert.equal(initialCloudAgentSessionTitle('', 3), '3 attachments');
});

test('chat composer is always in send mode regardless of running/busy state', () => {
  // The composer-side stop variant was removed (#273); the inline stop button on the
  // running message is now the only stop affordance. The composer always sends/queues
  // regardless of `isDesktopChatSending`, `activeLiveTurnIsRunning`, or `hasDraft`.
  assert.equal(chatComposerSubmitMode({ isDesktopChatSending: false, activeLiveTurnIsRunning: false, hasDraft: false }), 'send');
  assert.equal(chatComposerSubmitMode({ isDesktopChatSending: false, activeLiveTurnIsRunning: true, hasDraft: false }), 'send');
  assert.equal(chatComposerSubmitMode({ isDesktopChatSending: false, activeLiveTurnIsRunning: true, hasDraft: true }), 'send');
  assert.equal(chatComposerSubmitMode({ isDesktopChatSending: true, activeLiveTurnIsRunning: false, hasDraft: true }), 'send');
  assert.equal(chatComposerSubmitMode({
    isDesktopChatSending: true,
    activeLiveTurnIsRunning: true,
    hasDraft: false,
    canSendWhileBusy: true,
  }), 'send');
  assert.equal(chatComposerSubmitMode(), 'send');
});

test('active local turns only delay sends that need the local runtime route', () => {
  const runningTurn = { sessionId: 'session:group:team', completed: false };

  assert.equal(activeLocalTurnShouldDelayChatSend({
    activeConversationUsesCollaborationRouting: false,
    activeConvId: 'session:group:team',
    desktopLiveTurn: runningTurn,
  }), true);
  assert.equal(activeLocalTurnShouldDelayChatSend({
    activeConversationUsesCollaborationRouting: true,
    activeConvId: 'session:group:team',
    desktopLiveTurn: runningTurn,
  }), false);
});

test('canonical external-agent sessions send session messages to the bridge agent target', () => {
  assert.deepEqual(collaborationSessionOutreachTarget({
    hostId: 'host-1',
    nodeId: 'node-shared',
    displayName: 'Bob agent',
    ownerName: 'Bob',
    runtime: 'kordi-desktop',
    humanId: null,
    agentId: 'agent-bob',
  }), {
    targetKind: 'agent',
    targetRuntime: 'kordi-desktop',
    targetDisplayName: 'Bob agent',
    targetOwnerName: 'Bob',
    targetHumanId: null,
    targetAgentId: 'agent-bob',
  });
});

test('local agent relay waits for the completed turn even when UI watcher returned early', async () => {
  const states = [
    { id: 'turn-1', sessionId: 'session-1', completed: false, succeeded: false, status: 'running', assistantText: '', error: null },
    { id: 'turn-1', sessionId: 'session-1', completed: true, succeeded: true, status: 'completed', assistantText: 'done', error: null },
  ];
  const completed = await waitForCompletedDesktopTurn(
    async () => states.shift() as never,
    'turn-1',
    1,
  );

  assert.equal(completed.completed, true);
  assert.equal(completed.assistantText, 'done');
});

test('terminal local agent relay does not wait forever for progress relay', async () => {
  const startedAt = Date.now();
  await awaitRelayProgressBeforeTerminal(new Promise(() => undefined), 10);

  assert.ok(Date.now() - startedAt < 500);
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

test('user-stopped local agent bridge relay turns produce a cancelled delivery state', () => {
  assert.equal(
    localAgentRelayTerminalDeliveryState({ succeeded: false, assistantText: '', error: null, status: 'cancelled' }),
    'cancelled',
  );
  assert.equal(localAgentRelayFailureText({ error: null, status: 'cancelled' }), 'Stopped');
});

test('existing Bridge conversation can still receive bridge-message optimistic state', () => {
  const plan = collaborationConversationSendPlan({
    activeConvId: 'session:bridge:humans:existing-chat',
    hasMaterializedCollaborationConversation: false,
    existingTargetConversationId: 'bridge:host-1:peer-1:person',
    shouldStayInCanonicalSession: true,
  });

  assert.equal(plan.targetConversationId, 'bridge:host-1:peer-1:person');
  assert.equal(plan.shouldOpenBeforeOptimisticSend, false);
  assert.equal(plan.canAppendCollaborationOptimisticMessage, true);
});
