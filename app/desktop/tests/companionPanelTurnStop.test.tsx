import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act } from 'react';

import { sidePaneTurnStop, type DesktopChatTurnStopTarget } from '../src/features/chat/agentRequestStop';
import { useComposerMessageActions } from '../src/features/chat/useComposerMessageActions';
import { TurnStopButton } from '../src/kordi-app/components/transcriptTurnStopControls';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const noop = () => {};
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const selection = { mode: 'agent', model: 'fixture', thinking: 'high' };
const draft = { composerDrafts: { chat: '', project: '' }, chatComposerAttachments: [], composerSelections: { chat: selection, project: selection } };
const derived = { attachmentSummaryText: (text: string) => text, selectComposerValue: async () => {}, appendProjectDraft: noop, appendChatDraft: noop };

function runningTurn(id: string, sessionId: string): DesktopChatTurnSnapshot {
  return {
    id, sessionId, prompt: 'sleep 90', status: 'running', message: 'Running command: sleep 90',
    assistantText: '', thinkingText: '', tools: [], completed: false, succeeded: false, startedAtMs: 1,
  } as unknown as DesktopChatTurnSnapshot;
}

type Harness = {
  actions: () => ReturnType<typeof useComposerMessageActions>;
  liveTurns: () => Record<string, DesktopChatTurnSnapshot>;
  cancelCalls: string[];
  hostedStops: string[];
  refreshed: string[];
};

/** The composer actions with the main pane on `main-session` and a native turn running there. */
async function withMainPaneRunning(
  hostedStopResult: boolean,
  run: (harness: Harness) => Promise<void>,
) {
  const mainTurn = runningTurn('turn-main', 'main-session');
  const cancelCalls: string[] = [];
  const hostedStops: string[] = [];
  const refreshed: string[] = [];
  let liveTurnsBySession: Record<string, DesktopChatTurnSnapshot> = {};
  let actions!: ReturnType<typeof useComposerMessageActions>;
  await withJsdomRoot(async (mount) => {
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { turnId?: string }) => {
      if (command === 'desktop_chat_cancel_turn') {
        cancelCalls.push(args.turnId!);
        return { ...mainTurn, id: args.turnId, status: 'cancelling' };
      }
      return null;
    } } });
    function Host({ initialTurns }: { initialTurns: Record<string, DesktopChatTurnSnapshot> }) {
      const [turns, setTurns] = React.useState(initialTurns);
      liveTurnsBySession = turns;
      actions = useComposerMessageActions({
        environment: { isNativeShell: true },
        conversation: { activeConvId: 'main-session', activeConvCanonicalSessionId: 'main-session', activeConversationUsesCollaboration: false, chatConversations: [] },
        project: {},
        runtime: { desktopChatState: null, desktopLiveTurn: turns['main-session'] ?? null },
        draft,
        authNavigation: { refreshDesktopChat: async (sessionId?: string) => { refreshed.push(sessionId ?? ''); } },
        messageRuntime: {
          setDesktopChatState: noop,
          setDesktopChatError: noop,
          isDesktopChatSending: false,
          setIsDesktopChatSending: noop,
          setPendingUserChatMessage: noop,
          queuedDesktopMessagesBySession: {},
          setQueuedDesktopMessagesBySession: noop,
          setDesktopLiveTurnsBySession: setTurns,
          stopCloudSelfAgentRequest: async (sessionId: string) => { hostedStops.push(sessionId); return hostedStopResult; },
          watchDesktopLiveTurn: async () => {},
          shouldAutoFollowChatRef: { current: false },
          setActiveConvId: noop,
        },
        derived,
      } as unknown as Parameters<typeof useComposerMessageActions>[0]);
      return null;
    }
    await mount(<Host initialTurns={{ 'main-session': mainTurn, 'side-session': runningTurn('turn-side', 'side-session') }} />);
    await run({ actions: () => actions, liveTurns: () => liveTurnsBySession, cancelCalls, hostedStops, refreshed });
  });
}

