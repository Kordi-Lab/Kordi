import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { freshPendingRuntimeRoute, keepPendingRuntimeRoutes, type PendingRuntimeRoutes } from '../src/app/useCloudAgentRuntimeRouteSync';
import { setActiveChatRoute } from '../src/features/chat/kordiCloudChatRoute';
import { setLocalAccountChoices } from '../src/features/cloud/hostedAccountRegistry';
import { publishHostedProviderSnapshots } from '../src/features/cloud/hostedAccounts';
import { ComposerModelControls } from '../src/kordi-app/components';
import {
  resolveComposerModelSelection,
  resolveComposerRoutePick,
  type ComposerModelOption,
  type ComposerProviderOption,
} from '../src/kordi-app/components/composerModelSelection';
import {
  CollaborationRoutingControls,
  type CollaborationRoutingPatch,
} from '../src/pages/chatsPage.collaborationRoutingControls';
import { useChatCollaborationRouting } from '../src/pages/useChatCollaborationRouting';
import type { LocalCollaborationAgentRoutingOption } from '../src/features/collaboration/agentModelRouting';
import type { DesktopCollaborationHost } from '../src/kordi-app/types';

// This Mac's ChatGPT models keep their catalog provider id, `openai-codex`.
const modelOptions: ComposerModelOption[] = [
  { value: 'openai-codex/gpt-6-sol', label: 'gpt-6-sol', provider: 'openai-codex', thinkingLevels: ['low', 'medium', 'high'] },
  { value: 'openai-codex/gpt-5.6-sol', label: 'gpt-5.6-sol', provider: 'openai-codex', thinkingLevels: ['low', 'medium', 'high'] },
  { value: 'anthropic/claude-fable-5', label: 'claude-fable-5', provider: 'anthropic', thinkingLevels: ['high', 'max'] },
];
const providerOptions: ComposerProviderOption[] = [
  { value: 'openai-codex::work', providerId: 'openai-codex', label: 'ChatGPT', detail: 'Work', selectionLabel: 'ChatGPT • Work', active: true },
  { value: 'anthropic::research', providerId: 'anthropic', label: 'Claude', detail: 'Research', selectionLabel: 'Claude • Research' },
];

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    PointerEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  };
}

function buttonNamed(name: string) {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) => (
    candidate.textContent?.replace(/Selected$/, '').trim().startsWith(name)
  ));
  assert.ok(button, `missing button ${name}`);
  return button;
}

test('a ChatGPT model on this Mac keeps its account, model, and thinking controls filled', () => {
  const resolved = resolveComposerModelSelection({
    selection: { model: 'openai-codex/gpt-6-sol' },
    providerOptions,
    modelOptions,
  });
  assert.equal(resolved.selectedProviderValue, 'openai');
  assert.equal(resolved.selectedProviderOption?.value, 'openai-codex::work');

  const markup = renderToStaticMarkup(createElement(ComposerModelControls, {
    scope: 'chat',
    selection: { mode: 'agent', model: 'openai-codex/gpt-6-sol', thinking: 'medium' },
    openSelector: null,
    onToggleSelector: () => undefined,
    onSelectValue: () => undefined,
    authLabel: 'ChatGPT',
    authOptions: [],
    onSelectAuthChoice: () => undefined,
    onSelectProviderChoice: () => undefined,
    providerOptions,
    modelOptions,
  }));
  assert.doesNotMatch(markup, />ChatGPT • Work</);
  assert.match(markup, />GPT-6 Sol</);
  assert.match(markup, />Medium</);
  assert.doesNotMatch(markup, />-<\/span>/);
  assert.doesNotMatch(markup, /disabled=""/);
});

