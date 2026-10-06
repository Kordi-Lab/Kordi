import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { activeChatLiveTurnForConversation } from '../src/app/useKordiDesktopActivity';
import { useComposerMessageActions } from '../src/features/chat/useComposerMessageActions';
import { useDesktopChatState } from '../src/features/chat/useDesktopChatState';
import type { DesktopChatState, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

function installDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const replacements = { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  return { root, dom, async cleanup() {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  } };
}

const mapMessages = (_sessionId: string, messages: unknown) => messages as Message[];
const noop = () => {};
const selection = { mode: 'agent', model: 'fixture', thinking: 'high' };
const draft = { composerDrafts: { chat: '', project: '' }, chatComposerAttachments: [], composerSelections: { chat: selection, project: selection } };
const derived = { attachmentSummaryText: (text: string) => text, selectComposerValue: async () => {}, appendProjectDraft: noop, appendChatDraft: noop };
const sideConversation = { id: 'side-session', canonicalSessionId: 'side-session' };
const conversation = { activeConvId: sideConversation.id, activeConvCanonicalSessionId: sideConversation.id, activeConversationUsesCollaboration: false, chatConversations: [] };
const queuedMessages = {};
const followRef = { current: false };

test('a running turn in a side session absent from the session list stays stoppable from the main pane', async () => {
  const { root, dom, cleanup } = installDom();
  // A new private side session is blank until its first turn persists, so
  // the native session list omits it while the main selection stays put.
  const desktopState = (activeSessionId: string) => ({
    activeSessionId,
    activeSession: { id: activeSessionId, title: activeSessionId, messageCount: 0, messages: [] },
    sessions: [{ id: 'main-session', title: 'Main', messageCount: 1 }],
    projects: [],
  }) as unknown as DesktopChatState;
  const runningTurn = {
    id: 'turn-sleep', sessionId: 'side-session', prompt: 'sleep 90', status: 'running', message: 'Running command: sleep 90',
    assistantText: '', thinkingText: '', tools: [{ id: 'bash-1', name: 'bash', status: 'running' }],
    completed: false, succeeded: false, startedAtMs: 1,
  } as unknown as DesktopChatTurnSnapshot;
  let cancelled = false;
  const cancelCalls: string[] = [];
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { activeSessionId?: string; turnId?: string }) => {
    if (command === 'desktop_chat_state') return desktopState(args.activeSessionId ?? 'main-session');
    if (command === 'desktop_chat_turn_state') {
      return cancelled ? { ...runningTurn, status: 'cancelled', completed: true, completedAtMs: 2 } : runningTurn;
    }
    if (command === 'desktop_chat_cancel_turn') {
      cancelCalls.push(args.turnId!);
      cancelled = true;
      return { ...runningTurn, status: 'cancelling' };
    }
    if (command === 'desktop_chat_active_turns' || command === 'desktop_chat_subsession_ids') return [];
    return null;
  } } });

  let runtime!: ReturnType<typeof useDesktopChatState>;
  let liveTurn: DesktopChatTurnSnapshot | null = null;
  let actions!: ReturnType<typeof useComposerMessageActions>;
  function Harness() {
    runtime = useDesktopChatState({ isNativeShell: true, mapDesktopMessages: mapMessages });
    liveTurn = activeChatLiveTurnForConversation({ activeConv: sideConversation, desktopLiveTurnsBySession: runtime.desktopLiveTurnsBySession });
    actions = useComposerMessageActions({
      environment: { isNativeShell: true },
      conversation,
      project: {},
      runtime: { desktopChatState: runtime.desktopChatState, desktopLiveTurn: liveTurn },
      draft,
      authNavigation: { refreshDesktopChat: runtime.refreshDesktopChat },
      messageRuntime: {
        setDesktopChatState: runtime.setDesktopChatState,
        setDesktopChatError: runtime.setDesktopChatError,
        isDesktopChatSending: false,
        setIsDesktopChatSending: runtime.setIsDesktopChatSending,
        setPendingUserChatMessage: runtime.setPendingUserChatMessage,
        queuedDesktopMessagesBySession: queuedMessages,
        setQueuedDesktopMessagesBySession: noop,
        setDesktopLiveTurnsBySession: runtime.setDesktopLiveTurnsBySession,
        watchDesktopLiveTurn: runtime.watchDesktopLiveTurn,
        shouldAutoFollowChatRef: followRef,
        setActiveConvId: noop,
      },
      derived,
    } as unknown as Parameters<typeof useComposerMessageActions>[0]);
    return null;
  }

  let watcher!: Promise<void>;
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(runtime.desktopChatState?.activeSessionId, 'main-session');

    await act(async () => { watcher = runtime.watchDesktopLiveTurn(runningTurn); });
    assert.equal(liveTurn?.id, 'turn-sleep', 'The started turn is visible to the main pane');

    // Any later desktop refresh (for example a side-panel prefetch) still
    // omits the running side session and must not drop its live turn.
    await act(async () => { await runtime.refreshDesktopChat(); });
    assert.equal(runtime.desktopChatState?.activeSessionId, 'main-session', 'The side turn must not take over the main selection');
    assert.equal(liveTurn?.id, 'turn-sleep', 'The running turn stays known while the native session is unlisted');

    await act(async () => { await actions.handleStopDesktopChatTurn(); });
    assert.deepEqual(cancelCalls, ['turn-sleep']);
    await act(async () => { await watcher; });
  } finally {
    cancelled = true;
    await cleanup();
  }
});