test('the Ask Agent panel Stop cancels the panel session turn and leaves the main pane turn running', async () => {
  await withMainPaneRunning(false, async ({ actions, liveTurns, cancelCalls, hostedStops, refreshed }) => {
    const panelStop = sidePaneTurnStop(
      { id: 'side-session', canonicalSessionId: 'side-session' },
      liveTurns()['side-session'],
      (target) => actions().handleStopDesktopChatTurn(target),
    );
    assert.ok(panelStop);
    let stopped: unknown;
    await act(async () => { stopped = await panelStop(); });
    assert.equal(stopped, true);
    assert.deepEqual(cancelCalls, ['turn-side'], 'the panel stops its own turn, not the main pane turn');
    assert.deepEqual(hostedStops, []);
    assert.equal(liveTurns()['side-session'], undefined);
    assert.equal(liveTurns()['main-session']?.id, 'turn-main', 'the main pane turn keeps running');
    assert.deepEqual(refreshed, ['side-session']);

    // The main pane's Stop keeps acting on the main pane's turn.
    await act(async () => { stopped = await actions().handleStopDesktopChatTurn(); });
    assert.equal(stopped, true);
    assert.deepEqual(cancelCalls, ['turn-side', 'turn-main']);
  });
});

test('the panel Stop with no local turn stops the panel session hosted request', async () => {
  await withMainPaneRunning(true, async ({ actions, liveTurns, cancelCalls, hostedStops }) => {
    const panelStop = sidePaneTurnStop(
      { id: 'side-session', canonicalSessionId: 'side-session' },
      null,
      (target) => actions().handleStopDesktopChatTurn(target),
    );
    let stopped: unknown;
    await act(async () => { stopped = await panelStop?.(); });
    assert.equal(stopped, true);
    assert.deepEqual(hostedStops, ['side-session'], 'the hosted stop names the panel session');
    assert.deepEqual(cancelCalls, []);
    assert.equal(liveTurns()['main-session']?.id, 'turn-main');
  });
});

test('the panel Stop resolves false when its session has nothing running', async () => {
  await withMainPaneRunning(false, async ({ actions, cancelCalls, hostedStops }) => {
    let stopped: unknown;
    await act(async () => {
      stopped = await actions().handleStopDesktopChatTurn({ sessionId: 'side-session', liveTurn: null });
    });
    assert.equal(stopped, false);
    assert.deepEqual(hostedStops, ['side-session']);
    assert.deepEqual(cancelCalls, [], 'nothing to stop never cancels the main pane turn');
  });
});

test('side pane stop passes the pane session and live turn; agent subsessions have none', () => {
  const calls: DesktopChatTurnStopTarget[] = [];
  const onStop = (target?: DesktopChatTurnStopTarget) => { if (target) calls.push(target); return Promise.resolve(true); };
  const turn = runningTurn('turn-side', 'side-session');
  void sidePaneTurnStop({ id: 'local-id', canonicalSessionId: 'canonical-id' }, turn, onStop)?.();
  void sidePaneTurnStop({ id: 'local-id', canonicalSessionId: null }, null, onStop)?.();
  assert.deepEqual(calls, [{ sessionId: 'canonical-id', liveTurn: turn }, { sessionId: 'local-id', liveTurn: null }]);
  assert.equal(sidePaneTurnStop({ id: 'sub', agentSubsessionId: 'sub' }, turn, onStop), undefined);
});

test('the reply header Stop offers Stop again when the handler stopped nothing', async () => {
  await withJsdomRoot(async (mount) => {
    const results = [false, true];
    let stops = 0;
    const host = await mount(<TurnStopButton onStop={() => { stops += 1; return Promise.resolve(results.shift()); }} />);
    const button = () => host.querySelector<HTMLButtonElement>('button');
    await act(async () => { button()!.click(); });
    await settle();
    assert.equal(stops, 1);
    assert.equal(button()!.disabled, false, 'nothing to stop must not leave the control stopping');
    assert.equal(button()!.getAttribute('aria-label'), 'Stop agent request');

    await act(async () => { button()!.click(); });
    await settle();
    assert.equal(stops, 2);
    assert.equal(button()!.disabled, true, 'a stop that took effect waits for the terminal state');
    assert.equal(button()!.getAttribute('aria-label'), 'Stopping agent request');
  });
});
