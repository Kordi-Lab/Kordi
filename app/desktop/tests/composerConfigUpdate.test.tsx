import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useComposerInputActions } from '../src/features/chat/useComposerInputActions';
import type { ComposerSelectionState } from '../src/features/chat/composerController.types';
import type { DesktopChatState } from '../src/kordi-app/types';
import type { CloudAgentRuntimeRouteChangeInput } from '../src/features/cloud/cloudAgentRuntime';
import { publishHostedProviderSnapshots } from '../src/features/cloud/hostedAccounts';
import { setLocalAccountChoices, setLocalProviderIds } from '../src/features/cloud/hostedAccountRegistry';
import type { ComposerSelection } from '../src/features/chat/composerController.types';
import type { DesktopChatMessageRoute } from '../src/lib/desktop';

const models = ['first', 'second', 'third'].map((model) => ({
  value: `openai/${model}`, label: model, provider: 'openai', providerLabel: 'OpenAI', thinkingLevels: ['high'],
}));

function desktopState(id = 'project-session', model = 'first'): DesktopChatState {
  return {
    activeSessionId: id, sessions: [{ id, messageCount: 1 }], projects: [], modelOptions: models,
    activeSession: {
      id, title: 'Project task', provider: 'openai', providerLabel: 'OpenAI', model, modelLabel: model,
      thinking: 'high', thinkingLabel: 'High', thinkingLevels: ['high'], messageCount: 1,
      messages: [{ role: 'assistant', text: 'Earlier answer', timestampMs: 1, timeLabel: '10:00' }],
    },
  } as unknown as DesktopChatState;
}

