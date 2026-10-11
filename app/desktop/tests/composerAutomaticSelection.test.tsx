import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useComposerInputActions } from '../src/features/chat/useComposerInputActions';
import type { ComposerSelectionState } from '../src/features/chat/composerController.types';
import type { CloudAgentRuntimeRouteChangeInput } from '../src/features/cloud/cloudAgentRuntime';
import type { DesktopChatState } from '../src/kordi-app/types';

const models = [
  { value: 'openai/first', label: 'first', provider: 'openai', providerLabel: 'OpenAI', thinkingLevels: ['high'] },
  { value: 'anthropic/second', label: 'second', provider: 'anthropic', providerLabel: 'Anthropic', thinkingLevels: ['high'] },
];

function desktopState(model = 'first', provider = 'openai'): DesktopChatState {
  return {
    activeSessionId: 'chat-session', sessions: [{ id: 'chat-session', messageCount: 1 }], projects: [], modelOptions: models,
    activeSession: {
      id: 'chat-session', title: 'Task', provider, providerLabel: provider, model, modelLabel: model,
      thinking: 'high', thinkingLabel: 'High', thinkingLevels: ['high'], messageCount: 1,
      messages: [{ role: 'assistant', text: 'Earlier answer', timestampMs: 1, timeLabel: '10:00' }],
    },
  } as unknown as DesktopChatState;
}

async function withHarness(
  collaboration: boolean,
  run: (harness: {
    actions: ReturnType<typeof useComposerInputActions>;
    routeInputs: CloudAgentRuntimeRouteChangeInput[];
    state: () => DesktopChatState | null;
    reset: () => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { model: string }) => {
    assert.equal(command, 'desktop_chat_update_session_config');
    const [provider, model] = args.model.split('/');
    return desktopState(model, provider);
  } } });
  const root = createRoot(document.getElementById('root')!);
  const routeInputs: CloudAgentRuntimeRouteChangeInput[] = [];
  let state: DesktopChatState | null = null;
  let setState!: React.Dispatch<React.SetStateAction<DesktopChatState | null>>;
  let setSelections!: React.Dispatch<React.SetStateAction<ComposerSelectionState>>;
  let actions!: ReturnType<typeof useComposerInputActions>;
  const initialSelections: ComposerSelectionState = {
    chat: { model: 'openai/first', thinking: 'high', mode: 'agent' },
    project: { model: 'openai/first', thinking: 'high', mode: 'agent' },
  };
  const noChange = () => {};
  const noAction = async () => {};
  function Probe() {
    const [currentState, updateState] = useState<DesktopChatState | null>(desktopState());
    const [selections, updateSelections] = useState<ComposerSelectionState>(initialSelections);
    state = currentState; setState = updateState; setSelections = updateSelections;
    actions = useComposerInputActions({
      environment: { isNativeShell: true },
      conversation: { activeConvId: 'chat-session', activeConvCanonicalSessionId: 'chat-session', activeConversationUsesCollaboration: collaboration },
      project: { activeProjectSessionId: 'project-session' }, runtime: { desktopChatState: currentState },
      draft: { composerSelections: selections, setComposerSelections: updateSelections, setComposerDrafts: noChange,
        setOpenComposerSelector: noChange, chatComposerAttachments: [], setChatComposerAttachments: noChange,
        chatModelOptions: models, preferredModelValueForProvider: () => 'anthropic/second', resolveComposerProviderId: () => 'openai' },
      authNavigation: { handleSelectAuthChoice: noAction, refreshDesktopChat: noAction },
      messageRuntime: { setDesktopChatState: updateState, setDesktopChatError: (error) => assert.equal(error, null),
        shouldAutoFollowChatRef: { current: false },
        publishCloudAgentRuntimeRouteChange: async (input) => { routeInputs.push(input); },
        resolveChatRuntimeRoute: () => null },
    });
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    await run({
      actions: new Proxy({} as ReturnType<typeof useComposerInputActions>, { get: (_target, key) => actions[key as keyof typeof actions] }),
      routeInputs,
      state: () => state,
      reset: async () => act(async () => { setState(desktopState()); setSelections(initialSelections); }),
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

const systemNotices = (state: DesktopChatState | null) => (
  state?.activeSession.messages.filter((message) => message.role === 'system') ?? []
);

test('an automatic provider switch on a native session adds no transcript notice', async () => {
  await withHarness(false, async ({ actions, state, reset }) => {
    await act(async () => { await actions.selectComposerValue('chat', 'provider', 'anthropic', undefined, { origin: 'automatic' }); });
    assert.equal(state()!.activeSession.provider, 'anthropic', 'The automatic switch still applies the provider');
    assert.deepEqual(systemNotices(state()), [], 'A change the person did not make must stay silent');

    await reset();
    await act(async () => { await actions.selectComposerValue('chat', 'provider', 'anthropic'); });
    assert.equal(systemNotices(state()).length, 1, 'A person choosing a provider still sees the notice');
    assert.match(systemNotices(state())[0].text, /anthropic\/second/);
  });
});

test('an automatic provider switch on a collaboration session publishes a synchronization-only route', async () => {
  await withHarness(true, async ({ actions, routeInputs, reset }) => {
    await act(async () => { await actions.selectComposerValue('chat', 'provider', 'anthropic', undefined, { origin: 'automatic' }); });
    assert.equal(routeInputs.length, 1);
    assert.equal(routeInputs[0].model, 'anthropic/second');
    assert.equal(routeInputs[0].synchronizationOnly, true);

    await reset();
    await act(async () => { await actions.selectComposerValue('chat', 'provider', 'anthropic'); });
    assert.equal(routeInputs.length, 2);
    assert.equal(routeInputs[1].synchronizationOnly, undefined, 'A person choosing a provider publishes a visible change');
  });
});