test('a pick that leaves the route invalid falls back to a usable account, model, and thinking level', () => {
  // The route's account was removed; a model pick moves to the signed-in account of the same provider.
  const removedAccount = { mode: 'agent', model: 'openai-codex/gpt-6-sol', thinking: 'max', authProvider: 'openai-codex', authChoice: 'cloud-login:removed' };
  const modelPick = resolveComposerRoutePick({
    selection: removedAccount, providerOptions, modelOptions, pick: { type: 'model', value: 'openai-codex/gpt-5.6-sol' },
  });
  assert.equal(modelPick?.providerOption?.value, 'openai-codex::work');
  assert.equal(modelPick?.model, 'openai-codex/gpt-5.6-sol');
  assert.equal(modelPick?.thinking, 'high');

  // An account that does not offer the current model opens on its own model.
  const accountPick = resolveComposerRoutePick({
    selection: { model: 'openai-codex/gpt-6-sol', thinking: 'low' }, providerOptions, modelOptions,
    pick: { type: 'provider', option: providerOptions[1] },
  });
  assert.equal(accountPick?.model, 'anthropic/claude-fable-5');
  assert.equal(accountPick?.thinking, 'high');

  // Nothing signed in for the provider: the pick cannot run.
  assert.equal(resolveComposerRoutePick({
    selection: removedAccount, providerOptions: [], modelOptions, pick: { type: 'thinking', value: 'low' },
  }), null);
});

