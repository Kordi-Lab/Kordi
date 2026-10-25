import assert from 'node:assert/strict';
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
  assert.equal(routeAccountFallbackDecision(base)?.value, work.value);
  assert.equal(routeAccountFallbackDecision({ ...base, selection: { ...removed, thinking: undefined } })?.value, work.value);
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
  assert.equal(routeAccountFallbackDecision({ ...base, providerOptions: [claude] })?.value, claude.value, 'the only usable account');
  const other: ComposerProviderOption = { value: 'google::profile:g', providerId: 'google', label: 'Gemini' };
  assert.equal(routeAccountFallbackDecision({ ...base, providerOptions: [claude, other] }), null, 'two other providers');
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
  const calls: Array<{ scope: string; value: string }> = [];
  let rerender!: (tick: number) => void;
  let setEnabled!: (enabled: boolean) => void;
  function Harness() {
    const [, setTick] = useState(0);
    const [enabled, setEnabledState] = useState(true);
    rerender = setTick;
    setEnabled = setEnabledState;
    useRouteAccountFallback({
      ...base, sessionId: 'session-1', enabled,
      applyProviderChoice: (scope, option) => { calls.push({ scope, value: option.value }); },
    });
    return null;
  }
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { rerender(1); });
    await act(async () => { rerender(2); });
    assert.deepEqual(calls, [{ scope: 'chat', value: work.value }]);
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