test('model config completion preserves a concurrent send, reading position, and newer selections', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const requests: Array<{ model: string; resolve: (state: DesktopChatState) => void }> = [];
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: (command: string, args: { sessionId: string; model: string }) => {
    assert.equal(command, 'desktop_chat_update_session_config');
    assert.equal(args.sessionId, 'project-session');
    return new Promise<DesktopChatState>((resolve) => requests.push({ model: args.model, resolve }));
  } } });
  const root = createRoot(document.getElementById('root')!);
  const follow = { current: false };
  let hosted = false;
  let selections!: ComposerSelectionState;
  const routeRequests: Array<{ input: CloudAgentRuntimeRouteChangeInput; resolve: () => void; reject: (error: Error) => void }> = [];
  let state!: DesktopChatState | null;
  let setState!: React.Dispatch<React.SetStateAction<DesktopChatState | null>>;
  let actions!: ReturnType<typeof useComposerInputActions>;
  const noChange = () => {};
  const noAction = async () => {};
  // The native invoke waits on a lazy Tauri module import, so let pending requests register before resolving them.
  const waitForRequests = async (pending: unknown[], count: number) => {
    await act(async () => {
      for (let attempt = 0; pending.length < count && attempt < 400; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(pending.length, count);
  };
  function Probe() {
    [state, setState] = useState<DesktopChatState | null>(desktopState());
    const [currentSelections, setSelections] = useState<ComposerSelectionState>({
      chat: { model: 'openai/first', thinking: 'high', mode: 'agent' },
      project: { model: 'openai/first', thinking: 'high', mode: 'agent' },
    });
    selections = currentSelections;
    actions = useComposerInputActions({
      environment: { isNativeShell: true },
      conversation: { activeConvId: state!.activeSessionId, activeConvCanonicalSessionId: state!.activeSessionId, activeConversationUsesCollaboration: false },
      project: { activeProjectSessionId: 'project-session' }, runtime: { desktopChatState: state },
      draft: { composerSelections: selections, setComposerSelections: setSelections, setComposerDrafts: noChange,
        setOpenComposerSelector: noChange, chatComposerAttachments: [], setChatComposerAttachments: noChange,
        chatModelOptions: models, preferredModelValueForProvider: () => models[0].value, resolveComposerProviderId: () => 'openai' },
      authNavigation: { handleSelectAuthChoice: noAction, refreshDesktopChat: noAction },
      messageRuntime: { setDesktopChatState: setState, setDesktopChatError: (error) => assert.equal(error, null), shouldAutoFollowChatRef: follow,
        publishCloudAgentRuntimeRouteChange: hosted ? (input) => new Promise<void>((resolve, reject) => routeRequests.push({ input, resolve, reject })) : undefined,
        resolveChatRuntimeRoute: () => hosted ? { model: 'openai/first', thinking: 'high', authProvider: 'openai', authChoice: 'cloud-login:synthetic' } : null,
      },
    });
    return createElement('div', null, state!.activeSession.messages.map((message, index) => createElement('p', { key: index }, message.text)));
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    let first!: Promise<void>;
    await act(async () => { first = actions.selectComposerValue('chat', 'model', 'openai/second'); });
    await waitForRequests(requests, 1);
    assert.equal(follow.current, false, 'Changing settings must preserve the user reading older messages');
    await act(async () => setState((current) => ({ ...current!, activeSession: { ...current!.activeSession,
      messageCount: 3, messages: [...current!.activeSession.messages, { role: 'user', text: 'Just sent', timestampMs: 3, timeLabel: '10:01' }],
    } })));
    await act(async () => { requests[0].resolve(desktopState('project-session', 'second')); await first; });
    assert.deepEqual(state!.activeSession.messages.map((message) => message.role), ['assistant', 'system', 'user']);
    assert.equal(document.querySelectorAll('p').length, 3);
    assert.equal(state!.activeSession.messages.at(-1)!.text, 'Just sent');

    let older!: Promise<void>;
    let newer!: Promise<void>;
    await act(async () => { older = actions.selectComposerValue('chat', 'model', 'openai/first'); });
    await waitForRequests(requests, 2);
    await act(async () => { newer = actions.selectComposerValue('chat', 'model', 'openai/third'); });
    await waitForRequests(requests, 3);
    assert.deepEqual(requests.map((request) => request.model), ['openai/second', 'openai/first', 'openai/third']);
    await act(async () => { requests[2].resolve(desktopState('project-session', 'third')); await newer; });
    await act(async () => { requests[1].resolve(desktopState('project-session', 'first')); await older; });
    assert.equal(state!.activeSession.model, 'third', 'An older response must not roll back a newer model');
    assert.equal(state!.activeSession.messages.filter((message) => message.role === 'system').length, 2);

    let switching!: Promise<void>;
    await act(async () => { switching = actions.selectComposerValue('chat', 'model', 'openai/second'); });
    await waitForRequests(requests, 4);
    await act(async () => setState(desktopState('different-session')));
    await act(async () => { requests[3].resolve(desktopState('project-session', 'second')); await switching; });
    assert.equal(state!.activeSessionId, 'different-session', 'Config completion must not return to a session the user left');
    assert.equal(follow.current, false);

    hosted = true;
    await act(async () => setState((current) => ({ ...current! })));
    let olderRoute!: Promise<void>;
    let newerRoute!: Promise<void>;
    await act(async () => { olderRoute = actions.selectComposerValue('chat', 'thinking', 'low', 'project-session'); });
    await act(async () => { newerRoute = actions.selectComposerValue('chat', 'thinking', 'high', 'project-session'); });
    await waitForRequests(routeRequests, 2);
    assert.equal(routeRequests[0].input.sessionId, 'project-session', 'A hosted route must honor the composer target override');
    await act(async () => { routeRequests[1].resolve(); await newerRoute; });
    await act(async () => { routeRequests[0].reject(new Error('Older update failed')); await olderRoute; });
    assert.equal(selections.chat.thinking, 'high', 'An older route failure must not roll back a newer choice');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('panel account, model, and thinking changes keep their route without modifying the main composer', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  const routes = new Map<string, DesktopChatMessageRoute>();
  const authenticated: string[] = [];
  const nativeRequests: string[] = [];
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { sessionId: string; model: string }) => {
    assert.equal(command, 'desktop_chat_update_session_config');
    assert.equal(args.sessionId, 'panel-session');
    nativeRequests.push(command);
    return desktopState('panel-session', args.model.split('/').at(-1));
  } } });
  publishHostedProviderSnapshots([{ snapshotId: 'synthetic', provider: 'openai-codex', authChoice: 'cloud-login:panel',
    label: 'Panel account', modelHint: 'panel-model', createdAt: '2026-01-01T00:00:00Z', revokedAt: null }]);
  setLocalAccountChoices(['profile:local']);
  setLocalProviderIds(['openai-codex']);
  let actions!: ReturnType<typeof useComposerInputActions>;
  let main!: ComposerSelectionState;
  let panel!: ComposerSelection;
  let setPanel!: React.Dispatch<React.SetStateAction<ComposerSelection>>;
  let state!: DesktopChatState | null;
  const noChange = () => {};
  function Harness() {
    const [currentMain, setMain] = useState<ComposerSelectionState>({ chat: { mode: 'agent', model: 'openai/first', thinking: 'high' },
      project: { mode: 'agent', model: 'openai/first', thinking: 'high' } });
    const [currentPanel, updatePanel] = useState<ComposerSelection>({ mode: 'agent', model: 'openai/first', thinking: 'off' });
    const [currentState, setState] = useState<DesktopChatState | null>(desktopState('main-session'));
    main = currentMain; panel = currentPanel; setPanel = updatePanel; state = currentState;
    actions = useComposerInputActions({
      environment: { isNativeShell: true },
      conversation: { activeConvId: 'main-session', activeConvCanonicalSessionId: 'main-session', activeConversationUsesCollaboration: false },
      project: { activeProjectSessionId: 'project-session' }, runtime: { desktopChatState: state },
      draft: { composerSelections: main, setComposerSelections: setMain, setComposerDrafts: noChange,
        setOpenComposerSelector: noChange, chatComposerAttachments: [], setChatComposerAttachments: noChange,
        chatModelOptions: [...models, { value: 'openai-codex/panel-model', label: 'panel-model', provider: 'openai', providerLabel: 'ChatGPT', thinkingLevels: ['off', 'low', 'high'] }],
        preferredModelValueForProvider: () => 'openai-codex/panel-model', resolveComposerProviderId: () => 'openai' },
      authNavigation: { handleSelectAuthChoice: async (_provider, choice) => { authenticated.push(choice); }, refreshDesktopChat: async () => {} },
      messageRuntime: { setDesktopChatState: setState, setDesktopChatError: error => assert.equal(error, null),
        publishCloudAgentRuntimeRouteChange: async input => { routes.set(input.sessionId, input); },
        resolveChatRuntimeRoute: id => routes.get(id!) ?? null },
    });
    return null;
  }
  const target = () => ({ sessionId: 'panel-session', selection: panel, onSelectionChange: setPanel });
  try {
    await act(async () => root.render(createElement(Harness)));
    const originalMain = main;
    const originalState = state;
    await act(async () => { await actions.selectComposerProviderChoice('chat', {
      value: 'openai-codex::cloud-login:panel', providerId: 'openai-codex', label: 'Panel account',
    }, target()); });
    assert.deepEqual(routes.get('panel-session'), { sessionId: 'panel-session', model: 'openai-codex/panel-model',
      authProvider: 'openai-codex', authChoice: 'cloud-login:panel', thinking: 'off' });
    assert.deepEqual(authenticated, [], 'Hosted credentials stay on the server');
    assert.deepEqual(nativeRequests, [], 'A hosted selection does not update an unauthenticated native model');
    assert.equal(panel.model, 'openai-codex/panel-model');
    await act(async () => { await actions.selectComposerValue('chat', 'thinking', 'low', target()); });
    assert.equal(routes.get('panel-session')?.authChoice, 'cloud-login:panel');
    assert.equal(routes.get('panel-session')?.thinking, 'low');
    await act(async () => { await actions.selectComposerAuthChoice('chat', 'openai-codex', 'profile:local', target()); });
    assert.deepEqual(authenticated, [], 'The panel route selects a saved local account without changing the device active account');
    assert.equal(routes.get('panel-session')?.authChoice, 'profile:local');
    await act(async () => { await actions.selectComposerValue('chat', 'model', 'openai/second', target()); });
    assert.equal(routes.get('panel-session')?.model, 'openai/second');
    assert.equal(routes.get('panel-session')?.authChoice, 'profile:local', 'Later choices keep the panel account');
    assert.equal(main, originalMain);
    assert.equal(state, originalState);
    assert.equal(routes.has('main-session'), false);
  } finally {
    publishHostedProviderSnapshots([]); setLocalAccountChoices(null); setLocalProviderIds([]);
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
