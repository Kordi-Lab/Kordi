import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  routeAccountFallbackDecision,
  routeAccountFallbackKey,
  shouldApplyRouteAccountFallback,
  useRouteAccountFallback,
  type RouteAccountFallbackInput,
} from '../src/features/chat/useRouteAccountFallback';
import type { ComposerModelOption, ComposerProviderOption } from '../src/kordi-app/components/composerModelSelection';

const work: ComposerProviderOption = { value: 'openai-codex::cloud-login:work', providerId: 'openai-codex', label: 'Work', hosted: true };
const claude: ComposerProviderOption = { value: 'anthropic::profile:claude', providerId: 'anthropic', label: 'Claude' };
const modelOptions: ComposerModelOption[] = [
  { value: 'openai-codex/gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai-codex', thinkingLevels: ['low', 'medium', 'high'] },
  { value: 'anthropic/claude-fable-5', label: 'Fable 5', provider: 'anthropic', thinkingLevels: ['low', 'high'] },
];
const removed = { model: 'openai-codex/gpt-6-sol', thinking: 'medium', authProvider: 'openai-codex', authChoice: 'cloud-login:removed' };
const base: RouteAccountFallbackInput = {
  paneKind: 'agent', canConfigureModelRoute: true, accountListsLoaded: true,
  selection: removed, providerOptions: [work, claude], modelOptions,
};

test('the fallback picks a usable account of the same provider for a missing account', () => {
  assert.deepEqual(routeAccountFallbackDecision(base), { providerOption: work, model: 'openai-codex/gpt-6-sol', thinking: 'medium' });
  assert.equal(routeAccountFallbackDecision({ ...base, selection: { ...removed, thinking: undefined } })?.providerOption?.value, work.value);
});

test('the fallback onto a ChatGPT sign-in runs a model in its namespace', () => {
  const openAiModels: ComposerModelOption[] = [
    { value: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', thinkingLevels: ['low', 'medium', 'high'] },
    { value: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai-codex', thinkingLevels: ['low', 'medium', 'high'] },
  ];
  const removedKey = { model: 'openai/gpt-6.1-sol', thinking: 'high', authProvider: 'openai', authChoice: 'profile:removed-key' };
  assert.deepEqual(
    routeAccountFallbackDecision({ ...base, selection: removedKey, modelOptions: openAiModels }),
    { providerOption: work, model: 'openai-codex/gpt-6.1-sol', thinking: 'high' },
  );
});

test('the fallback leaves the route alone unless the send gate would block', () => {
  assert.equal(routeAccountFallbackDecision({ ...base, selection: { ...removed, authChoice: 'cloud-login:work' } }), null, 'account present');
  assert.equal(routeAccountFallbackDecision({ ...base, accountListsLoaded: false }), null, 'lists loading');
  assert.equal(routeAccountFallbackDecision({ ...base, paneKind: 'human' }), null, 'people chat');
  assert.equal(routeAccountFallbackDecision({ ...base, paneKind: null }), null, 'no pane kind');
  assert.equal(routeAccountFallbackDecision({ ...base, canConfigureModelRoute: false }), null, 'route not configurable');
});

test('the fallback waits for the owner when no usable account is clear', () => {
  assert.equal(routeAccountFallbackDecision({ ...base, providerOptions: [] }), null, 'no account');
  assert.equal(routeAccountFallbackDecision({ ...base, providerOptions: [{ ...work, disabled: true }] }), null, 'needs reconnecting');
  assert.equal(routeAccountFallbackDecision({ ...base, providerOptions: [claude] })?.providerOption?.value, claude.value, 'the only usable account');
  const other: ComposerProviderOption = { value: 'google::profile:g', providerId: 'google', label: 'Gemini' };
  assert.equal(routeAccountFallbackDecision({ ...base, providerOptions: [claude, other] }), null, 'two other providers');
});

test('the main composer runs the fallback on the session route and saves it as a route menu pick', () => {
  // Only the session route names an account; the plain composer selection has none, so it never loses one.
  assert.equal(routeAccountFallbackDecision({ ...base, selection: { model: removed.model, thinking: 'medium' } }), null);
  const source = readFileSync(new URL('../src/pages/chatsPage.mainComposer.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('useComposerRouteAccountGuard({');
  const guard = source.slice(start, source.indexOf('});', start));
  assert.match(guard, /enabled: Boolean\(collaborationRouting\.enabled && collaborationRouting\.model\) && !display\.activeLiveTurnIsRunning/);
  assert.match(guard, /applyRoute: collaborationRouting\.onSaveCompact/);
});

test('each fallback key applies once', () => {
  const applied = new Set<string>();
  const key = routeAccountFallbackKey('session-1', removed);
  assert.equal(key, 'session-1|openai-codex|cloud-login:removed');
  assert.equal(shouldApplyRouteAccountFallback(key, applied), true);
  assert.equal(shouldApplyRouteAccountFallback(key, applied), false);
});

test('the hook applies the replacement once per session and account', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const calls: string[] = [];
  let rerender!: (tick: number) => void;
  let setEnabled!: (enabled: boolean) => void;
  function Harness() {
    const [, setTick] = useState(0);
    const [enabled, setEnabledState] = useState(false);
    rerender = setTick;
    setEnabled = setEnabledState;
    useRouteAccountFallback({
      ...base, sessionId: 'session-1', enabled,
      applyRoute: (route) => { calls.push(`${route.providerOption?.value}|${route.model}`); },
    });
    return null;
  }
  try {
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(calls.length, 0, 'nothing applies while disabled, for example during a running turn');
    await act(async () => { setEnabled(true); });
    await act(async () => { rerender(1); });
    await act(async () => { rerender(2); });
    assert.deepEqual(calls, [`${work.value}|openai-codex/gpt-6-sol`]);
    await act(async () => { setEnabled(false); });
    await act(async () => { setEnabled(true); });
    assert.equal(calls.length, 1, 'a key already applied is not applied again');
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