test('agent route picks save a complete route instead of keeping a removed account', async () => {
  const restore = installDom();
  const root = createRoot(document.getElementById('root')!);
  const updates: CollaborationRoutingPatch[] = [];
  const agent: LocalCollaborationAgentRoutingOption = {
    id: 'agent', label: 'My Kordi', runtime: 'local', isDefault: true, isActive: true, registered: true,
    defaultModel: 'openai-codex/gpt-6-sol', defaultAuthProvider: 'openai-codex', defaultAuthChoice: 'cloud-login:removed',
    thinking: 'medium', hostId: 'cloud', hostLabel: 'Kordi',
  };
  function Harness() {
    const [openSelector, setOpenSelector] = useState<{ scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null>(null);
    return createElement(CollaborationRoutingControls, {
      model: {
        agents: [agent], selectedAgent: agent,
        selection: { mode: 'My agent', model: agent.defaultModel ?? '', thinking: 'medium', authProvider: agent.defaultAuthProvider, authChoice: agent.defaultAuthChoice, fallbackModel: null },
        visibility: { showAgentSelector: false } as never,
      },
      menu: { openSelector, agentSelectorOpen: false, compact: false },
      options: { authLabel: 'ChatGPT', authOptions: [], providerOptions, modelOptions },
      actions: {
        toggleSelector: (_scope, type) => setOpenSelector((current) => current?.type === type ? null : { scope: 'chat', type }),
        onSelectAgent: () => undefined,
        onUpdate: (patch) => { updates.push(patch); },
        defaultThinkingForModel: (_model, thinking) => thinking ?? 'medium',
      },
    });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label^="Select model,"]')!;
    await act(async () => trigger.click());
    await act(async () => buttonNamed('GPT-5.6 Sol').click());
    assert.equal(updates.length, 0, 'A removed account requires an explicit replacement');
    await act(async () => buttonNamed('ChatGPT • Work').click());
    assert.equal(updates.length, 0, 'Shared account changes require confirmation');
    await act(async () => buttonNamed('Change account').click());
    assert.equal(updates.length, 1);
    assert.equal(updates[0].defaultModel, 'openai-codex/gpt-5.6-sol');
    assert.equal(updates[0].defaultAuthChoice, 'work', 'A model pick replaces the removed account with the signed-in one');
    assert.equal(updates[0].thinking, 'medium');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('an agent model pick shows at once while its save is pending and rolls back with a notice if it fails', async () => {
  const restore = installDom();
  const root = createRoot(document.getElementById('root')!);
  const saves: Array<{ model: string | null | undefined; resolve: () => void; reject: (error: Error) => void }> = [];
  const host = {
    id: 'cloud', displayName: 'Kordi', ownerName: 'Me', serverUrl: '', activeAgentId: 'agent',
    agents: [{ id: 'agent', label: 'My Kordi', runtime: 'local', isDefault: true, isActive: true, registered: true,
      defaultModel: 'openai-codex/gpt-6-sol', defaultAuthProvider: 'openai-codex', defaultAuthChoice: 'work', thinking: 'medium' }],
  } as unknown as DesktopCollaborationHost;
  let routing!: ReturnType<typeof useChatCollaborationRouting>;
  function Harness() {
    // The session route changes only once the save reaches the session.
    const [composerSelection] = useState({ model: 'openai-codex/gpt-6-sol', thinking: 'medium' });
    routing = useChatCollaborationRouting({
      shared: {
        desktopChatState: null, modelOptions, providerOptions,
        updateRouting: (_host, _agent, model) => new Promise<void>((resolve, reject) => { saves.push({ model, resolve, reject }); }),
      },
      main: {
        conversation: { id: 'session:self-agent:me', canonicalSessionId: 'session:self-agent:me' } as never,
        host, enabled: true, isBusy: false, openSelector: null, toggleSelector: () => undefined,
        composerSelection, selectComposerProviderChoice: () => undefined, selectComposerValue: () => undefined,
      },
      companion: { conversation: null, host: null, enabled: false, isBusy: false, openSelector: null, setOpenSelector: () => undefined },
    });
    return null;
  }
  try {
    setActiveChatRoute({ model: 'openai-codex/gpt-6-sol', authProvider: 'openai-codex', authChoice: 'work', thinking: 'medium' });
    await act(async () => root.render(createElement(Harness)));
    assert.equal(routing.main.selection.model, 'openai-codex/gpt-6-sol');

    await act(async () => { routing.main.update({ defaultModel: 'openai-codex/gpt-5.6-sol', thinking: 'high', selectorType: 'model' }); });
    assert.equal(saves.length, 1);
    assert.equal(routing.main.selection.model, 'openai-codex/gpt-5.6-sol', 'The pick shows before the save settles');
    assert.equal(routing.main.selection.thinking, 'high');
    assert.equal(routing.main.error, null);

    await act(async () => { saves[0].reject(new Error('Unable to reach Kordi Cloud')); });
    assert.equal(routing.main.selection.model, 'openai-codex/gpt-6-sol', 'A failed save rolls the pick back');
    assert.equal(routing.main.error, 'Unable to reach Kordi Cloud');

    await act(async () => { routing.main.update({ defaultModel: 'openai-codex/gpt-5.6-sol', thinking: 'high', selectorType: 'model' }); });
    assert.equal(routing.main.error, null, 'A new pick clears the notice');
  } finally {
    setActiveChatRoute(null);
    await act(async () => root.unmount());
    restore();
  }
});

test('a published route outlasts history replays until history records it', () => {
  const previous = { model: 'openai-codex/gpt-6-sol', authProvider: 'openai-codex', authChoice: 'work', thinking: 'medium' };
  const picked = { ...previous, model: 'openai-codex/gpt-5.6-sol' };
  const pending: PendingRuntimeRoutes = new Map([['runtime:session', { route: picked, atMs: 1_000 }]]);

  // A send right after the pick runs with it, before state catches up.
  assert.equal(freshPendingRuntimeRoute(pending, 'runtime:session', 2_000), picked);
  assert.equal(freshPendingRuntimeRoute(pending, 'runtime:other', 2_000), null);
  assert.equal(freshPendingRuntimeRoute(pending, 'runtime:session', 1_000 + 60_000), null);

  // History still names the previous route, so the replay would undo the pick.
  const kept = keepPendingRuntimeRoutes({ 'runtime:session': previous }, { 'runtime:session': previous }, pending, 2_000);
  assert.equal(kept['runtime:session'].model, picked.model);
  assert.equal(pending.size, 1);

  // Once history records the pick, history leads again.
  const caughtUp = { 'runtime:session': picked };
  assert.equal(keepPendingRuntimeRoutes(caughtUp, caughtUp, pending, 3_000), caughtUp);
  assert.equal(pending.size, 0);

  // A pick history never records stops overriding it.
  pending.set('runtime:session', { route: picked, atMs: 1_000 });
  const stale = { 'runtime:session': previous };
  assert.equal(keepPendingRuntimeRoutes(stale, stale, pending, 1_000 + 60_000), stale);
  assert.equal(pending.size, 0);
});

async function renderMainRouting({
  storedChoice,
  options,
  listsLoaded,
  save = () => Promise.resolve(),
}: {
  storedChoice: string;
  options: ComposerProviderOption[];
  listsLoaded: boolean;
  save?: () => Promise<void>;
}) {
  const restore = installDom();
  const root = createRoot(document.getElementById('root')!);
  const saves: Array<{ model?: string | null; thinking?: string | null; authProvider?: string | null; authChoice?: string | null }> = [];
  const route = { model: 'openai-codex/gpt-6-sol', authProvider: 'openai-codex', authChoice: storedChoice, thinking: 'max' };
  const host = {
    id: 'cloud', displayName: 'Kordi', ownerName: 'Me', serverUrl: '', activeAgentId: 'agent',
    agents: [{ id: 'agent', label: 'My Kordi', runtime: 'local', isDefault: true, isActive: true, registered: true,
      defaultModel: route.model, defaultAuthProvider: route.authProvider, defaultAuthChoice: storedChoice, thinking: route.thinking }],
  } as unknown as DesktopCollaborationHost;
  let routing!: ReturnType<typeof useChatCollaborationRouting>;
  let rerender!: () => void;
  function Harness() {
    const [, setTick] = useState(0);
    rerender = () => setTick((tick) => tick + 1);
    routing = useChatCollaborationRouting({
      shared: {
        desktopChatState: null, modelOptions, providerOptions: options,
        updateRouting: (_host, _agent, model, _fallback, thinking, authProvider, authChoice) => {
          saves.push({ model, thinking, authProvider, authChoice });
          return save();
        },
      },
      main: {
        conversation: { id: 'session:self-agent:me', canonicalSessionId: 'session:self-agent:me' } as never,
        host, enabled: true, isBusy: false, openSelector: null, toggleSelector: () => undefined,
        composerSelection: { model: route.model, thinking: route.thinking }, selectComposerProviderChoice: () => undefined, selectComposerValue: () => undefined,
      },
      companion: { conversation: null, host: null, enabled: false, isBusy: false, openSelector: null, setOpenSelector: () => undefined },
    });
    return null;
  }
  setActiveChatRoute(route);
  if (listsLoaded) {
    setLocalAccountChoices(['profile:local']);
    publishHostedProviderSnapshots([]);
  } else {
    setLocalAccountChoices(null);
  }
  await act(async () => root.render(createElement(Harness)));
  return {
    saves,
    routing: () => routing,
    rerender: () => act(async () => rerender()),
    async cleanup() {
      setActiveChatRoute(null);
      setLocalAccountChoices(null);
      await act(async () => root.unmount());
      restore();
    },
  };
}

const workAccount: ComposerProviderOption = { value: 'openai-codex::cloud-login:work', providerId: 'openai-codex', label: 'Work', selectionLabel: 'ChatGPT • Work', hosted: true };
const researchAccount: ComposerProviderOption = { value: 'anthropic::cloud-login:research', providerId: 'anthropic', label: 'Research', hosted: true };

test('loaded accounts never replace an unavailable route without a pick', async () => {
  const harness = await renderMainRouting({ storedChoice: 'cloud-login:removed', options: [workAccount, researchAccount], listsLoaded: true });
  try {
    await harness.rerender();
    assert.equal(harness.saves.length, 0);
    assert.equal(harness.routing().main.selection.authChoice, 'cloud-login:removed');
  } finally { await harness.cleanup(); }
});

test('the only usable account of another provider is never selected automatically', async () => {
  const harness = await renderMainRouting({ storedChoice: 'cloud-login:removed', options: [researchAccount], listsLoaded: true });
  try {
    assert.equal(harness.saves.length, 0);
    assert.equal(harness.routing().main.selection.authChoice, 'cloud-login:removed');
  } finally { await harness.cleanup(); }
});

test('an explicit replacement rolls back on failure and is not retried in a loop', async () => {
  const harness = await renderMainRouting({ storedChoice: 'cloud-login:removed', options: [workAccount], listsLoaded: true,
    save: () => Promise.reject(new Error('Unable to reach Kordi Cloud')) });
  try {
    assert.equal(harness.saves.length, 0);
    await act(async () => {
      const saved = await harness.routing().main.saveCompactRoute({ providerOption: workAccount, model: 'openai-codex/gpt-6-sol', thinking: 'high' });
      assert.equal(saved, false);
    });
    assert.equal(harness.saves.length, 1);
    assert.equal(harness.routing().main.selection.authChoice, 'cloud-login:removed');
    assert.equal(harness.routing().main.error, 'Unable to reach Kordi Cloud');
    await harness.rerender();
    assert.equal(harness.saves.length, 1);
  } finally { await harness.cleanup(); }
});
